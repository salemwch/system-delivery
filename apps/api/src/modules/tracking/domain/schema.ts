import {
  boolean,
  customType,
  doublePrecision,
  index,
  pgTable,
  real,
  smallint,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Tracking module schema (docs/06-database-design.md §5.1).
 *
 * The authoritative DDL — the hypertable, its dimensions, the retention policy,
 * RLS and grants — is migration `0018_driver_positions.sql`. These definitions
 * give the query builder its types; they are not the source of truth.
 */

/**
 * PostGIS geography. Declared as a custom type because Drizzle has no native
 * one, and because a raw geography column must never be SELECTed directly
 * (docs/traps.md) — reads project it through `ST_X`/`ST_Y` instead.
 */
const geography = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

export const driverPositions = pgTable(
  "driver_positions",
  {
    /** Device clock — when the driver was at this point, not when we heard. */
    time: timestamp("time", { withTimezone: true }).notNull(),
    tenantId: uuid("tenant_id").notNull(),
    driverId: uuid("driver_id").notNull(),
    routeId: uuid("route_id"),

    /** The raw observation as the device reported it. */
    lon: doublePrecision("lon").notNull(),
    lat: doublePrecision("lat").notNull(),

    /**
     * Derived by the database from lon/lat — never written by the application.
     * Reads must project it through `ST_X`/`ST_Y`; selecting a raw geography
     * column returns WKB, not coordinates (docs/traps.md).
     */
    location: geography("location").notNull(),

    speedMps: real("speed_mps"),
    headingDeg: real("heading_deg"),
    accuracyM: real("accuracy_m"),
    batteryPct: smallint("battery_pct"),
    isMoving: boolean("is_moving"),
    source: smallint("source"),
  },
  (table) => [
    index("driver_positions_tenant_driver_time_idx").on(table.tenantId, table.driverId, table.time),
    index("driver_positions_tenant_route_time_idx").on(table.tenantId, table.routeId, table.time),
  ],
);

export type DriverPosition = typeof driverPositions.$inferSelect;
export type NewDriverPosition = typeof driverPositions.$inferInsert;
