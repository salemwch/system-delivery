-- Identity: users, roles, permissions, sessions.
--
-- Implements docs/02-domain-model.md §3.2 and docs/07-security-architecture.md
-- §3–§4. Every tenant-scoped table below gets RLS ENABLED + FORCED, matching
-- the rule established in 0000/0001: tenant-scoped DATA is forced; only the
-- control-plane `tenants` registry is not.

-- ─────────────────────────────────────────────────────────────────────────────
-- users — humans with web login. Drivers are a SEPARATE entity
-- (docs/02-domain-model.md §3.2): different auth, different shape, and
-- modelling both here produces a table half of whose columns are always null.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email               TEXT        NOT NULL,
  phone               TEXT,
  password_hash       TEXT        NOT NULL,
  full_name           TEXT        NOT NULL,
  locale              TEXT        NOT NULL DEFAULT 'fr',
  status              TEXT        NOT NULL DEFAULT 'INVITED',
  mfa_enabled         BOOLEAN     NOT NULL DEFAULT false,
  mfa_secret          TEXT,
  hub_scope           UUID[]      NOT NULL DEFAULT ARRAY[]::UUID[],
  last_login_at       TIMESTAMPTZ,
  failed_login_count  INTEGER     NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_status_chk CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  CONSTRAINT users_locale_chk CHECK (locale IN ('ar','fr','en')),
  CONSTRAINT users_email_chk  CHECK (position('@' in email) > 1),
  CONSTRAINT users_failed_login_chk CHECK (failed_login_count >= 0)
);

-- Email is unique PER TENANT, not globally (docs/02-domain-model.md §3.2 rule 1).
-- The same person may legitimately work for two courier companies here.
-- Stored lower-cased by the application; the index enforces case-insensitivity.
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_uq ON users (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS users_tenant_status_idx ON users (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- roles / permissions
--
-- The catalogue is defined in code (modules/identity/domain/permissions.ts) so
-- a typo is a compile error. These tables record ASSIGNMENTS, and give the
-- database referential integrity over them.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_roles (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        TEXT        NOT NULL,
  granted_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_roles_role_chk
    CHECK (role IN ('OWNER','DISPATCHER','HUB_OPERATOR','FINANCE','DRIVER','PLATFORM_ADMIN'))
);

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_role_uq ON user_roles (user_id, role);
CREATE INDEX IF NOT EXISTS user_roles_tenant_idx ON user_roles (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- refresh_tokens — rotation with reuse detection.
--
-- Only a SHA-256 digest is stored, never the token itself: a database leak must
-- not yield usable credentials.
--
-- `family_id` groups a rotation chain. Presenting an already-rotated token means
-- it was stolen, so the WHOLE family is revoked — that is what turns theft into
-- a detected incident rather than silent persistent access
-- (docs/07-security-architecture.md §3.1).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id     UUID        NOT NULL,
  token_digest  TEXT        NOT NULL,
  actor_type    TEXT        NOT NULL DEFAULT 'user',
  device_id     TEXT,
  user_agent    TEXT,
  ip_address    INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  rotated_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT refresh_tokens_actor_chk CHECK (actor_type IN ('user','driver'))
);

CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_digest_uq ON refresh_tokens (token_digest);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
-- Partial index: the lookup path only ever cares about live tokens.
CREATE INDEX IF NOT EXISTS refresh_tokens_active_idx
  ON refresh_tokens (user_id, expires_at)
  WHERE revoked_at IS NULL AND rotated_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW-LEVEL SECURITY — every table above is tenant-scoped DATA.
-- USING controls visibility; WITH CHECK controls writes. A policy with USING
-- alone is a half-open door: it hides foreign rows but still permits writing
-- into another tenant.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users          FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_roles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles     FORCE  ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS user_roles_isolation ON user_roles;
CREATE POLICY user_roles_isolation ON user_roles
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS refresh_tokens_isolation ON refresh_tokens;
CREATE POLICY refresh_tokens_isolation ON refresh_tokens
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- GRANTS — DML only. dp_app has no DDL privileges anywhere.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON users          TO dp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles     TO dp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO dp_app;

-- updated_at maintenance (function defined in 0000).
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS
  'Web-login humans, scoped to a tenant. Drivers are a separate entity (different auth and shape). Email is unique per tenant, not globally.';
COMMENT ON TABLE refresh_tokens IS
  'Rotation chains. Only SHA-256 digests are stored. Reusing a rotated token revokes its entire family.';
