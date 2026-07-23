import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Dispatch module schema (docs/02-domain-model.md §3.9–3.10,
 * docs/06-database-design.md §4.5).
 *
 * The authoritative DDL — RLS policies, grants, the DEFERRABLE unique on
 * (route_id, sequence), the partial one-IN_PROGRESS-per-driver index, and the
 * PostGIS geography columns — is migration `0009_dispatch.sql`. These definitions
 * give the query builder its types; they are not the source of truth.
 */

/**
 * PostGIS `geography(Point,4326)`. postgres.js returns geography as hex WKB, so
 * these columns are always written via `ST_MakePoint` and read via `ST_Y`/`ST_X`
 * in SQL expressions — never as a bare value (the same pattern the directory,
 * network, and shipment modules use; repeated here rather than imported across a
 * module boundary, which the layering forbids).
 */
const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

/** `geography(LineString,4326)` — the planned path, set by the optimiser. */
const geographyLineString = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(LineString,4326)";
  },
});

export const routes = pgTable(
  "routes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Human-readable, unique per tenant (R-YYYYMMDD-NNN). */
    code: text("code").notNull(),
    /** Null while DRAFT; required to PUBLISH. */
    driverId: uuid("driver_id"),
    vehicleId: uuid("vehicle_id"),
    startHubId: uuid("start_hub_id"),
    endHubId: uuid("end_hub_id"),
    plannedDate: text("planned_date").notNull(),
    /** DRAFT | OPTIMIZING | PUBLISHED | IN_PROGRESS | COMPLETED | CANCELLED. */
    status: text("status").notNull().default("DRAFT"),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }),
    actualStartAt: timestamp("actual_start_at", { withTimezone: true }),
    actualEndAt: timestamp("actual_end_at", { withTimezone: true }),
    /** Metres and seconds — never mixed units. */
    plannedDistanceM: integer("planned_distance_m"),
    plannedDurationS: integer("planned_duration_s"),
    actualDistanceM: integer("actual_distance_m"),
    actualDurationS: integer("actual_duration_s"),
    stopCount: integer("stop_count").notNull().default(0),
    polyline: geographyLineString("polyline"),
    optimizationJobId: uuid("optimization_job_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("routes_tenant_code_uq").on(table.tenantId, table.code),
    index("routes_driver_date_idx").on(table.tenantId, table.driverId, table.plannedDate),
    index("routes_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const routeStops = pgTable(
  "route_stops",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    routeId: uuid("route_id").notNull(),
    sequence: smallint("sequence").notNull(),
    /** PICKUP | DELIVERY | HUB_LOAD | HUB_UNLOAD | BREAK. */
    type: text("type").notNull(),
    addressId: uuid("address_id"),
    hubId: uuid("hub_id"),
    location: geographyPoint("location"),
    /** PENDING | ARRIVED | COMPLETED | FAILED | SKIPPED. */
    status: text("status").notNull().default("PENDING"),
    locked: boolean("locked").notNull().default(false),
    plannedArrivalAt: timestamp("planned_arrival_at", { withTimezone: true }),
    plannedDepartureAt: timestamp("planned_departure_at", { withTimezone: true }),
    actualArrivalAt: timestamp("actual_arrival_at", { withTimezone: true }),
    actualDepartureAt: timestamp("actual_departure_at", { withTimezone: true }),
    serviceDurationS: integer("service_duration_s").notNull().default(0),
    /** The shipment legs served here — by ID, never by object. */
    legIds: uuid("leg_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    timeWindowFrom: timestamp("time_window_from", { withTimezone: true }),
    timeWindowTo: timestamp("time_window_to", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("route_stops_route_sequence_uq").on(table.routeId, table.sequence),
    index("route_stops_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const optimizationJobs = pgTable(
  "optimization_jobs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    routeId: uuid("route_id").notNull(),
    /** PENDING | RUNNING | SUCCEEDED | FAILED. */
    status: text("status").notNull().default("PENDING"),
    /** OSRM_NN_2OPT | HAVERSINE_NN_2OPT | MANUAL. */
    solver: text("solver").notNull(),
    usedFallback: boolean("used_fallback").notNull().default(false),
    solveDurationMs: integer("solve_duration_ms"),
    plannedDistanceM: integer("planned_distance_m"),
    plannedDurationS: integer("planned_duration_s"),
    stopCount: integer("stop_count"),
    constraintsViolated: jsonb("constraints_violated")
      .notNull()
      .default(sql`'[]'::jsonb`),
    error: text("error"),
    requestedByUserId: uuid("requested_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("optimization_jobs_route_idx").on(table.tenantId, table.routeId)],
);

export type Route = typeof routes.$inferSelect;
export type NewRoute = typeof routes.$inferInsert;
export type RouteStop = typeof routeStops.$inferSelect;
export type NewRouteStop = typeof routeStops.$inferInsert;
export type OptimizationJob = typeof optimizationJobs.$inferSelect;
export type NewOptimizationJob = typeof optimizationJobs.$inferInsert;
