import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Custody module schema (docs/02-domain-model.md §3.11).
 *
 * The authoritative DDL — CHECK constraints, the I14 immutability trigger, RLS
 * policies, grants — is migration `0017_manifests.sql`. These definitions give
 * the query builder its types; they are not the source of truth.
 */

export const manifests = pgTable(
  "manifests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    code: text("code").notNull(),

    type: text("type").notNull(),
    status: text("status").notNull().default("OPEN"),

    fromHubId: uuid("from_hub_id"),
    toHubId: uuid("to_hub_id"),
    fromDriverId: uuid("from_driver_id"),
    toDriverId: uuid("to_driver_id"),
    vehicleId: uuid("vehicle_id"),

    itemCount: integer("item_count").notNull().default(0),
    discrepancyCount: integer("discrepancy_count").notNull().default(0),

    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    sealedByUserId: uuid("sealed_by_user_id"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedByUserId: uuid("received_by_user_id"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("manifests_tenant_code_uq").on(table.tenantId, table.code),
    index("manifests_tenant_status_idx").on(table.tenantId, table.status),
    index("manifests_from_hub_idx").on(table.tenantId, table.fromHubId),
    index("manifests_to_hub_idx").on(table.tenantId, table.toHubId, table.status),
  ],
);

export type Manifest = typeof manifests.$inferSelect;
export type NewManifest = typeof manifests.$inferInsert;

export const manifestItems = pgTable(
  "manifest_items",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    manifestId: uuid("manifest_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    legId: uuid("leg_id"),
    trackingNumber: text("tracking_number").notNull(),

    scanStatus: text("scan_status").notNull().default("EXPECTED"),
    /** Device clock — when the operator physically scanned the parcel. */
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    /** Server clock — when the scan reached us. Later than `scannedAt` offline. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    scannedByUserId: uuid("scanned_by_user_id"),
    idempotencyKey: text("idempotency_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("manifest_items_manifest_shipment_uq").on(table.manifestId, table.shipmentId),
    uniqueIndex("manifest_items_idempotency_uq").on(table.manifestId, table.idempotencyKey),
    index("manifest_items_manifest_idx").on(table.tenantId, table.manifestId),
    index("manifest_items_shipment_idx").on(table.tenantId, table.shipmentId),
    index("manifest_items_tracking_idx").on(table.tenantId, table.manifestId, table.trackingNumber),
  ],
);

export type ManifestItem = typeof manifestItems.$inferSelect;
export type NewManifestItem = typeof manifestItems.$inferInsert;

export const manifestDiscrepancies = pgTable(
  "manifest_discrepancies",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    manifestId: uuid("manifest_id").notNull(),

    kind: text("kind").notNull(),
    /** Null when an unexpected barcode cannot be resolved to a known shipment. */
    shipmentId: uuid("shipment_id"),
    trackingNumber: text("tracking_number").notNull(),

    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    raisedByUserId: uuid("raised_by_user_id").notNull(),

    resolutionReason: text("resolution_reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id"),
  },
  (table) => [
    uniqueIndex("manifest_discrepancies_manifest_tracking_uq").on(
      table.manifestId,
      table.trackingNumber,
    ),
    index("manifest_discrepancies_manifest_idx").on(table.tenantId, table.manifestId),
  ],
);

export type ManifestDiscrepancy = typeof manifestDiscrepancies.$inferSelect;
export type NewManifestDiscrepancy = typeof manifestDiscrepancies.$inferInsert;
