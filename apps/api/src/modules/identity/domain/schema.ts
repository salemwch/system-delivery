import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { tenants } from "../../platform/index.js";

/**
 * Identity module schema.
 *
 * The authoritative DDL — RLS policies, grants, constraints — lives in
 * apps/api/migrations/0002_identity.sql. These definitions give the query
 * builder its types.
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Unique per tenant, not globally (docs/02-domain-model.md §3.2 rule 1). */
    email: text("email").notNull(),
    phone: text("phone"),
    passwordHash: text("password_hash").notNull(),
    fullName: text("full_name").notNull(),
    locale: text("locale").notNull().default("fr"),
    status: text("status").notNull().default("INVITED"),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    /** Encrypted at rest by the application before it reaches this column. */
    mfaSecret: text("mfa_secret"),
    /** Restricts a Dispatcher or Hub Operator to specific hubs. Empty = all. */
    hubScope: uuid("hub_scope")
      .array()
      .notNull()
      .default(sql`ARRAY[]::UUID[]`),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("users_tenant_status_idx").on(table.tenantId, table.status)],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedBy: uuid("granted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_roles_user_role_uq").on(table.userId, table.role),
    index("user_roles_tenant_idx").on(table.tenantId),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Groups a rotation chain. Reuse of a rotated token revokes the family. */
    familyId: uuid("family_id").notNull(),
    /** SHA-256 of the token. The token itself is never stored. */
    tokenDigest: text("token_digest").notNull(),
    actorType: text("actor_type").notNull().default("user"),
    deviceId: text("device_id"),
    userAgent: text("user_agent"),
    ipAddress: inet("ip_address"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("refresh_tokens_digest_uq").on(table.tokenDigest),
    index("refresh_tokens_family_idx").on(table.familyId),
  ],
);
