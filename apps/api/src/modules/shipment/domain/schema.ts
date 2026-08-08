import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Shipment module schema (docs/02-domain-model.md §3.6–3.8, §3.24,
 * docs/06-database-design.md §4.1–4.3, §4.6).
 *
 * The authoritative DDL — RLS policies, grants (the append-only enforcement on
 * shipment_events and pod), constraints, and indexes — is migration
 * `0006_shipment.sql`. These definitions give the query builder its types; they
 * are not the source of truth.
 */

/**
 * PostGIS `geography(Point,4326)`. postgres.js returns geography as hex WKB, so
 * `location` columns are always read via `ST_Y`/`ST_X` and written via
 * `ST_MakePoint` in SQL expressions — never as a bare value (see the directory
 * module for the same pattern; this repeats it rather than importing across a
 * module boundary, which the layering forbids).
 */
const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geography(Point,4326)";
  },
});

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Generated, non-sequential, immutable, unique per tenant (rule 10). */
    trackingNumber: text("tracking_number").notNull(),
    merchantId: uuid("merchant_id"),
    externalReference: text("external_reference"),
    recipientId: uuid("recipient_id"),
    /** PROJECTION of shipment_events — never written outside the sanctioned writer. */
    status: text("status").notNull().default("CREATED"),
    serviceLevel: text("service_level").notNull().default("STANDARD"),
    senderName: text("sender_name").notNull(),
    senderPhone: text("sender_phone").notNull(),
    originAddressId: uuid("origin_address_id").notNull(),
    /** Snapshot of the recipient at creation — history must not be rewritable. */
    recipientName: text("recipient_name").notNull(),
    recipientPhone: text("recipient_phone").notNull(),
    recipientPhoneAlt: text("recipient_phone_alt"),
    destinationAddressId: uuid("destination_address_id").notNull(),
    promisedFrom: timestamp("promised_from", { withTimezone: true }),
    promisedTo: timestamp("promised_to", { withTimezone: true }),
    etaAt: timestamp("eta_at", { withTimezone: true }),
    weightGrams: integer("weight_grams").notNull().default(0),
    volumeCm3: integer("volume_cm3"),
    parcelCount: integer("parcel_count").notNull().default(1),
    declaredValueMinor: bigint("declared_value_minor", { mode: "bigint" }),
    /** ISO 4217 alphabetic. Minor-unit scale comes from the currencies table. */
    currency: char("currency", { length: 3 }).notNull(),
    /** 0 when not COD. Never a boolean. Frozen once past PICKED_UP (rule 5). */
    codAmountMinor: bigint("cod_amount_minor", { mode: "bigint" }).notNull().default(0n),
    codStatus: text("cod_status").notNull().default("NOT_APPLICABLE"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    maxAttempts: smallint("max_attempts").notNull().default(3),
    /**
     * When the next delivery attempt may be made (migration 0026), computed from
     * the tenant working calendar. NULL when no further attempt is due —
     * delivered, returning, refused, or attempts exhausted.
     */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    priority: smallint("priority").notNull().default(0),
    requiredSkills: text("required_skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    currentCustodyType: text("current_custody_type"),
    currentCustodyId: uuid("current_custody_id"),
    customFields: jsonb("custom_fields")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** High-water mark of the per-shipment event sequence (bumped under row lock). */
    lastSequence: bigint("last_sequence", { mode: "bigint" }).notNull().default(0n),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shipments_tenant_tracking_uq").on(table.tenantId, table.trackingNumber),
    index("shipments_tenant_status_idx").on(table.tenantId, table.status),
    index("shipments_tenant_merchant_idx").on(table.tenantId, table.merchantId),
    index("shipments_tenant_recipient_idx").on(table.tenantId, table.recipientId),
  ],
);

