-- ─────────────────────────────────────────────────────────────────────────────
-- 0029 — resolving a tenant from its public slug
--
-- ⚠️ THE PUBLIC TRACKING PAGE COULD NEVER RESOLVE A TENANT, so the entire
-- customer-facing tracking feature was non-functional.
--
-- `tenants_self_read` (migration 0000) reads
-- `USING (id = current_setting('app.current_tenant_id', true)::uuid)`, and
-- `tenants` is FORCE RLS. `TenantService.resolveBySlug` is called by the PUBLIC
-- tracking endpoint precisely to discover which tenant a request belongs to —
-- before any tenant context exists, because the slug is the only thing known.
-- The policy therefore matched nothing and every lookup returned "Tenant not
-- found". Chicken-and-egg: you need the tenant id to read the tenant row, and
-- the read is how you learn the id.
--
-- Fixed with a SECURITY DEFINER function that exposes EXACTLY ONE mapping —
-- public slug to opaque uuid — and nothing else. Deliberately not a broader RLS
-- policy: RLS is row-level, not column-level, so "let anyone read the id and
-- slug" would in fact expose each tenant's name, plan, status and timezone to
-- every other tenant.
--
-- What this discloses is that a given slug exists, which the tracking URL
-- already states, and a uuid that is useless without a signed token.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION resolve_tenant_id_by_slug(p_slug TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
-- ⚠️ Mandatory on every SECURITY DEFINER function. Without a pinned search_path
-- a caller can create their own `tenants` in a schema earlier on the path and
-- have this function read it with the owner's privileges.
SET search_path = public, pg_temp
AS $$
  SELECT id FROM tenants WHERE slug = p_slug AND status = 'ACTIVE';
$$;

COMMENT ON FUNCTION resolve_tenant_id_by_slug(TEXT) IS
  'Public slug to tenant id, for unauthenticated entry points that must discover '
  'the tenant before any context exists. Returns nothing for a suspended tenant.';

-- SECURITY DEFINER functions are executable by PUBLIC by default; that would let
-- any role reach it, including future least-privilege roles that have no
-- business resolving tenants.
REVOKE ALL ON FUNCTION resolve_tenant_id_by_slug(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant_id_by_slug(TEXT) TO dp_app;
