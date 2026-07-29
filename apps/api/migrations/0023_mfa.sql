-- Real multi-factor authentication (docs/01-mvp-scope.md §4.1 #1.5,
-- docs/07-security-architecture.md §3, §4.1).
--
-- ⚠️ WHAT THIS FIXES. `users.mfa_enabled` existed and `MFA_REQUIRED_ROLES` was
-- enforced fail-closed at login, but there was no enrolment and no challenge —
-- so provisioning simply set the flag to `true` to make privileged accounts
-- able to log in at all. The flag SAID multi-factor; the login was
-- password-only. OWNER, FINANCE and PLATFORM_ADMIN — the three roles that can
-- move money, export PII, and reach across tenants — had one factor.
--
-- Three pieces are needed for the flag to mean what it claims:
--   1. an enrolment that produces a secret the user's authenticator holds too;
--   2. a challenge at login that proves possession of it;
--   3. a way back in when the phone is lost, that is not "ask an admin to turn
--      MFA off", because that path is the account-takeover route attackers
--      actually use.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enrolment state on `users`.
--
-- `mfa_secret` already exists and is encrypted by the application before it is
-- written (FieldCipher, AES-256-GCM) — docs/07 §7 classes MFA secrets as
-- CRITICAL. The database never sees the base32 seed.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enrolment is two-phase: a secret is generated and stored, but MFA is not
-- ACTIVE until the user proves their authenticator produced a correct code.
-- Without the distinction, a half-finished enrolment locks the user out of
-- their own account with a secret they never successfully scanned.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ;

COMMENT ON COLUMN users.mfa_enrolled_at IS
  'Set when the user first proved possession of the TOTP secret. NULL while a secret exists but has never been verified — enrolment is not complete and mfa_enabled stays false.';

-- ⚠️ Replay defence. A TOTP code is valid for a whole time-step (30 s) plus the
-- drift window, so a code observed over the shoulder, from a phishing proxy, or
-- in a log can be replayed within that window. Recording the last accepted step
-- and refusing anything at or below it makes every code strictly single-use.
--
-- This is the control most TOTP implementations omit, and its absence is what
-- turns a stolen code into a working second factor.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;

COMMENT ON COLUMN users.mfa_last_step IS
  'Highest TOTP time-step already accepted. A code at or below this is refused, making each code single-use within its validity window.';

-- Failed challenge attempts, counted separately from failed passwords. A
-- correct password followed by wrong codes is a different signal from a wrong
-- password: it means the attacker HAS the password and is working on the
-- second factor.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_failed_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_mfa_failed_chk;
ALTER TABLE users
  ADD CONSTRAINT users_mfa_failed_chk CHECK (mfa_failed_count >= 0);

-- Enrolment cannot be complete without a secret, and a completed enrolment
-- cannot lose one. Cheap to state, and it makes the impossible state
-- unrepresentable rather than merely unlikely.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_mfa_enrolment_chk;
ALTER TABLE users
  ADD CONSTRAINT users_mfa_enrolment_chk
    CHECK (mfa_enrolled_at IS NULL OR mfa_secret IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- mfa_recovery_codes — the way back in when the phone is gone.
--
-- Stored as ARGON2 HASHES, exactly like passwords. A recovery code is a
-- bearer credential that bypasses the second factor entirely, so a database
-- read must not yield a working one. They are shown to the user once, at
-- enrolment, and never again.
--
-- Separate rows rather than an array column so a single code can be marked used
-- atomically, and so "how many are left" is a cheap count.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users (id)   ON DELETE CASCADE,

  -- Argon2id, never the code itself.
  code_hash  TEXT        NOT NULL,

  -- Single-use. Set at the moment of consumption, never cleared.
  used_at    TIMESTAMPTZ,
  -- Kept for the audit trail: which device burned the code.
  used_ip    INET,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mfa_recovery_codes IS
  'Single-use recovery codes, Argon2id-hashed. Bypass the second factor, so they are treated exactly like passwords: shown once, never recoverable.';

-- The hot path: "find this user''s unused codes to check one".
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx
  ON mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS mfa_recovery_codes_tenant_idx
  ON mfa_recovery_codes (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security. Identical shape to every other tenant-scoped table.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_recovery_codes_isolation ON mfa_recovery_codes;
CREATE POLICY mfa_recovery_codes_isolation ON mfa_recovery_codes
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ⚠️ REVOKE, not a narrower GRANT — default privileges already granted full
-- DML (see 0022 and infra/docker/initdb/02-roles.sql).
--
-- DELETE is revoked because consuming a code must MARK it used, not remove it:
-- a deleted row cannot prove the code was already spent, and re-issuing codes
-- must not silently erase the evidence of the last set. Re-enrolment marks the
-- old ones used instead.
GRANT SELECT, INSERT, UPDATE ON mfa_recovery_codes TO dp_app;
REVOKE DELETE, TRUNCATE ON mfa_recovery_codes FROM dp_app;
