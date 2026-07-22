-- Platform tenancy foundation.
--
-- Written by hand rather than generated: the Row-Level Security policies below
-- are the platform's primary defence against cross-tenant data exposure
-- (docs/07-security-architecture.md §5), and they must be reviewable line by
-- line rather than emerging from a schema differ.
--
-- Runs as dp_migrator. The application role dp_app receives DML only.

-- ─────────────────────────────────────────────────────────────────────────────
-- tenants — the root of all isolation (docs/02-domain-model.md §3.1)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                 UUID PRIMARY KEY DEFAULT uuidv7(),
  name               TEXT        NOT NULL,
  slug               TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'PROVISIONING',
  country_code       TEXT        NOT NULL,
  default_currency   TEXT        NOT NULL,
  default_timezone   TEXT        NOT NULL,
  default_locale     TEXT        NOT NULL DEFAULT 'fr',
  supported_locales  TEXT[]      NOT NULL DEFAULT ARRAY['ar','fr','en'],
  plan               TEXT        NOT NULL DEFAULT 'PILOT',
  region             TEXT        NOT NULL DEFAULT 'eu-central',
  settings           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tenants_status_chk
    CHECK (status IN ('PROVISIONING','ACTIVE','SUSPENDED','CLOSED')),
  CONSTRAINT tenants_country_code_chk CHECK (char_length(country_code) = 2),
  CONSTRAINT tenants_currency_chk     CHECK (char_length(default_currency) = 3),
  CONSTRAINT tenants_slug_chk         CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_key   ON tenants (slug);
CREATE INDEX        IF NOT EXISTS tenants_status_idx ON tenants (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- tenant_features — per-tenant capability toggles (docs/02-domain-model.md §3.17)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_features (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  feature_key         TEXT        NOT NULL,
  enabled             BOOLEAN     NOT NULL DEFAULT false,
  source              TEXT        NOT NULL DEFAULT 'PLAN',
  config              JSONB,
  expires_at          TIMESTAMPTZ,
  reason              TEXT,
  updated_by_user_id  UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tenant_features_source_chk CHECK (source IN ('PLAN','OVERRIDE','TRIAL')),
  -- An OVERRIDE is a manual exception; it must say why (docs §3.17 field notes).
  CONSTRAINT tenant_features_override_reason_chk
    CHECK (source <> 'OVERRIDE' OR (reason IS NOT NULL AND char_length(reason) > 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_features_tenant_key_uq
  ON tenant_features (tenant_id, feature_key);
CREATE INDEX IF NOT EXISTS tenant_features_tenant_idx
  ON tenant_features (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY
--
-- Three things must all be true or isolation silently does nothing:
--   1. ENABLE  — activates policies for non-owner roles.
--   2. FORCE   — applies them to the table OWNER too. Without this, dp_migrator
--                (and anything running as owner) bypasses every policy.
--   3. dp_app must NOT have BYPASSRLS — verified in 02-roles.sql and asserted
--      by the isolation test suite.
--
-- USING governs which rows are visible to SELECT/UPDATE/DELETE.
-- WITH CHECK governs which rows may be WRITTEN — it is what stops a tenant
-- inserting or updating a row into ANOTHER tenant. A policy with USING alone
-- is a half-open door.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE tenant_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_features FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_features_isolation ON tenant_features;
CREATE POLICY tenant_features_isolation ON tenant_features
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- `tenants` itself is the tenant registry. A tenant may read only its own row;
-- creating tenants is a platform-admin operation that runs as dp_migrator.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_self_read ON tenants;
CREATE POLICY tenants_self_read ON tenants
  FOR SELECT
  USING (id = current_setting('app.current_tenant_id', true)::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANTS — dp_app gets DML only, never DDL.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT                         ON tenants         TO dp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_features TO dp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at maintenance. Doing this in a trigger rather than the application
-- means it cannot be forgotten by a code path that writes directly.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS tenant_features_set_updated_at ON tenant_features;
CREATE TRIGGER tenant_features_set_updated_at
  BEFORE UPDATE ON tenant_features
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
