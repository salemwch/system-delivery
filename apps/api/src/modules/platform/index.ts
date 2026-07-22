/**
 * Platform context public API (docs/04-context-map.md §3.1).
 *
 * Cross-cutting mechanics only — no business rules. Everything other modules
 * may use from `platform` is exported here; nothing else is reachable.
 */
export { tenants, tenantFeatures } from "./domain/schema.js";
export type { Tenant, NewTenant, TenantFeature, NewTenantFeature } from "./domain/schema.js";
