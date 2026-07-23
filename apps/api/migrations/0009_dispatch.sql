-- Dispatch context — the planning work: which driver, which vehicle, which order
-- (docs/02-domain-model.md §3.9–3.10, docs/06-database-design.md §4.5,
-- docs/04-context-map.md §3.7). Layer 2.
--
-- Three tenant-scoped tables, all ENABLE + FORCE Row-Level Security:
--
--   routes            — one driver's planned work for one period: an ordered
--                       sequence of stops in one vehicle. Never hard-deleted —
--                       a route is CANCELLED, not removed (domain §3.9 rule 5).
--   route_stops       — one physical location visit. A single stop may serve
--                       several shipment legs (three parcels to one building is
--                       one stop). `sequence` is unique per route; the unique
--                       constraint is DEFERRABLE so re-optimisation can rewrite
--                       the whole sequence in one transaction without tripping it
--                       on an intermediate state.
--   optimization_jobs — traceability for each solver run. `used_fallback` is the
--                       monitored signal that route quality is silently degrading
--                       (event-storming §4.2). At MVP every run uses the
--                       deterministic haversine NN+2-opt fallback; the OSRM path
--                       (ADR-003) attaches behind the same OptimizationProvider
--                       port when the Maghreb extract is loaded.
--
-- Dispatch is the single sanctioned same-layer caller of `shipment`
-- (context-map §2.1): it records `shipment.assigned` / `shipment.out_for_delivery`
-- through ShipmentService, guarded by the shipment state machine — it never
-- writes shipment state itself. `route_stops.leg_ids` references shipment legs by
-- ID, never by object, so sequencing a route locks no shipment rows.

