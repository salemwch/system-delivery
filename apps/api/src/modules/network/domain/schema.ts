import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Network module schema (docs/02-domain-model.md §3.4,
 * docs/06-database-design.md §6).
 *
 * The authoritative DDL — RLS policies, grants, GIST indexes, constraints — is
 * migration `0007_network.sql`. These definitions give the query builder its
 * types; they are not the source of truth.
 */

/**
 * PostGIS `geography(Point,4326)`. Always read via `ST_Y`/`ST_X` and written via
 * `ST_MakePoint` in `sql` expressions — never as a bare value.
 */
const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

/** PostGIS `geography(MultiPolygon,4326)` — a zone territory. Written/read via SQL. */
const geographyMultiPolygon = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(MultiPolygon,4326)";
  },
});

export const zones = pgTable(
  "zones",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    boundary: geographyMultiPolygon("boundary").notNull(),
    /** Per-zone default arrival radius in metres (hotspot H6). */
    defaultGeofenceRadiusM: integer("default_geofence_radius_m").notNull().default(150),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("zones_tenant_code_uq").on(table.tenantId, table.code),
    index("zones_tenant_active_idx").on(table.tenantId, table.active),
  ],
);

export const hubs = pgTable(
  "hubs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Short operational code, unique per tenant, e.g. TUN-01. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** SORTING_CENTER | DISTRIBUTION_CENTER | PICKUP_POINT. */
    type: text("type").notNull(),
    addressId: uuid("address_id").notNull(),
    /** Denormalised from the address for proximity queries. */
    location: geographyPoint("location").notNull(),
    /** IANA — mandatory; cut-offs and SLA windows are local time (rule 2). */
    timezone: text("timezone").notNull(),
    parentHubId: uuid("parent_hub_id"),
    serviceZoneIds: uuid("service_zone_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    cutoffTimes: jsonb("cutoff_times")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** FK → HUB_CASH LedgerAccount; nullable until the finance module exists. */
    cashAccountId: uuid("cash_account_id"),
    /** ACTIVE | INACTIVE — the lifecycle; a hub is never hard-deleted. */
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("hubs_tenant_code_uq").on(table.tenantId, table.code),
    index("hubs_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const geofences = pgTable(
  "geofences",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    /** HUB | STOP | ZONE | CUSTOM — the target kind. */
    kind: text("kind").notNull(),
    hubId: uuid("hub_id"),
    addressId: uuid("address_id"),
    zoneId: uuid("zone_id"),
    centre: geographyPoint("centre").notNull(),
    radiusM: integer("radius_m").notNull(),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("geofences_tenant_active_idx").on(table.tenantId, table.active)],
);

export type Zone = typeof zones.$inferSelect;
export type NewZone = typeof zones.$inferInsert;
export type Hub = typeof hubs.$inferSelect;
export type NewHub = typeof hubs.$inferInsert;
export type Geofence = typeof geofences.$inferSelect;
export type NewGeofence = typeof geofences.$inferInsert;
