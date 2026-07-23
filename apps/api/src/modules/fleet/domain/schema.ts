import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Fleet module schema (docs/02-domain-model.md §3.3, §3.5, §3.21).
 *
 * The authoritative DDL — RLS, grants, the partial one-open-shift unique indexes,
 * and the PII-ciphertext columns — is migration `0008_fleet.sql`. These
 * definitions give the query builder its types; they are not the source of truth.
 */

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    plateNumber: text("plate_number").notNull(),
    /** MOTORCYCLE | CAR | VAN | TRUCK. */
    type: text("type").notNull(),
    make: text("make"),
    model: text("model"),
    year: integer("year"),
    capacityWeightGrams: integer("capacity_weight_grams").notNull().default(0),
    capacityVolumeCm3: integer("capacity_volume_cm3").notNull().default(0),
    capacityParcels: integer("capacity_parcels").notNull().default(0),
    features: text("features")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    homeHubId: uuid("home_hub_id"),
    /** ACTIVE | MAINTENANCE | INACTIVE — the lifecycle; never hard-deleted. */
    status: text("status").notNull().default("ACTIVE"),
    insuranceExpiryAt: date("insurance_expiry_at"),
    inspectionExpiryAt: date("inspection_expiry_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("vehicles_tenant_plate_uq").on(table.tenantId, table.plateNumber),
    index("vehicles_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const drivers = pgTable(
  "drivers",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id"),
    employeeCode: text("employee_code").notNull(),
    fullName: text("full_name").notNull(),
    /** E.164. Unique per tenant — the driver's primary auth identity. */
    phone: text("phone").notNull(),
    /** AES-256-GCM ciphertext (v1:iv:tag:ct). Never plaintext at rest. */
    nationalIdEncrypted: text("national_id_encrypted"),
    licenceNumberEncrypted: text("licence_number_encrypted"),
    licenceExpiryAt: date("licence_expiry_at"),
    /** PENDING | ACTIVE | INACTIVE | SUSPENDED. */
    status: text("status").notNull().default("PENDING"),
    employmentType: text("employment_type").notNull(),
    homeHubId: uuid("home_hub_id"),
    defaultVehicleId: uuid("default_vehicle_id"),
    skills: text("skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** FK → DRIVER_CASH LedgerAccount; nullable until the finance module exists. */
    cashAccountId: uuid("cash_account_id"),
    locale: text("locale").notNull().default("fr"),
    deviceId: text("device_id"),
    appVersion: text("app_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("drivers_tenant_employee_uq").on(table.tenantId, table.employeeCode),
    uniqueIndex("drivers_tenant_phone_uq").on(table.tenantId, table.phone),
    index("drivers_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    driverId: uuid("driver_id").notNull(),
    vehicleId: uuid("vehicle_id").notNull(),
    hubId: uuid("hub_id"),
    /** OPEN | CLOSED. At most one OPEN per driver and per vehicle (partial uniques). */
    status: text("status").notNull().default("OPEN"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    startOdometer: integer("start_odometer"),
    endOdometer: integer("end_odometer"),
    openingCashMinor: bigint("opening_cash_minor", { mode: "bigint" }),
    closingCashMinor: bigint("closing_cash_minor", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("shifts_driver_time_idx").on(table.tenantId, table.driverId, table.startedAt)],
);

export type Vehicle = typeof vehicles.$inferSelect;
export type NewVehicle = typeof vehicles.$inferInsert;
export type Driver = typeof drivers.$inferSelect;
export type NewDriver = typeof drivers.$inferInsert;
export type Shift = typeof shifts.$inferSelect;
export type NewShift = typeof shifts.$inferInsert;
