-- The COMMERCIAL role and merchant account ownership (docs/01-mvp-scope.md §6).
--
-- The *commercial* is the field salesperson of a MENA courier: they call on the
-- expéditeur, sign them up, collect the parcels themselves, and stay the named
-- contact for that account afterwards. Three jobs the platform already had
-- pieces of but no owner for — merchant onboarding, parcel collection, and
-- account follow-up.
--
-- ⚠️ THIS IS THE SECOND ROLE SCOPED BELOW THE TENANT, and it is scoped
-- differently from the first.
--
--   * MERCHANT (0019/0020) is scoped to exactly ONE merchant, carried in the
--     token as `mid` and read from `app.current_merchant_id`.
--   * COMMERCIAL is scoped to a SET of merchants — the portfolio they manage —
--     which is not a token claim at all. It is `merchants.account_manager_id =
--     <the commercial's own user id>`, read from `app.current_account_manager_id`.
--
-- Scoping a set rather than a single id is why this needs its own predicate
-- instead of reusing `current_merchant_allows`. The consequence of getting it
-- wrong is the same: one merchant's volume, customers and revenue disclosed to
-- someone with no business seeing them.
--
-- Enforced in RLS rather than in service code for the reason spelled out in
-- 0020 — application filtering means every present and future query must
-- remember a WHERE clause, and the one that forgets fails silently.

-- ─────────────────────────────────────────────────────────────────────────────
-- The role itself.
--
-- The CHECK on user_roles is an explicit allow-list, so widening it is a
-- deliberate migration rather than something an application typo can do.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_chk;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_role_chk
    CHECK (role IN ('OWNER','DISPATCHER','HUB_OPERATOR','FINANCE','DRIVER','PLATFORM_ADMIN','MERCHANT','COMMERCIAL'));

-- ─────────────────────────────────────────────────────────────────────────────
-- merchants.account_manager_id — who owns this account.
--
-- ON DELETE SET NULL, not CASCADE: a commercial leaving the company must not
-- take their merchants' rows with them. The account becomes unassigned and an
-- OWNER reassigns it.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS account_manager_id UUID REFERENCES users (id) ON DELETE SET NULL;

COMMENT ON COLUMN merchants.account_manager_id IS
  'The COMMERCIAL who owns this account. Read from app.current_account_manager_id '
  'by RLS to narrow a commercial login to their own portfolio (invariant I25). '
  'NULL means house-managed — visible to tenant-wide roles, to no commercial.';

-- Serves the portfolio predicate below, which runs on every row a commercial
-- reads. Partial: the overwhelming majority of merchants in a mature tenant are
-- house-managed, and indexing those rows would only make the index bigger
-- without ever being probed for them.
CREATE INDEX IF NOT EXISTS merchants_tenant_account_manager_idx
  ON merchants (tenant_id, account_manager_id)
  WHERE account_manager_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- An account manager must belong to the merchant's OWN tenant.
--
-- The FK above only proves the user exists — it says nothing about which tenant
-- owns them. Same reasoning, and the same shape, as
-- `users_assert_merchant_tenant` in 0019: SECURITY DEFINER so the check sees the
-- truth regardless of the caller's row-security context, DEFERRABLE so a
-- transaction that creates the user and the assignment together is judged once
-- it is consistent. It only ever SELECTs and RAISEs.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION merchants_assert_account_manager_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  manager_tenant UUID;
BEGIN
  IF NEW.account_manager_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT tenant_id INTO manager_tenant FROM users WHERE id = NEW.account_manager_id;

  IF manager_tenant IS NULL OR manager_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION
      'merchant % references account manager % from a different tenant', NEW.id, NEW.account_manager_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS merchants_account_manager_tenant ON merchants;
CREATE CONSTRAINT TRIGGER merchants_account_manager_tenant
  AFTER INSERT OR UPDATE OF account_manager_id, tenant_id ON merchants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION merchants_assert_account_manager_tenant();

