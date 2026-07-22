-- Corrects Row-Level Security on the `tenants` registry.
--
-- 0000 applied FORCE ROW LEVEL SECURITY to `tenants` together with a SELECT-only
-- policy. FORCE subjects the table OWNER to policies as well, so with no INSERT
-- policy the effect was that NOBODY could create a tenant — not the application,
-- not the control plane, not even dp_migrator:
--
--   ERROR: new row violates row-level security policy for table "tenants"
--
-- The distinction that was missing:
--
--   * Tenant-scoped DATA tables (tenant_features, and every table that follows)
--     get ENABLE + FORCE. Nobody, including the owner, may read across tenants.
--
--   * The tenant REGISTRY itself is control-plane data. It must be manageable by
--     the provisioning path, which runs as dp_migrator. It gets ENABLE without
--     FORCE: the owner manages the registry, while dp_app — which is not the
--     owner and has no BYPASSRLS — remains restricted to its own row by the
--     existing SELECT policy.
--
-- Migrations are immutable once applied (the runner verifies a checksum), so
-- this is a forward fix rather than an edit to 0000.

ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;

-- Row-level security stays ENABLED: dp_app is still confined to its own row.
-- Re-asserted here so the intent is explicit rather than inherited.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE tenants IS
  'Tenant registry (control plane). RLS ENABLED but NOT FORCED: dp_migrator provisions tenants; dp_app reads only its own row via tenants_self_read.';

COMMENT ON TABLE tenant_features IS
  'Tenant-scoped data. RLS ENABLED and FORCED: no role, including the owner, may read or write across tenants.';