-- ─────────────────────────────────────────────────────────────────────────────
-- routes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS routes (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Human-readable, unique per tenant (R-YYYYMMDD-NNN). Appears on records.
  code                  TEXT NOT NULL,

  -- Null while DRAFT; required to PUBLISH (rule 1). ON DELETE RESTRICT: a driver
  -- or vehicle referenced by a route cannot be removed out from under it.
  driver_id             UUID REFERENCES drivers (id) ON DELETE RESTRICT,
  vehicle_id            UUID REFERENCES vehicles (id) ON DELETE RESTRICT,
  start_hub_id          UUID REFERENCES hubs (id) ON DELETE SET NULL,
  end_hub_id            UUID REFERENCES hubs (id) ON DELETE SET NULL,

  planned_date          DATE NOT NULL,
  status                TEXT NOT NULL DEFAULT 'DRAFT',

  planned_start_at      TIMESTAMPTZ,
  planned_end_at        TIMESTAMPTZ,
  actual_start_at       TIMESTAMPTZ,
  actual_end_at         TIMESTAMPTZ,

  -- Metres and seconds. Never mixed units (project convention).
  planned_distance_m    INTEGER,
  planned_duration_s    INTEGER,
  actual_distance_m     INTEGER,
  actual_duration_s     INTEGER,

  stop_count            INTEGER NOT NULL DEFAULT 0,
  -- Planned path for map rendering; set by the optimiser.
  polyline              GEOGRAPHY(LINESTRING, 4326),
  optimization_job_id   UUID,
  published_at          TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT routes_status_chk CHECK (
    status IN ('DRAFT', 'OPTIMIZING', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT routes_stop_count_chk CHECK (stop_count >= 0),
  CONSTRAINT routes_distance_chk CHECK (
    (planned_distance_m IS NULL OR planned_distance_m >= 0) AND
    (planned_duration_s IS NULL OR planned_duration_s >= 0) AND
    (actual_distance_m  IS NULL OR actual_distance_m  >= 0) AND
    (actual_duration_s  IS NULL OR actual_duration_s  >= 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS routes_tenant_code_uq ON routes (tenant_id, code);
-- I8: a driver has at most one IN_PROGRESS route at a time (domain §3.9 rule 2).
-- The partial unique index makes a second one a database error, not a race.
CREATE UNIQUE INDEX IF NOT EXISTS routes_one_in_progress_per_driver_uq
  ON routes (tenant_id, driver_id) WHERE status = 'IN_PROGRESS';
-- "Today's route for this driver" (docs/06 §index catalogue).
CREATE INDEX IF NOT EXISTS routes_driver_date_idx
  ON routes (tenant_id, driver_id, planned_date);
CREATE INDEX IF NOT EXISTS routes_tenant_status_idx ON routes (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- route_stops
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS route_stops (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  route_id              UUID NOT NULL REFERENCES routes (id) ON DELETE CASCADE,

  sequence              SMALLINT NOT NULL,
  type                  TEXT NOT NULL,

  -- Exactly one of address / hub for a physical stop; a BREAK has neither.
  address_id            UUID REFERENCES addresses (id) ON DELETE RESTRICT,
  hub_id                UUID REFERENCES hubs (id) ON DELETE RESTRICT,
  -- Denormalised for map rendering and for the sequencer's distance matrix.
  location              GEOGRAPHY(POINT, 4326),

  status                TEXT NOT NULL DEFAULT 'PENDING',
  -- Protects a stop already communicated to the driver from re-optimisation
  -- reshuffling it (domain §3.10 rule 5). Set automatically at publish.
  locked                BOOLEAN NOT NULL DEFAULT false,

  planned_arrival_at    TIMESTAMPTZ,
  planned_departure_at  TIMESTAMPTZ,
  actual_arrival_at     TIMESTAMPTZ,
  actual_departure_at   TIMESTAMPTZ,
  service_duration_s    INTEGER NOT NULL DEFAULT 0,

  -- The shipment legs served here — by ID, never by object (domain §2 aggregate
  -- rule). A stop serves at least one leg unless it is a BREAK.
  leg_ids               UUID[] NOT NULL DEFAULT '{}',
  time_window_from      TIMESTAMPTZ,
  time_window_to        TIMESTAMPTZ,
  -- Required for SKIPPED/FAILED (rule 6) — raises a dispatcher exception.
  failure_reason        TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT route_stops_type_chk CHECK (
    type IN ('PICKUP', 'DELIVERY', 'HUB_LOAD', 'HUB_UNLOAD', 'BREAK')
  ),
  CONSTRAINT route_stops_status_chk CHECK (
    status IN ('PENDING', 'ARRIVED', 'COMPLETED', 'FAILED', 'SKIPPED')
  ),
  -- A physical stop targets exactly one of address / hub; a BREAK targets neither.
  CONSTRAINT route_stops_target_chk CHECK (
    (type = 'BREAK' AND address_id IS NULL AND hub_id IS NULL) OR
    (type IN ('PICKUP', 'DELIVERY') AND address_id IS NOT NULL AND hub_id IS NULL) OR
    (type IN ('HUB_LOAD', 'HUB_UNLOAD') AND hub_id IS NOT NULL AND address_id IS NULL)
  ),
  -- A non-BREAK stop must serve at least one leg (rule 2).
  CONSTRAINT route_stops_legs_chk CHECK (type = 'BREAK' OR cardinality(leg_ids) > 0),
  CONSTRAINT route_stops_sequence_chk CHECK (sequence >= 0),
  CONSTRAINT route_stops_service_chk CHECK (service_duration_s >= 0),
  -- DEFERRABLE so re-optimisation can rewrite every stop's sequence in one
  -- transaction; uniqueness is verified at COMMIT, not per-row.
  CONSTRAINT route_stops_route_sequence_uq UNIQUE (route_id, sequence)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS route_stops_route_sequence_idx ON route_stops (route_id, sequence);
CREATE INDEX IF NOT EXISTS route_stops_tenant_status_idx ON route_stops (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- optimization_jobs
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimization_jobs (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  route_id              UUID NOT NULL REFERENCES routes (id) ON DELETE CASCADE,

  status                TEXT NOT NULL DEFAULT 'PENDING',
  -- OSRM_NN_2OPT (V2) | HAVERSINE_NN_2OPT (MVP fallback) | MANUAL (flag off).
  solver                TEXT NOT NULL,
  -- The monitored signal: true whenever the deterministic fallback ran instead
  -- of the road-network optimiser. A rising rate means silent quality loss.
  used_fallback         BOOLEAN NOT NULL DEFAULT false,

  solve_duration_ms     INTEGER,
  planned_distance_m    INTEGER,
  planned_duration_s    INTEGER,
  stop_count            INTEGER,
  constraints_violated  JSONB NOT NULL DEFAULT '[]'::jsonb,
  error                 TEXT,
  requested_by_user_id  UUID,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,

  CONSTRAINT optimization_jobs_status_chk CHECK (
    status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')
  ),
  CONSTRAINT optimization_jobs_solver_chk CHECK (
    solver IN ('OSRM_NN_2OPT', 'HAVERSINE_NN_2OPT', 'MANUAL')
  )
);

CREATE INDEX IF NOT EXISTS optimization_jobs_route_idx ON optimization_jobs (tenant_id, route_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security + grants.
--
-- routes and optimization_jobs are never hard-deleted through the app role — a
-- route is CANCELLED (rule 5), a job is an immutable audit record — so REVOKE the
-- DELETE/TRUNCATE that dp_migrator's default privileges grant to dp_app.
--
-- route_stops KEEP DELETE: removing a stop from a DRAFT route is a legitimate
-- edit (guarded in the service to DRAFT only). Only TRUNCATE is revoked.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['routes', 'route_stops', 'optimization_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      || 'USING (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid) '
      || 'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)',
      tbl || '_isolation', tbl
    );
  END LOOP;

  EXECUTE 'REVOKE DELETE, TRUNCATE ON routes, optimization_jobs FROM dp_app';
  EXECUTE 'REVOKE TRUNCATE ON route_stops FROM dp_app';
END
$$;

COMMENT ON TABLE routes IS
  'One driver''s planned work for one period. Never hard-deleted — CANCELLED, not removed (domain §3.9 rule 5). At most one IN_PROGRESS per driver (I8).';
COMMENT ON TABLE route_stops IS
  'One physical location visit; may serve several shipment legs by ID. sequence is unique per route (DEFERRABLE, for whole-route re-optimisation).';
COMMENT ON TABLE optimization_jobs IS
  'Solver-run traceability. used_fallback is monitored — a rising rate means route quality is silently degrading (event-storming §4.2).';
