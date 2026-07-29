// DatabaseModule is NOT re-exported here on purpose. It imports AppConfigModule,
// whose evaluation runs eager environment validation (see config/index.ts). If
// the barrel re-exported it, importing `DatabaseService` — which nearly every
// service does — would drag that validation in and throw under test. The
// composition root imports DatabaseModule directly from ./database.module.js.
export { DatabaseService } from "./database.service.js";
export { isUniqueViolation, isForeignKeyViolation, isCheckViolation } from "./pg-errors.js";
export { POSTGRES_CLIENT } from "./database.tokens.js";
export { TenantContext, asTenantId, NO_TENANT } from "./tenant-context.js";
export type { Database, TenantTransaction } from "./database.service.js";
export type { TenantId, TenantContextState } from "./tenant-context.js";