export const shipmentLegs = pgTable(
  "shipment_legs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    legNumber: smallint("leg_number").notNull(),
    legType: text("leg_type").notNull(),
    status: text("status").notNull().default("PLANNED"),
    fromType: text("from_type").notNull(),
    toType: text("to_type").notNull(),
    fromAddressId: uuid("from_address_id"),
    toAddressId: uuid("to_address_id"),
    fromHubId: uuid("from_hub_id"),
    toHubId: uuid("to_hub_id"),
    routeStopId: uuid("route_stop_id"),
    manifestId: uuid("manifest_id"),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }),
    actualStartAt: timestamp("actual_start_at", { withTimezone: true }),
    actualEndAt: timestamp("actual_end_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shipment_legs_shipment_number_uq").on(table.shipmentId, table.legNumber),
    index("shipment_legs_tenant_shipment_idx").on(table.tenantId, table.shipmentId),
  ],
);

export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    eventType: text("event_type").notNull(),
    /** Device/physical time — when it actually happened. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Server-receipt time — may be much later for an offline event. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    location: geographyPoint("location"),
    locationAccuracyM: real("location_accuracy_m"),
    hubId: uuid("hub_id"),
    driverId: uuid("driver_id"),
    routeId: uuid("route_id"),
    legId: uuid("leg_id"),
    reasonCode: text("reason_code"),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shipment_events_shipment_sequence_uq").on(table.shipmentId, table.sequence),
    uniqueIndex("shipment_events_tenant_idempotency_uq").on(table.tenantId, table.idempotencyKey),
    index("shipment_events_tenant_occurred_idx").on(table.tenantId, table.occurredAt),
  ],
);

export const pod = pgTable(
  "pod",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    podType: text("pod_type").notNull(),
    signatureObjectKey: text("signature_object_key"),
    photoObjectKeys: text("photo_object_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contentHash: text("content_hash"),
    recipientName: text("recipient_name").notNull(),
    recipientRelationship: text("recipient_relationship"),
    otpVerified: boolean("otp_verified").notNull().default(false),
    capturedLocation: geographyPoint("captured_location"),
    distanceFromDestinationM: integer("distance_from_destination_m"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    deviceMetadata: jsonb("device_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pod_shipment_uq").on(table.shipmentId),
    index("pod_tenant_idx").on(table.tenantId),
  ],
);

/**
 * Modification Colis — requested changes to a parcel (migration 0038).
 *
 * A request, not an update: the person who wants the change is usually not the
 * person who should decide it. Typed columns rather than a JSONB patch, because
 * a patch cannot be CHECK-constrained and turns "what did they ask to change?"
 * into a question only the application can answer.
 */
export const shipmentAmendments = pgTable(
  "shipment_amendments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    /** PENDING | APPLIED | REJECTED. */
    status: text("status").notNull().default("PENDING"),
    reason: text("reason"),
    /** NULL means "leave this field alone"; at least one must be set. */
    recipientName: text("recipient_name"),
    recipientPhone: text("recipient_phone"),
    recipientPhoneAlt: text("recipient_phone_alt"),
    /** Geocoded on APPLY, not on request — an unapproved address costs nothing. */
    destinationRawInput: text("destination_raw_input"),
    destinationCity: text("destination_city"),
    codAmountMinor: bigint("cod_amount_minor", { mode: "bigint" }),
    /** What the shipment held before this was applied. */
    previous: jsonb("previous"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id"),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shipment_amendments_one_pending_uq").on(table.shipmentId),
    index("shipment_amendments_queue_idx").on(table.tenantId, table.createdAt),
    index("shipment_amendments_shipment_idx").on(table.shipmentId, table.createdAt),
  ],
);

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;
export type ShipmentLeg = typeof shipmentLegs.$inferSelect;
export type NewShipmentLeg = typeof shipmentLegs.$inferInsert;
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof shipmentEvents.$inferInsert;
export type Pod = typeof pod.$inferSelect;
export type NewPod = typeof pod.$inferInsert;
export type ShipmentAmendment = typeof shipmentAmendments.$inferSelect;
export type NewShipmentAmendment = typeof shipmentAmendments.$inferInsert;
