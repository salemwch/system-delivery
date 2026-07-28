-- Driver GPS telemetry (docs/06-database-design.md §5, docs/01-mvp-scope.md §4.3
-- #3.5, ADR-005 "core-api plus a telemetry module").
--
-- This is the TELEMETRY PLANE. It is deliberately not shaped like the rest of
-- the schema:
--
--   * ~40 writes/sec at MVP, ~10,000/sec at Tier 3 — two to three orders of
--     magnitude above every business table in this database.
--   * Written in batches, read almost never row-by-row.
--   * Aggressively compressible: consecutive positions from one driver differ by
--     a few metres and a few seconds.
--
-- Consequently it is a TimescaleDB hypertable rather than a plain table, and the
-- live dispatcher map does NOT read it — last-known position comes from Valkey
-- (docs/06 §5.3: "confusing these two access patterns is how telemetry stores
-- get overloaded"). This table is for history, playback, and reporting.
--
-- A GPS ping is NOT a business event (docs/03-event-storming.md §2.4, "the
-- single most important rule in this document"). Nothing here touches the
-- outbox. Only a geofence transition crosses into the business plane, as
-- shipment.arrived_at_stop.

CREATE TABLE IF NOT EXISTS driver_positions (
  -- The partitioning dimension. Device clock, not server clock: this is when the
  -- driver was at this point, which is what a replay or an SLA calculation needs
  -- (docs/05 §4: "SLA is always measured on occurredAt").
  time          TIMESTAMPTZ NOT NULL,

  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  driver_id     UUID NOT NULL,
  -- Nullable: a driver may be on shift without an assigned route.
  route_id      UUID,

  -- The raw observation, exactly as the device reported it.
  lon           DOUBLE PRECISION NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,

  -- Derived, never written. A GENERATED column makes "location always matches
  -- lon/lat" a guarantee of the database rather than a discipline of whichever
  -- code path happens to insert. It also removes the single most likely bug on
  -- this path: ST_MakePoint takes (lon, lat), and transposing them puts Tunis in
  -- the Indian Ocean with nothing downstream noticing. Declared once here, it
  -- cannot be got wrong per call site.
  --
  -- Costs 16 bytes a row over storing the point alone, and buys back a far
  -- simpler write path — the ingest writer can use a plain multi-row INSERT
  -- instead of composing SQL fragments per position.
  location      GEOGRAPHY(POINT, 4326)
                GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,

  -- REAL, not DOUBLE PRECISION. Half the width, and GPS hardware does not
  -- resolve anywhere near seven significant figures of speed or heading.
  speed_mps     REAL,
  heading_deg   REAL,
  accuracy_m    REAL,

  -- Fleet-health signal and a driver-support diagnostic: "the app drains my
  -- battery" is answerable with data rather than argument.
  battery_pct   SMALLINT,

  -- Device activity recognition — lets a stationary driver be told apart from a
  -- driver whose GPS is drifting.
  is_moving     BOOLEAN,

  -- GPS / NETWORK / FUSED, stored as a small int for width. Accuracy weighting
  -- differs by source; a fused fix is not a satellite fix.
  source        SMALLINT,

  CONSTRAINT driver_positions_lon_chk CHECK (lon BETWEEN -180 AND 180),
  CONSTRAINT driver_positions_lat_chk CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT driver_positions_battery_chk
    CHECK (battery_pct IS NULL OR (battery_pct BETWEEN 0 AND 100)),
  CONSTRAINT driver_positions_heading_chk
    CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  CONSTRAINT driver_positions_speed_chk
    CHECK (speed_mps IS NULL OR speed_mps >= 0),
  CONSTRAINT driver_positions_accuracy_chk
    CHECK (accuracy_m IS NULL OR accuracy_m >= 0)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Hypertable
--
-- 1-day chunks: at Tier 3 that is ~864M rows/day, and smaller chunks keep index
-- maintenance and the compression job bounded. Hash dimension on driver_id gives
-- parallel writes and lets driver-scoped queries prune chunks.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT create_hypertable(
  'driver_positions',
  by_range('time', INTERVAL '1 day'),
  if_not_exists => TRUE
);

SELECT add_dimension(
  'driver_positions',
  by_hash('driver_id', 4),
  if_not_exists => TRUE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
--
-- MUST come before compression is enabled: TimescaleDB refuses CREATE INDEX on a
-- hypertable with columnstore turned on ("operation not supported on hypertables
-- that have columnstore enabled"). Order here is load-bearing, not cosmetic.
--
-- create_hypertable already builds (time DESC). These serve the two reads this
-- table actually gets: one driver's trail over a window, and one route's trail.
-- Both lead with tenant_id, per the governing rule in docs/06 §6.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS driver_positions_tenant_driver_time_idx
  ON driver_positions (tenant_id, driver_id, time DESC);

CREATE INDEX IF NOT EXISTS driver_positions_tenant_route_time_idx
  ON driver_positions (tenant_id, route_id, time DESC)
  WHERE route_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security — ENABLE + FORCE like every other data table.
--
-- Telemetry is location data about identifiable people. It is the most
-- privacy-sensitive table in the system, so it gets the same forced isolation as
-- everything else and no exception for volume.
--
-- MUST come before any columnstore setting: TimescaleDB rejects
-- "ALTER TABLE ... ENABLE ROW LEVEL SECURITY" once columnstore is on, and
-- symmetrically rejects columnstore on a table that already has row security.
-- The two are mutually exclusive — see the note below.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE driver_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_positions FORCE ROW LEVEL SECURITY;

CREATE POLICY driver_positions_tenant_isolation ON driver_positions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- dp_app: SELECT and INSERT only. Telemetry is APPEND-ONLY — a position is an
-- observation of where a person was at a moment, and an observation you can edit
-- is not evidence. Corrections are new rows; expiry is the retention policy,
-- never an application DELETE.
GRANT SELECT, INSERT ON driver_positions TO dp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON driver_positions FROM dp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- Retention — 90 days, then chunks are dropped.
--
-- ⚠️ DELIBERATE DEVIATION from docs/06-database-design.md §5.1, which specifies
-- columnar compression after 7 days.
--
-- TimescaleDB 2.28 cannot do both: enabling columnstore on a table with row
-- security fails with "columnstore cannot be used on table with row security",
-- and enabling RLS afterwards fails just as hard. They are mutually exclusive.
--
-- Forced RLS wins. docs/01-mvp-scope.md §4.7 lists tenant_id + RLS on every table
-- as the one foundation that "cannot be retrofitted at all", while compression is
-- a storage optimisation. Trading tenant isolation on the most privacy-sensitive
-- table in the system for disk space would be the wrong trade at any price.
--
-- Storage stays bounded by dropping whole chunks instead. At MVP write rates
-- (~40/sec) 90 days is roughly 31 GB — cheap, and it keeps a full quarter of
-- trail for COD disputes, playback, and driver-performance review.
--
-- Revisit when ADR-005's extraction trigger fires (>500 events/sec sustained):
-- at that point telemetry moves to the Go tracking-gateway and very likely to its
-- own store, where compression is available because RLS is not the isolation
-- mechanism.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT add_retention_policy('driver_positions', INTERVAL '90 days', if_not_exists => TRUE);
