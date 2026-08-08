-- Villes — the courier's coverage list and its per-city tariff.
--
-- A Tunisian courier does not price by distance. It prices by DESTINATION CITY:
-- a flat delivery fee for Tunis, a higher one for Tataouine, and a separate
-- return fee when the parcel comes back. Every operator has this table, and
-- every operator's is different — coverage is a commercial decision, so this is
-- tenant-scoped data, never a shared reference list.
--
-- Two things this table is NOT:
--
--   * It is not a geocoding source. `addresses` keeps its free-text city and its
--     geocoded point; a city here is a TARIFF ZONE with a name, not a polygon.
--     `zone_id` links the two when the operator has drawn a boundary, and stays
--     NULL when they have not.
--   * It is not a substitute for `zones`. A zone is geography (ST_Covers decides
--     which hub serves an address); a city is commerce (what we charge).

CREATE TABLE IF NOT EXISTS cities (
  id                    UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Operational code as it appears on a manifest, e.g. TUN-ARIANA. Unique per
  -- tenant and stable: an operator writes it on paper.
  code                  TEXT        NOT NULL,

  -- The name as printed on a docket, and its Arabic form. Arabic is nullable
  -- rather than defaulted to the Latin name — printing "Ariana" in an Arabic
  -- document is worse than printing nothing and having the renderer fall back
  -- deliberately.
  name                  TEXT        NOT NULL,
  name_ar               TEXT,

  -- Gouvernorat. Free text rather than an enum: Tunisia has 24 today, and a
  -- tenant expanding into Libya or Algeria must not need a migration.
  governorate           TEXT        NOT NULL,
  postal_code           TEXT,

  -- The drawn territory, when there is one. ON DELETE SET NULL: retiring a zone
  -- must not delete the tariff, which is accounting data.
  zone_id               UUID        REFERENCES zones (id) ON DELETE SET NULL,

  -- ── The tariff ────────────────────────────────────────────────────────────
  -- Minor units against an explicit currency, like every other amount in this
  -- schema. Zero is legitimate (free delivery to the capital is a real offer);
  -- negative is not.
  currency              TEXT        NOT NULL REFERENCES currencies (code),
  delivery_fee_minor    BIGINT      NOT NULL DEFAULT 0,
  return_fee_minor      BIGINT      NOT NULL DEFAULT 0,

  -- Working days from pickup to the promised delivery. Feeds the SLA the
  -- merchant is quoted; 0 means same-day.
  delivery_delay_days   INTEGER     NOT NULL DEFAULT 1,

  -- ── Matching ──────────────────────────────────────────────────────────────
  -- What a human typed, in every spelling this city answers to: "Ariana Ville",
  -- "Aryanah", "أريانة". Held as entered, for the operator to read and edit.
  aliases               TEXT[]      NOT NULL DEFAULT '{}',

  -- The same set, normalised: accents stripped, Arabic letter forms unified,
  -- punctuation collapsed, lower-cased. Derived by the application in ONE place
  -- (`normaliseCityKey`) and maintained on every write.
  --
  -- ⚠️ WHY NOT A GENERATED COLUMN. Postgres can only generate from an IMMUTABLE
  -- expression, and the normalisation this needs — Unicode NFD, combining-mark
  -- stripping, Arabic alef/teh-marbuta folding — is not expressible in stock SQL
  -- without `unaccent`, which is (a) an extension we do not require elsewhere
  -- and (b) STABLE, not IMMUTABLE, so it cannot appear in a generated column or
  -- an index anyway. Deriving it in TypeScript keeps one implementation that the
  -- unit tests can pin.
  search_keys           TEXT[]      NOT NULL DEFAULT '{}',

  -- Soft retirement. A city that stops being served keeps its rows: past
  -- shipments and invoices reference the tariff that applied at the time.
  active                BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cities_delivery_fee_chk  CHECK (delivery_fee_minor  >= 0),
  CONSTRAINT cities_return_fee_chk    CHECK (return_fee_minor    >= 0),
  CONSTRAINT cities_delay_chk         CHECK (delivery_delay_days BETWEEN 0 AND 365),
  CONSTRAINT cities_name_chk          CHECK (length(btrim(name)) > 0),
  CONSTRAINT cities_code_chk          CHECK (length(btrim(code)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS cities_tenant_code_uq
  ON cities (tenant_id, code);

-- The list screen: active cities of a tenant, ordered by governorate then name.
CREATE INDEX IF NOT EXISTS cities_tenant_active_idx
  ON cities (tenant_id, active, governorate, name);

-- The lookup. `search_keys && ARRAY[$1]` is an array-overlap test, which GIN
-- answers from the index instead of scanning every city of the tenant.
CREATE INDEX IF NOT EXISTS cities_search_keys_gin
  ON cities USING GIN (search_keys);

-- Cities of a zone, for the zone editor.
CREATE INDEX IF NOT EXISTS cities_zone_idx
  ON cities (zone_id) WHERE zone_id IS NOT NULL;

COMMENT ON TABLE cities IS
  'Per-tenant delivery coverage and tariff. A city is commerce (what we charge); '
  'a zone is geography (which hub serves it).';
COMMENT ON COLUMN cities.search_keys IS
  'Normalised forms of name, name_ar and aliases. Derived by normaliseCityKey in '
  'the application — Postgres cannot generate it without unaccent, which is STABLE '
  'and therefore unusable in a generated column or an index.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- Plain tenant isolation, no sub-tenant narrowing. A merchant and a commercial
-- both legitimately read the tariff list — it is what they are quoted — and it
-- carries no merchant_id to narrow by. Writing is gated by permission, not RLS.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cities FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cities_isolation ON cities;
CREATE POLICY cities_isolation ON cities
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- No DELETE: a city is retired with `active = false`, never removed, because
-- `zone_id`-less historical tariffs are the only record of what a past shipment
-- was priced at.
GRANT SELECT, INSERT, UPDATE ON cities TO dp_app;
