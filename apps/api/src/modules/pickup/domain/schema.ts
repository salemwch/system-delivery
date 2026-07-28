import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Pickup module schema (docs/02-domain-model.md §3.18).
 *
 * The authoritative DDL — RLS policies, grants, constraints — is migrations
 * `0015_pickup_requests.sql` and `0016_pickup_shipments.sql`. These definitions
 * give the query builder its types; they are not the source of truth.
 */

export const pickupRequests = pgTable(
  "pickup_requests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    code: text("code").notNull(),
    merchantId: uuid("merchant_id").notNull(),
    status: text("status").notNull().default("REQUESTED"),

    pickupAddressId: uuid("pickup_address_id").notNull(),
    contactName: text("contact_name").notNull(),
    contactPhone: text("contact_phone").notNull(),

    requestedWindowFrom: timestamp("requested_window_from", { withTimezone: true }).notNull(),
    requestedWindowTo: timestamp("requested_window_to", { withTimezone: true }).notNull(),

    estimatedParcelCount: integer("estimated_parcel_count").notNull(),
    actualParcelCount: integer("actual_parcel_count"),

    selectionMode: text("selection_mode").notNull().default("EXPLICIT"),
    outcomeReason: text("outcome_reason"),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),

    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id"),

    assignedDriverId: uuid("assigned_driver_id"),
    assignedRouteStopId: uuid("assigned_route_stop_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),

    collectedAt: timestamp("collected_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pickup_requests_tenant_code_uq").on(table.tenantId, table.code),
    index("pickup_requests_tenant_status_idx").on(table.tenantId, table.status),
    index("pickup_requests_tenant_merchant_idx").on(table.tenantId, table.merchantId),
    index("pickup_requests_driver_idx")
      .on(table.assignedDriverId)
      .where(sql`assigned_driver_id IS NOT NULL`),
    index("pickup_requests_tenant_window_idx").on(
      table.tenantId,
      table.requestedWindowFrom,
      table.requestedWindowTo,
    ),
  ],
);

export type PickupRequest = typeof pickupRequests.$inferSelect;
export type NewPickupRequest = typeof pickupRequests.$inferInsert;

export const pickupShipments = pgTable(
  "pickup_shipments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    pickupRequestId: uuid("pickup_request_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    trackingNumber: text("tracking_number").notNull(),

    scanStatus: text("scan_status").notNull().default("EXPECTED"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    scannedByDriverId: uuid("scanned_by_driver_id"),
    idempotencyKey: text("idempotency_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pickup_shipments_pickup_shipment_uq").on(table.pickupRequestId, table.shipmentId),
    uniqueIndex("pickup_shipments_idempotency_uq").on(table.pickupRequestId, table.idempotencyKey),
    index("pickup_shipments_pickup_idx").on(table.tenantId, table.pickupRequestId),
    index("pickup_shipments_shipment_idx").on(table.tenantId, table.shipmentId),
    index("pickup_shipments_tracking_idx").on(
      table.tenantId,
      table.pickupRequestId,
      table.trackingNumber,
    ),
  ],
);

export type PickupShipment = typeof pickupShipments.$inferSelect;
export type NewPickupShipment = typeof pickupShipments.$inferInsert;
