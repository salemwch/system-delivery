import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Platform module schema.
 *
 * Column naming is snake_case in the database and camelCase in TypeScript, per
 * docs/02-domain-model.md §1. Drizzle maps between them explicitly so neither
 * layer has to compromise.
 *
 * The authoritative DDL — including Row-Level Security policies, grants, and
 * constraints — lives in apps/api/migrations. These definitions give the query
 * builder its types; they are not the source of truth for the schema.
 */

/** docs/02-domain-model.md §3.1 — the root of all isolation. */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    /** URL-safe, globally unique, immutable — appears in tracking URLs. */
    slug: text("slug").notNull(),
    status: text("status").notNull().default("PROVISIONING"),
    countryCode: text("country_code").notNull(),
    /** Immutable once any ledger entry exists (docs §3.1 rule 2). */
    defaultCurrency: text("default_currency").notNull(),
    defaultTimezone: text("default_timezone").notNull(),
    defaultLocale: text("default_locale").notNull().default("fr"),
    supportedLocales: text("supported_locales")
      .array()
      .notNull()
      .default(sql`ARRAY['ar','fr','en']`),
    plan: text("plan").notNull().default("PILOT"),
    region: text("region").notNull().default("eu-central"),
    settings: jsonb("settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tenants_slug_key").on(table.slug),
    index("tenants_status_idx").on(table.status),
  ],
);

/**
 * docs/02-domain-model.md §3.17 — per-tenant capability toggles.
 *
 * This is the entity that prevents `if (tenantId === '...')` spreading through
 * the codebase (invariant I17). It is also the first tenant-scoped table, so it
 * is what the cross-tenant isolation suite exercises.
 */
export const tenantFeatures = pgTable(
  "tenant_features",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** From a compile-time registry, never free text (docs §3.17 rule 1). */
    featureKey: text("feature_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** Why the tenant has it: PLAN | OVERRIDE | TRIAL. */
    source: text("source").notNull().default("PLAN"),
    config: jsonb("config"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Mandatory for OVERRIDE — why this tenant got a manual exception. */
    reason: text("reason"),
    updatedByUserId: uuid("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tenant_features_tenant_key_uq").on(table.tenantId, table.featureKey),
    index("tenant_features_tenant_idx").on(table.tenantId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantFeature = typeof tenantFeatures.$inferSelect;
export type NewTenantFeature = typeof tenantFeatures.$inferInsert;
