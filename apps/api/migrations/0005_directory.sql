-- Directory context (docs/04-context-map.md §3.3, docs/02-domain-model.md §3.19,
-- docs/06-database-design.md §4.4).
--
-- Commercial counterparties and physical addressing. Three tenant-scoped tables,
-- each ENABLE + FORCE Row-Level Security like every other data table:
--
--   merchants   — businesses that ship THROUGH the tenant (never "customer";
--                 Tenant / Merchant / Recipient are three distinct concepts, I18)
--   recipients  — the reusable address book of parcel receivers; the natural key
--                 is (tenant_id, phone) because in MENA the phone is the identity
--   addresses   — the address-quality pipeline; geocode confidence gates
--                 auto-dispatch, and driver corrections are a compounding asset
--
-- Deliberately NO recipient_id on addresses: an address is a tenant-scoped
-- standalone entity (06 §4.4), and a recipient references its most-recent one via
-- default_address_id. Addresses accumulate history independently of who used them.

-- ─────────────────────────────────────────────────────────────────────────────
-- addresses — created first: recipients.default_address_id references it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS addresses (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Exactly what the merchant sent — never overwritten, so normalisation can be
  -- re-run and disputes can be audited against the original input.
  raw_input         TEXT NOT NULL,

  -- Output of the normalisation pipeline. All nullable: a raw input may not yield
  -- every component.
  normalised_line1  TEXT,
  normalised_line2  TEXT,
  city              TEXT,
  region            TEXT,
  postal_code       TEXT,
  country_code      TEXT,

  -- GEOGRAPHY(Point,4326): metres-correct distance on the sphere, which is what
  -- nearest-driver and geofence queries need. NULL until geocoded.
  location          GEOGRAPHY(POINT, 4326),

  -- 0.000–1.000. Low confidence BLOCKS auto-dispatch and flags for dispatcher
  -- review (Blueprint risk D2). A NULL location implies 0 confidence.
  geocode_confidence NUMERIC(4, 3),
  geocode_source     TEXT NOT NULL DEFAULT 'none',

  -- IANA timezone — required to evaluate delivery windows against local time.
  timezone          TEXT,

  -- Gate codes, floor, landmark. Enormous real-world value for a Tunisian
  -- delivery; cached in the driver's offline manifest.
  access_notes      TEXT,

  -- Set when a successful delivery confirms the geocode was correct.
  verified_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT addresses_confidence_chk
    CHECK (geocode_confidence IS NULL OR (geocode_confidence >= 0 AND geocode_confidence <= 1)),
  CONSTRAINT addresses_source_chk
    CHECK (geocode_source IN ('none', 'mapbox', 'google', 'manual', 'driver_corrected'))
);

-- Spatial index for nearest-driver / geofence / zone containment (06 §6).
CREATE INDEX IF NOT EXISTS addresses_location_gist ON addresses USING GIST (location);
CREATE INDEX IF NOT EXISTS addresses_tenant_postal_idx
  ON addresses (tenant_id, country_code, postal_code);
CREATE INDEX IF NOT EXISTS addresses_tenant_idx ON addresses (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- merchants — the businesses shipping through the tenant.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merchants (
  id                 UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  name               TEXT NOT NULL,
  -- Tenant-facing reference (a short code the courier uses on manifests). Unique
  -- within the tenant when present.
  code               TEXT,

  contact_name       TEXT,
  contact_phone      TEXT,
  contact_email      TEXT,

  -- The merchant's default pickup address (optional; a tenant may create
  -- shipments with no merchant at all — Sender ≠ Merchant, domain §1.1).
  default_pickup_address_id UUID REFERENCES addresses (id) ON DELETE SET NULL,

  -- ACTIVE | SUSPENDED. A SUSPENDED merchant cannot have new pickups accepted
  -- (domain §3.18 rule 1). Merchants are never hard-deleted — status is the
  -- lifecycle, so ledger and settlement history stay intact.
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  block_reason       TEXT,

  settings           JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT merchants_status_chk CHECK (status IN ('ACTIVE', 'SUSPENDED'))
);

-- Code is unique per tenant when set (partial unique — NULLs do not collide).
CREATE UNIQUE INDEX IF NOT EXISTS merchants_tenant_code_uq
  ON merchants (tenant_id, code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS merchants_tenant_status_idx ON merchants (tenant_id, status);
-- Trigram name search for the dispatcher's merchant picker.
CREATE INDEX IF NOT EXISTS merchants_name_trgm ON merchants USING GIN (name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- recipients — the address book. Unique on (tenant_id, phone) — invariant I19.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recipients (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  full_name             TEXT NOT NULL,
  -- E.164. The natural key — in MENA the phone identifies the person.
  phone                 TEXT NOT NULL,
  phone_alt             TEXT,

  default_address_id    UUID REFERENCES addresses (id) ON DELETE SET NULL,
  preferred_language    TEXT,

  notes                 TEXT,

  -- Maintained projections, rebuilt from shipment_events — NEVER incremented
  -- ad hoc (domain §3.19 rule 3). Zero until the shipment module populates them.
  total_shipments       INTEGER NOT NULL DEFAULT 0,
  successful_deliveries INTEGER NOT NULL DEFAULT 0,
  failed_deliveries     INTEGER NOT NULL DEFAULT 0,
  last_shipment_at      TIMESTAMPTZ,

  -- Blocks new shipments to a repeat refuser — a real, costly problem in COD
  -- markets (domain §3.19 rule 4).
  is_blocked            BOOLEAN NOT NULL DEFAULT false,
  block_reason          TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT recipients_language_chk
    CHECK (preferred_language IS NULL OR preferred_language IN ('ar', 'fr', 'en')),
  CONSTRAINT recipients_counts_chk
    CHECK (total_shipments >= 0 AND successful_deliveries >= 0 AND failed_deliveries >= 0)
);

-- Invariant I19: one recipient per (tenant, phone). Two rows with the same phone
-- in one tenant is a duplicate to be merged.
CREATE UNIQUE INDEX IF NOT EXISTS recipients_tenant_phone_uq ON recipients (tenant_id, phone);
CREATE INDEX IF NOT EXISTS recipients_tenant_blocked_idx ON recipients (tenant_id, is_blocked);
CREATE INDEX IF NOT EXISTS recipients_name_trgm ON recipients USING GIN (full_name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security. Every table names its tenant; isolation is identical to
-- every other data table: ENABLE + FORCE, one policy scoped to the current
-- tenant, DML granted to dp_app only. No DELETE — merchants and recipients are
-- never hard-deleted (status / is_blocked are the lifecycle), and addresses are
-- retained history.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['addresses', 'merchants', 'recipients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      || 'USING (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid) '
      || 'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)',
      tbl || '_isolation', tbl
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO dp_app', tbl);
  END LOOP;
END
$$;

COMMENT ON TABLE addresses IS
  'Address-quality pipeline. raw_input is never overwritten; geocode_confidence gates auto-dispatch; driver-corrected geocodes compound in value (docs/06-database-design.md §4.4).';
COMMENT ON TABLE merchants IS
  'Businesses that ship through the tenant. Never "customer" (invariant I18). Never hard-deleted — status is the lifecycle.';
COMMENT ON TABLE recipients IS
  'The reusable address book of parcel receivers. Unique on (tenant_id, phone) — the phone is the identity in MENA (invariant I19).';
