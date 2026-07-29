-- Merchant portal logins (docs/01-mvp-scope.md §4.2 #2.16, §6; §3.2 rules 7–8).
--
-- Adds the MERCHANT role and scopes a merchant user to exactly one merchant.
--
-- ⚠️ MERCHANT is the FIRST ROLE SCOPED BELOW THE TENANT.
--
-- Every other role sees the whole tenant, so RLS alone isolates them completely.
-- A merchant must see only their own rows inside a tenant that also holds their
-- competitors' parcels. RLS cannot express that on its own — `app.current_tenant_id`
-- is the only thing the policies read — so scoping is carried by `users.merchant_id`
-- and enforced by the application's data layer on top of RLS.
--
-- The consequence of getting this wrong is not a broken page: it is one merchant
-- reading a rival's shipment volume, customer list, and revenue.

-- ─────────────────────────────────────────────────────────────────────────────
-- users.merchant_id
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants (id);

COMMENT ON COLUMN users.merchant_id IS
  'Set if and only if the user holds the MERCHANT role (invariant I23). Scopes '
  'the user to one merchant WITHIN the tenant — the only sub-tenant scope in the '
  'system.';

-- Serves the login path: resolve a merchant user to their merchant on every request.
CREATE INDEX IF NOT EXISTS users_tenant_merchant_idx
  ON users (tenant_id, merchant_id)
  WHERE merchant_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- MERCHANT role
--
-- The CHECK on user_roles is an explicit allow-list, so widening it is a
-- deliberate migration rather than something an application typo can do.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_chk;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_role_chk
    CHECK (role IN ('OWNER','DISPATCHER','HUB_OPERATOR','FINANCE','DRIVER','PLATFORM_ADMIN','MERCHANT'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariant I23 — a user holds merchant_id IF AND ONLY IF they hold MERCHANT.
--
-- Both halves matter, in opposite directions:
--   * MERCHANT role with NO merchant_id  → the scope filter has nothing to match,
--     and the user sees the whole tenant. A privilege escalation.
--   * merchant_id on a NON-merchant role → a dispatcher or owner is silently
--     narrowed to one merchant and quietly stops seeing most of their work.
--
-- A plain CHECK cannot express this: the role lives in `user_roles`, a different
-- table. So it is a CONSTRAINT TRIGGER, and it is DEFERRABLE INITIALLY DEFERRED
-- for a specific reason — provisioning inserts the user row and the role row in
-- one transaction, and whichever lands first would fail an immediate check.
-- Deferring to COMMIT lets the transaction reach a consistent state before the
-- invariant is judged. Same pattern as `ledger_entries_balanced` in 0012.
--
-- All three functions below are SECURITY DEFINER. They are integrity checks and
-- must see the truth regardless of the caller's row-security context: without
-- it they read `users`/`user_roles` under whatever tenant scope the session
-- happens to carry, and during a cascade delete that is none at all — turning
-- `current_setting(...)::uuid` into an empty-string cast error instead of a
-- check. They only ever SELECT and RAISE; they never write.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION users_assert_merchant_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  target_user  UUID;
  has_role     BOOLEAN;
  has_merchant BOOLEAN;
BEGIN
  target_user := COALESCE(NEW.user_id, OLD.user_id);

  -- The user may have been deleted in this same transaction (cascade); there is
  -- then nothing left to be inconsistent about.
  SELECT (merchant_id IS NOT NULL) INTO has_merchant FROM users WHERE id = target_user;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = target_user AND role = 'MERCHANT'
  ) INTO has_role;

  IF has_role AND NOT has_merchant THEN
    RAISE EXCEPTION
      'user % holds the MERCHANT role but no merchant_id — it would be scoped to the whole tenant (invariant I23)',
      target_user
      USING ERRCODE = 'check_violation';
  END IF;

  IF has_merchant AND NOT has_role THEN
    RAISE EXCEPTION
      'user % has merchant_id but not the MERCHANT role — a non-merchant role would be silently narrowed (invariant I23)',
      target_user
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- Fires from BOTH sides: the scope can be broken by changing either the role or
-- the column, so guarding only one leaves the other as an open door.
DROP TRIGGER IF EXISTS user_roles_merchant_scope ON user_roles;
CREATE CONSTRAINT TRIGGER user_roles_merchant_scope
  AFTER INSERT OR UPDATE OR DELETE ON user_roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION users_assert_merchant_scope();

CREATE OR REPLACE FUNCTION users_assert_own_merchant_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  has_role BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = NEW.id AND role = 'MERCHANT'
  ) INTO has_role;

  IF has_role AND NEW.merchant_id IS NULL THEN
    RAISE EXCEPTION
      'user % holds the MERCHANT role but no merchant_id (invariant I23)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.merchant_id IS NOT NULL AND NOT has_role THEN
    RAISE EXCEPTION
      'user % has merchant_id but not the MERCHANT role (invariant I23)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS users_merchant_scope ON users;
CREATE CONSTRAINT TRIGGER users_merchant_scope
  AFTER INSERT OR UPDATE OF merchant_id ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION users_assert_own_merchant_scope();

-- ─────────────────────────────────────────────────────────────────────────────
-- A merchant user must belong to a merchant of their OWN tenant.
--
-- The FK above only proves the merchant exists — it says nothing about which
-- tenant owns it. Without this, a mis-provisioned account could point across a
-- tenant boundary, which is the one isolation failure this platform cannot have.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION users_assert_merchant_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  merchant_tenant UUID;
BEGIN
  IF NEW.merchant_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT tenant_id INTO merchant_tenant FROM merchants WHERE id = NEW.merchant_id;

  IF merchant_tenant IS NULL OR merchant_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'user % references merchant % from a different tenant', NEW.id, NEW.merchant_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS users_merchant_tenant ON users;
CREATE CONSTRAINT TRIGGER users_merchant_tenant
  AFTER INSERT OR UPDATE OF merchant_id, tenant_id ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION users_assert_merchant_tenant();