-- ─────────────────────────────────────────────────────────────────────────────
-- Predicate 1 — for `merchants` itself.
--
-- A DIRECT column comparison, deliberately. It must not query `merchants`,
-- because it is the predicate OF `merchants`: a policy whose function selects
-- from the table it guards recurses until the stack runs out.
--
-- STABLE for the reason given in 0020: it reads only settings that cannot
-- change inside a statement, so the planner may hoist it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_account_manager_allows(row_account_manager_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  -- CASE, not OR — SQL does not promise to short-circuit OR, and ''::uuid is an
  -- error rather than false (see 0020).
  SELECT CASE
    -- No commercial context: not a commercial login, so no narrowing at all.
    WHEN COALESCE(current_setting('app.current_account_manager_id', true), '') = '' THEN TRUE
    -- Otherwise the account must be theirs. A NULL manager yields NULL here,
    -- which RLS treats as deny — correct: a house-managed merchant belongs to
    -- the courier, not to any commercial.
    ELSE row_account_manager_id = current_setting('app.current_account_manager_id', true)::uuid
  END;
$$;

COMMENT ON FUNCTION current_account_manager_allows(UUID) IS
  'Invariant I25, for rows that name their account manager directly. True when the '
  'session is not a commercial login, or when the account is theirs.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Predicate 2 — for every table that names a MERCHANT rather than a manager.
--
-- Resolves the merchant to its owner. The lookup runs under the caller's own
-- row security, so `merchants` narrows it a second time; that is harmless (the
-- two narrowings agree by construction) and it means the portfolio is defined
-- in exactly one place.
--
-- No recursion: `merchants`' own policy uses predicate 1, which reads no table.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_portfolio_allows(row_merchant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_account_manager_id', true), '') = '' THEN TRUE
    -- Fails closed on a row with no merchant, exactly as the merchant predicate
    -- does: a shipment or complaint with no merchant is the courier's own
    -- operation and is none of a commercial's business.
    WHEN row_merchant_id IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1 FROM merchants m
       WHERE m.id = row_merchant_id
         AND m.account_manager_id = current_setting('app.current_account_manager_id', true)::uuid
    )
  END;
$$;

COMMENT ON FUNCTION current_portfolio_allows(UUID) IS
  'Invariant I25, for rows that name a merchant. True when the session is not a '
  'commercial login, or when the merchant is in their portfolio. Fails closed on '
  'rows with no merchant.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The policies.
--
-- Each is the 0020/0025 policy with one more conjunct. Every predicate returns
-- TRUE the moment `app.current_account_manager_id` is empty, which is every
-- session that is not a commercial login — so behaviour for all seven existing
-- roles is bit-for-bit what it was.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS merchants_isolation ON merchants;
CREATE POLICY merchants_isolation ON merchants
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_account_manager_allows(account_manager_id)
  )
  -- WITH CHECK as well: a commercial creating a merchant must name themselves as
  -- its manager, or the row would be invisible to them the instant it is
  -- committed. Postgres refuses it rather than letting them write into the dark.
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_account_manager_allows(account_manager_id)
  );

DROP POLICY IF EXISTS shipments_isolation ON shipments;
CREATE POLICY shipments_isolation ON shipments
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
  );

DROP POLICY IF EXISTS pickup_requests_tenant_isolation ON pickup_requests;
CREATE POLICY pickup_requests_tenant_isolation ON pickup_requests
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
  );

DROP POLICY IF EXISTS settlements_isolation ON settlements;
CREATE POLICY settlements_isolation ON settlements
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
  );

DROP POLICY IF EXISTS complaints_isolation ON complaints;
CREATE POLICY complaints_isolation ON complaints
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- A commercial may mint a portal login only for a merchant they manage.
--
-- RLS cannot express this one. The insert lands in `users`, whose policy knows
-- about tenants and nothing about portfolios, and the FK check on merchant_id
-- runs as the referential-integrity system rather than as the caller — so it
-- sees merchants outside the portfolio and happily accepts them.
--
-- Without this, `POST /v1/users/merchant-login` would let a commercial issue
-- themselves credentials to a rival commercial's merchant, and the resulting
-- login would then pass every check in the system because it is a perfectly
-- legitimate MERCHANT account.
--
-- Placed in the database rather than the service for the usual reason: identity
-- cannot import directory (docs/04-context-map.md §2.1), so a service-layer
-- check would have to duplicate the ownership rule in a module that does not
-- own the table. Postgres owns both.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION users_assert_merchant_in_portfolio() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  scope TEXT;
BEGIN
  scope := COALESCE(current_setting('app.current_account_manager_id', true), '');

  -- Not a commercial's transaction, or a login with no merchant at all.
  IF scope = '' OR NEW.merchant_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM merchants
     WHERE id = NEW.merchant_id
       AND account_manager_id = scope::uuid
  ) THEN
    RAISE EXCEPTION
      'merchant % is not in the portfolio of account manager % (invariant I25)',
      NEW.merchant_id, scope
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS users_merchant_portfolio ON users;
CREATE CONSTRAINT TRIGGER users_merchant_portfolio
  AFTER INSERT OR UPDATE OF merchant_id ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION users_assert_merchant_in_portfolio();
