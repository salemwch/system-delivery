-- Fleet context — the people and vehicles that execute work (docs/02-domain-model
-- §3.3, §3.5, §3.21, docs/04-context-map.md §3.5).
--
-- Three tenant-scoped tables, all ENABLE + FORCE Row-Level Security:
--
--   vehicles — transport assets with capacity constraints that bound a route.
--   drivers  — field couriers. PII (national_id, licence_number) is stored as
--              AES-256-GCM ciphertext produced by the application FieldCipher
--              (docs/07 §6); the database never sees the plaintext.
--   shifts   — a driver's working period. The OPEN shift is the privacy gate:
--              location is collected ONLY within one (domain §3.3 rule 4).
--
-- Deferred by layering (fleet is Layer 1: platform/identity/network):
--   • drivers.cash_account_id — the DRIVER_CASH LedgerAccount (§3.3 rule 1) is
--     created when the finance module (Layer 3) exists. Nullable until then.
--   • The "cannot deactivate while holding cash / active route stops" guard
--     (§3.3 rule 3) spans finance/dispatch and attaches when those modules exist.
--   • Driver phone authentication / device binding is an identity concern that
--     composes fleet later; the columns exist, the auth flow does not live here.

-- ─────────────────────────────────────────────────────────────────────────────
-- vehicles — created first: drivers.default_vehicle_id and shifts.vehicle_id
-- reference it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  plate_number          TEXT NOT NULL,
  type                  TEXT NOT NULL,
  make                  TEXT,
  model                 TEXT,
  year                  INTEGER,

  -- Capacity in canonical units (grams, cm³, count). A route's planned load must
  -- not exceed ANY of these — parcel count is usually the real binding constraint.
  capacity_weight_grams INTEGER NOT NULL DEFAULT 0,
  capacity_volume_cm3   INTEGER NOT NULL DEFAULT 0,
  capacity_parcels      INTEGER NOT NULL DEFAULT 0,

  features              TEXT[] NOT NULL DEFAULT '{}',
  home_hub_id           UUID REFERENCES hubs (id) ON DELETE SET NULL,

  status                TEXT NOT NULL DEFAULT 'ACTIVE',
  -- Alerting only at MVP; the full maintenance module is V3.
  insurance_expiry_at   DATE,
  inspection_expiry_at  DATE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT vehicles_type_chk CHECK (type IN ('MOTORCYCLE', 'CAR', 'VAN', 'TRUCK')),
  CONSTRAINT vehicles_status_chk CHECK (status IN ('ACTIVE', 'MAINTENANCE', 'INACTIVE')),
  CONSTRAINT vehicles_capacity_chk CHECK (
    capacity_weight_grams >= 0 AND capacity_volume_cm3 >= 0 AND capacity_parcels >= 0
  ),
  CONSTRAINT vehicles_year_chk CHECK (year IS NULL OR (year >= 1900 AND year <= 2100))
);

CREATE UNIQUE INDEX IF NOT EXISTS vehicles_tenant_plate_uq ON vehicles (tenant_id, plate_number);
CREATE INDEX IF NOT EXISTS vehicles_tenant_status_idx ON vehicles (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- drivers — field couriers. PII columns hold ciphertext, never plaintext.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drivers (
  id                       UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Set only if the driver also has web (User) access.
  user_id                  UUID REFERENCES users (id) ON DELETE SET NULL,
  employee_code            TEXT NOT NULL,
  full_name                TEXT NOT NULL,
  -- E.164. Unique per tenant; the driver's primary authentication identity.
  phone                    TEXT NOT NULL,

  -- AES-256-GCM ciphertext (v1:iv:tag:ct), encrypted by the application before it
  -- reaches the column. The database, its backups, and dumps never hold plaintext.
  national_id_encrypted    TEXT,
  licence_number_encrypted TEXT,
  licence_expiry_at        DATE,

  status                   TEXT NOT NULL DEFAULT 'PENDING',
  employment_type          TEXT NOT NULL,
  home_hub_id              UUID REFERENCES hubs (id) ON DELETE SET NULL,
  default_vehicle_id       UUID REFERENCES vehicles (id) ON DELETE SET NULL,
  skills                   TEXT[] NOT NULL DEFAULT '{}',

  -- FK → the DRIVER_CASH LedgerAccount (§3.3 rule 1). Nullable until finance exists.
  cash_account_id          UUID,

  locale                   TEXT NOT NULL DEFAULT 'fr',
  device_id                TEXT,
  app_version              TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT drivers_status_chk CHECK (status IN ('PENDING', 'ACTIVE', 'INACTIVE', 'SUSPENDED')),
  CONSTRAINT drivers_employment_chk CHECK (employment_type IN ('EMPLOYEE', 'CONTRACTOR')),
  CONSTRAINT drivers_locale_chk CHECK (locale IN ('ar', 'fr', 'en'))
);

CREATE UNIQUE INDEX IF NOT EXISTS drivers_tenant_employee_uq ON drivers (tenant_id, employee_code);
-- phone is the auth identity — unique per tenant (§3.3 rule 6).
CREATE UNIQUE INDEX IF NOT EXISTS drivers_tenant_phone_uq ON drivers (tenant_id, phone);
CREATE INDEX IF NOT EXISTS drivers_tenant_status_idx ON drivers (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- shifts — a driver's working period. The OPEN shift is the privacy gate.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shifts (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  driver_id           UUID NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  vehicle_id          UUID NOT NULL REFERENCES vehicles (id) ON DELETE RESTRICT,
  hub_id              UUID REFERENCES hubs (id) ON DELETE SET NULL,

  status              TEXT NOT NULL DEFAULT 'OPEN',
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,

  start_odometer      INTEGER,
  end_odometer        INTEGER,
  opening_cash_minor  BIGINT,
  closing_cash_minor  BIGINT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shifts_status_chk CHECK (status IN ('OPEN', 'CLOSED')),
  -- An OPEN shift has no end; a CLOSED shift has one, on/after the start.
  CONSTRAINT shifts_end_consistency_chk CHECK (
    (status = 'OPEN' AND ended_at IS NULL) OR
    (status = 'CLOSED' AND ended_at IS NOT NULL AND ended_at >= started_at)
  )
);

-- At most one OPEN shift per driver (§3.3 rule 2) and per vehicle (§3.5 rule 1) —
-- the partial unique index makes a second open shift a database error, not a race.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_driver_uq
  ON shifts (tenant_id, driver_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_vehicle_uq
  ON shifts (tenant_id, vehicle_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS shifts_driver_time_idx ON shifts (tenant_id, driver_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security + grants. Nothing in fleet is hard-deleted through the app
-- role — drivers/vehicles use status, shifts are historical records — so REVOKE
-- the DELETE/TRUNCATE that dp_migrator's default privileges grant.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['vehicles', 'drivers', 'shifts'] LOOP
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

  EXECUTE 'REVOKE DELETE, TRUNCATE ON vehicles, drivers, shifts FROM dp_app';
END
$$;

COMMENT ON TABLE vehicles IS
  'Transport assets with capacity constraints. Never hard-deleted — status is the lifecycle.';
COMMENT ON TABLE drivers IS
  'Field couriers. national_id / licence_number are AES-256-GCM ciphertext; the database never holds plaintext (docs/07 §6). Never hard-deleted.';
COMMENT ON TABLE shifts IS
  'A driver working period. At most one OPEN per driver and per vehicle. The OPEN shift is the privacy gate for location collection (domain §3.3 rule 4).';
