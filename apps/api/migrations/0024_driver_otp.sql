-- Driver phone/OTP authentication (docs/01-mvp-scope.md §4.1 #1.4,
-- docs/07-security-architecture.md §3.2).
--
-- ⚠️ WHAT THIS FIXES. Drivers had NO working login path. `drivers.user_id` and
-- the DRIVER role existed, and `TokenService` could mint a driver token, but
-- nothing issued one — the Android app (§4.4, the whole of it) had no way in.
--
-- Why phone/OTP rather than email/password: a Tunisian courier driver does not
-- have a work email, and a password typed on a phone in a van at 07:00 is
-- either trivial or written on the dashboard. The phone is already the driver's
-- identity in `drivers` (unique per tenant), and SMS is a channel this platform
-- already speaks.
--
-- ⚠️ AN OTP IS A CREDENTIAL. Everything here follows from that:
--   * the CODE IS HASHED (Argon2id) — a database read must not yield a working
--     login, exactly as for passwords and MFA recovery codes;
--   * attempts are CAPPED per code, so a 6-digit code cannot be brute-forced
--     inside its lifetime;
--   * requests are RATE-LIMITED per phone, because free SMS to an arbitrary
--     number is both a bill and a way to harass a stranger;
--   * codes are SINGLE-USE and short-lived.

CREATE TABLE IF NOT EXISTS otp_codes (
  id             UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- E.164. NOT a driver_id: the code is requested before anyone is
  -- authenticated, and resolving the driver up front would make a wrong number
  -- and a valid one distinguishable by response — a driver-enumeration oracle.
  phone          TEXT        NOT NULL,

  -- Argon2id. Never the code.
  code_hash      TEXT        NOT NULL,

  purpose        TEXT        NOT NULL DEFAULT 'DRIVER_LOGIN',

  -- Wrong guesses against THIS code. A 6-digit code is 1-in-a-million per
  -- guess; unbounded attempts inside a 5-minute window is not.
  attempt_count  SMALLINT    NOT NULL DEFAULT 0,

  -- Set the moment the code is accepted. Single-use: a code already consumed is
  -- refused even inside its validity window.
  consumed_at    TIMESTAMPTZ,

  expires_at     TIMESTAMPTZ NOT NULL,
  -- Kept for the audit trail: which device asked, and which device answered.
  requested_ip   INET,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT otp_codes_purpose_chk CHECK (purpose IN ('DRIVER_LOGIN')),
  CONSTRAINT otp_codes_attempts_chk CHECK (attempt_count >= 0),
  CONSTRAINT otp_codes_expiry_chk CHECK (expires_at > created_at)
);

COMMENT ON TABLE otp_codes IS
  'One-time codes for driver phone login. Argon2id-hashed, single-use, attempt-capped, and rate-limited per phone — an OTP is a credential (docs/07-security-architecture.md §3.2).';
COMMENT ON COLUMN otp_codes.phone IS
  'Keyed by phone, not driver_id: the code is requested before authentication, and resolving the driver first would make an unknown number distinguishable from a known one.';

-- The verification path: "the live code for this phone". Partial and ordered so
-- the lookup is an index-only hit on a table that accumulates spent rows.
CREATE INDEX IF NOT EXISTS otp_codes_lookup_idx
  ON otp_codes (tenant_id, phone, created_at DESC)
  WHERE consumed_at IS NULL;

-- The rate-limit query: "how many codes has this phone asked for recently".
CREATE INDEX IF NOT EXISTS otp_codes_rate_idx
  ON otp_codes (tenant_id, phone, created_at DESC);

-- Retention: spent and expired codes are worthless within the hour but the rows
-- are evidence of a brute-force attempt, so they are swept on a schedule rather
-- than deleted on use.
CREATE INDEX IF NOT EXISTS otp_codes_expiry_idx ON otp_codes (expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS otp_codes_isolation ON otp_codes;
CREATE POLICY otp_codes_isolation ON otp_codes
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ⚠️ REVOKE, not a narrower GRANT — `ALTER DEFAULT PRIVILEGES` in
-- infra/docker/initdb/02-roles.sql already granted full DML (see 0022).
--
-- DELETE is revoked from the application: consuming a code MARKS it, and the
-- rows are the record of how many codes a number requested and how many wrong
-- guesses it received. An attacker who could delete them could erase the
-- evidence of the attack. The retention sweep runs as the migrator.
GRANT SELECT, INSERT, UPDATE ON otp_codes TO dp_app;
REVOKE DELETE, TRUNCATE ON otp_codes FROM dp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- The phone that logs you in belongs to your LOGIN, not to your driver profile.
--
-- ⚠️ A deliberate design choice, and the alternative was worse. Resolving
-- phone → `drivers` → `users` would make `identity` (layer 0) depend on `fleet`
-- (layer 1), inverting the dependency that already runs the other way. Working
-- around that with a port and an adapter produced a circular module reference
-- for no gain.
--
-- `users.phone` already existed. Authentication identity is an `identity`
-- concern, so this is where it belongs — and `drivers.phone` stays what it
-- always was: the operational contact number, which dispatch calls and which
-- may legitimately differ from the number the driver's handset authenticates
-- with.
--
-- Partial UNIQUE so two logins in one tenant cannot claim the same number
-- (whose session would the code mint?), while the many users with no phone at
-- all are unaffected — NULLs are simply not in the index.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_phone_uq
  ON users (tenant_id, phone)
  WHERE phone IS NOT NULL;

-- Retention sweep for spent codes (docs/06-database-design.md §9). Codes carry
-- no long-term value; 30 days is enough to investigate an attack.
CREATE OR REPLACE FUNCTION purge_expired_otp_codes(older_than INTERVAL DEFAULT INTERVAL '30 days')
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM otp_codes WHERE created_at < now() - older_than;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

COMMENT ON FUNCTION purge_expired_otp_codes(INTERVAL) IS
  'Retention sweep. Runs as the migrator — dp_app has no DELETE on this table, deliberately.';
