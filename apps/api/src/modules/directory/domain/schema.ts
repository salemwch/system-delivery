import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Directory module schema (docs/04-context-map.md §3.3).
 *
 * The authoritative DDL — RLS policies, grants, spatial indexes, constraints —
 * is migration `0005_directory.sql`. These definitions give the query builder
 * its types; they are not the source of truth.
 */

/**
 * PostGIS `geography(Point,4326)`.
 *
 * postgres.js returns geography as hex WKB, which is not directly useful, so
 * `location` is always read via `ST_Y`/`ST_X` and written via `ST_MakePoint` in
 * SQL expressions — never as a bare column value. This type exists so the column
 * carries the correct DDL type and can appear in `sql` expressions.
 */
const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Exactly what the merchant sent — never overwritten. */
    rawInput: text("raw_input").notNull(),
    normalisedLine1: text("normalised_line1"),
    normalisedLine2: text("normalised_line2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    countryCode: text("country_code"),
    location: geographyPoint("location"),
    /** 0.000–1.000. Low confidence blocks auto-dispatch. NULL ⇒ 0. */
    geocodeConfidence: numeric("geocode_confidence"),
    geocodeSource: text("geocode_source").notNull().default("none"),
    timezone: text("timezone"),
    accessNotes: text("access_notes"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("addresses_tenant_postal_idx").on(table.tenantId, table.countryCode, table.postalCode),
    index("addresses_tenant_idx").on(table.tenantId),
  ],
);

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    /** Tenant-facing reference; unique within the tenant when present. */
    code: text("code"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    defaultPickupAddressId: uuid("default_pickup_address_id"),
    /** ACTIVE | SUSPENDED. Suspended blocks new pickups (domain §3.18). */
    status: text("status").notNull().default("ACTIVE"),
    blockReason: text("block_reason"),
    settings: jsonb("settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("merchants_tenant_code_uq")
      .on(table.tenantId, table.code)
      .where(sql`code IS NOT NULL`),
    index("merchants_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const recipients = pgTable(
  "recipients",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    fullName: text("full_name").notNull(),
    /** E.164. The natural key — the phone is the identity in MENA. */
    phone: text("phone").notNull(),
    phoneAlt: text("phone_alt"),
    defaultAddressId: uuid("default_address_id"),
    preferredLanguage: text("preferred_language"),
    notes: text("notes"),
    /** Projections rebuilt from shipment_events — never incremented ad hoc. */
    totalShipments: integer("total_shipments").notNull().default(0),
    successfulDeliveries: integer("successful_deliveries").notNull().default(0),
    failedDeliveries: integer("failed_deliveries").notNull().default(0),
    lastShipmentAt: timestamp("last_shipment_at", { withTimezone: true }),
    isBlocked: boolean("is_blocked").notNull().default(false),
    blockReason: text("block_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("recipients_tenant_phone_uq").on(table.tenantId, table.phone),
    index("recipients_tenant_blocked_idx").on(table.tenantId, table.isBlocked),
  ],
);

export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;
export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type Recipient = typeof recipients.$inferSelect;
export type NewRecipient = typeof recipients.$inferInsert;
