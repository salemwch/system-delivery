-- Network context — the physical topology (docs/02-domain-model.md §3.4,
-- docs/04-context-map.md §3.4, docs/06-database-design.md §6).
--
-- Three tenant-scoped tables, all ENABLE + FORCE Row-Level Security:
--
--   hubs       — physical facilities (sort / distribute / pickup point). Never
--                hard-deleted: status ACTIVE/INACTIVE is the lifecycle (§3.4
--                rule 3/5). location is denormalised from the address for
--                proximity queries (nearest-hub, resolveForAddress).
--   zones      — territory polygons. A hub serves the zone that contains an
--                address; each zone carries its own default geofence radius,
--                because dense medina streets need a tighter arrival radius than
--                suburbs (hotspot H6).
--   geofences  — circular arrival boundaries (centre + radius). Evaluated purely
--                and in-memory by the network module for the tracking context;
--                the row is only the persisted definition.
--
-- Deferred by layering (network is Layer 1: platform/identity/directory only):
--   • hubs.cash_account_id — the HUB_CASH LedgerAccount (§3.4 rule 1) is created
--     when the finance module (Layer 3) exists. Nullable until then.
--   • The deactivation guard (§3.4 rule 3: no in-custody shipments / open
--     manifests / non-zero cash) spans shipment/manifest/finance and attaches
--     when those modules exist. The status toggle itself ships now.

-- ─────────────────────────────────────────────────────────────────────────────
-- zones — created first: hubs.service_zone_ids and geofences.zone_id reference it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zones (
  id                        UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                 UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  code                      TEXT NOT NULL,
  name                      TEXT NOT NULL,

  -- Territory polygon. MULTIPOLYGON so a zone can be several disjoint areas
  -- (e.g. a city split by a river). Metres-correct containment on the sphere.
  boundary                  GEOGRAPHY(MULTIPOLYGON, 4326) NOT NULL,

  -- Per-zone default arrival radius in metres (hotspot H6). A geofence created
  -- for a stop in this zone inherits it unless overridden.
  default_geofence_radius_m INTEGER NOT NULL DEFAULT 150,

  active                    BOOLEAN NOT NULL DEFAULT true,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT zones_radius_chk CHECK (default_geofence_radius_m > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS zones_tenant_code_uq ON zones (tenant_id, code);
CREATE INDEX IF NOT EXISTS zones_tenant_active_idx ON zones (tenant_id, active);
-- Containment queries: which zone covers a given point.
CREATE INDEX IF NOT EXISTS zones_boundary_gist ON zones USING GIST (boundary);

-- ─────────────────────────────────────────────────────────────────────────────
-- hubs — physical facilities.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hubs (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  code              TEXT NOT NULL,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,

  address_id        UUID NOT NULL REFERENCES addresses (id),
  -- Denormalised from the address for proximity queries — never selected raw;
  -- read via ST_Y/ST_X, written via ST_MakePoint (PostGIS is opaque to Drizzle).
  location          GEOGRAPHY(POINT, 4326) NOT NULL,

  -- IANA. MANDATORY (§3.4 rule 2): cut-offs and SLA windows are local time.
  timezone          TEXT NOT NULL,

  -- Network hierarchy (spoke → regional hub). Must not form a cycle (rule 4),
  -- enforced in the application. RESTRICT: a parent cannot be removed from under
  -- its children by anything but an explicit re-parenting.
  parent_hub_id     UUID REFERENCES hubs (id) ON DELETE RESTRICT,

  -- Zones this hub delivers to. UUIDs (not a FK array — Postgres has none);
  -- referential integrity to zones is enforced in the application.
  service_zone_ids  UUID[] NOT NULL DEFAULT '{}',

  -- Per-destination linehaul departure cut-offs.
  cutoff_times      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- FK → the HUB_CASH LedgerAccount (§3.4 rule 1). Nullable until the finance
  -- module exists; no FK yet because ledger_accounts is not created.
  cash_account_id   UUID,

  status            TEXT NOT NULL DEFAULT 'ACTIVE',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT hubs_type_chk
    CHECK (type IN ('SORTING_CENTER', 'DISTRIBUTION_CENTER', 'PICKUP_POINT')),
  CONSTRAINT hubs_status_chk CHECK (status IN ('ACTIVE', 'INACTIVE')),
  -- A hub cannot be its own parent (the trivial cycle; longer cycles are checked
  -- in the application, which has to walk the chain anyway).
  CONSTRAINT hubs_parent_not_self_chk CHECK (parent_hub_id IS NULL OR parent_hub_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS hubs_tenant_code_uq ON hubs (tenant_id, code);
CREATE INDEX IF NOT EXISTS hubs_tenant_status_idx ON hubs (tenant_id, status);
CREATE INDEX IF NOT EXISTS hubs_location_gist ON hubs USING GIST (location);

-- ─────────────────────────────────────────────────────────────────────────────
-- geofences — circular arrival boundaries.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS geofences (
  id            UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  name          TEXT NOT NULL,
  -- What the geofence guards. Exactly one target is set, matching kind.
  kind          TEXT NOT NULL,
  hub_id        UUID REFERENCES hubs (id) ON DELETE CASCADE,
  address_id    UUID REFERENCES addresses (id) ON DELETE CASCADE,
  zone_id       UUID REFERENCES zones (id) ON DELETE CASCADE,

  centre        GEOGRAPHY(POINT, 4326) NOT NULL,
  radius_m      INTEGER NOT NULL,

  active        BOOLEAN NOT NULL DEFAULT true,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT geofences_kind_chk CHECK (kind IN ('HUB', 'STOP', 'ZONE', 'CUSTOM')),
  CONSTRAINT geofences_radius_chk CHECK (radius_m > 0),
  -- The target matches the kind: a HUB geofence names a hub, a STOP names an
  -- address, a ZONE names a zone, a CUSTOM names none.
  CONSTRAINT geofences_target_chk CHECK (
    (kind = 'HUB'    AND hub_id IS NOT NULL AND address_id IS NULL AND zone_id IS NULL) OR
    (kind = 'STOP'   AND address_id IS NOT NULL AND hub_id IS NULL AND zone_id IS NULL) OR
    (kind = 'ZONE'   AND zone_id IS NOT NULL AND hub_id IS NULL AND address_id IS NULL) OR
    (kind = 'CUSTOM' AND hub_id IS NULL AND address_id IS NULL AND zone_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS geofences_tenant_active_idx ON geofences (tenant_id, active);
CREATE INDEX IF NOT EXISTS geofences_centre_gist ON geofences USING GIST (centre);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security + grants. Same model as every data table: ENABLE + FORCE,
-- one tenant-scoped policy. Nothing in the network is hard-deleted through the
-- application role — hubs use status, zones/geofences use `active` — so REVOKE
-- the DELETE/TRUNCATE that dp_migrator's default privileges grant (initdb).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['zones', 'hubs', 'geofences'] LOOP
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

  EXECUTE 'REVOKE DELETE, TRUNCATE ON zones, hubs, geofences FROM dp_app';
END
$$;

COMMENT ON TABLE hubs IS
  'Physical facilities. Never hard-deleted — status ACTIVE/INACTIVE is the lifecycle. location is denormalised from the address for proximity queries.';
COMMENT ON TABLE zones IS
  'Territory polygons. A hub serves the zone containing an address; each zone carries its own default geofence radius (hotspot H6).';
COMMENT ON TABLE geofences IS
  'Circular arrival boundaries (centre + radius). Evaluated purely and in-memory by the network module for the tracking context.';
