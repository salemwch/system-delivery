-- Merchant row scoping (invariant I24, docs/01-mvp-scope.md §6).
--
-- MERCHANT is the first role scoped BELOW the tenant. Every other role sees the
-- whole tenant, so the existing `tenant_id = current_setting(...)` policies
-- isolate them completely. A merchant must see only their own rows INSIDE a
-- tenant that also holds their competitors' parcels.
--
-- ⚠️ This is enforced in RLS, not in service code, and that choice is the whole
-- point. Application-side filtering means every present and future query must
-- remember a `WHERE merchant_id = ...`; one that forgets does not fail loudly —
-- it quietly returns a rival's shipment volume, customer names, and revenue.
-- Postgres cannot forget.
--
-- `app.current_merchant_id` is set alongside `app.current_tenant_id` by
-- DatabaseService.withTenant, transaction-locally, from the signed token. When
-- it is empty — every non-merchant role — the policies below are a no-op and
-- behaviour is exactly as before.

-- ─────────────────────────────────────────────────────────────────────────────
-- A reusable predicate.
--
-- STABLE, not VOLATILE: it depends only on settings that cannot change inside a
-- statement, so the planner may evaluate it once per query rather than per row.
-- On a table the dispatcher board reads constantly, that difference is real.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION current_merchant_allows(row_merchant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  -- CASE, not OR. SQL does not promise to short-circuit `OR`, so a form like
  -- `setting = '' OR col = setting::uuid` lets Postgres evaluate the cast even
  -- when the guard is true — and `''::uuid` is an error, not false. CASE does
  -- guarantee ordered evaluation.
  SELECT CASE
    -- No merchant context: not a merchant login, so no narrowing at all.
    WHEN COALESCE(current_setting('app.current_merchant_id', true), '') = '' THEN TRUE
    -- Otherwise the row must belong to exactly that merchant. A NULL
    -- row_merchant_id yields NULL here, which RLS treats as "deny" — deliberate:
    -- a tenant-owned row with no merchant belongs to the courier, not to any
    -- merchant, and fail-closed is the only safe default for a leak of this kind.
    ELSE row_merchant_id = current_setting('app.current_merchant_id', true)::uuid
  END;
$$;

COMMENT ON FUNCTION current_merchant_allows(UUID) IS
  'Invariant I24. True when the current session is not a merchant login, or when '
  'the row belongs to that merchant. Fails closed on rows with no merchant.';

-- ─────────────────────────────────────────────────────────────────────────────
-- shipments — the parcels a merchant ships.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS shipments_isolation ON shipments;
CREATE POLICY shipments_isolation ON shipments
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- pickup_requests — "come and collect my parcels".
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS pickup_requests_tenant_isolation ON pickup_requests;
CREATE POLICY pickup_requests_tenant_isolation ON pickup_requests
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- settlements — "how much am I owed, and what has been paid".
--
-- The most sensitive of the three: a settlement discloses a merchant's revenue
-- through this courier, which is exactly what a competitor sharing the tenant
-- would most like to read.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS settlements_isolation ON settlements;
CREATE POLICY settlements_isolation ON settlements
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
  );
