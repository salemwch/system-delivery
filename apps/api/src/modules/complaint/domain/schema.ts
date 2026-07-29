import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Complaint module schema (docs/02-domain-model.md §3.20).
 *
 * The authoritative DDL — CHECK constraints (including rule 2, the
 * no-resolution-no-closure rule), RLS with merchant narrowing, and the grants
 * that make the activity trail append-only — is migration `0025_complaints.sql`.
 * These definitions give the query builder its types; they are not the source of
 * truth.
 */

export const complaints = pgTable(
  "complaints",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Human-quotable reference: `RC-20260729-001`. */
    code: text("code").notNull(),

    type: text("type").notNull(),
    status: text("status").notNull().default("OPEN"),
    severity: text("severity").notNull().default("MEDIUM"),

    shipmentId: uuid("shipment_id"),
    /** Drives the RLS merchant narrowing (invariant I24). */
    merchantId: uuid("merchant_id"),
    recipientId: uuid("recipient_id"),
    driverId: uuid("driver_id"),

    raisedByType: text("raised_by_type").notNull(),
    raisedById: uuid("raised_by_id"),

    description: text("description").notNull(),
    /** Object-storage keys only — the bytes live in S3. */
    attachmentKeys: text("attachment_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    assignedToUserId: uuid("assigned_to_user_id"),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }),

    resolution: text("resolution"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id"),

    /** Non-null once a COD_DISPUTE reversal is posted. Stops a second one. */
    reversalTransactionId: uuid("reversal_transaction_id"),
    /** Client-supplied. Unique per tenant — a retry returns the first complaint. */
    idempotencyKey: text("idempotency_key").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("complaints_tenant_code_uq").on(table.tenantId, table.code),
    uniqueIndex("complaints_tenant_idempotency_uq").on(table.tenantId, table.idempotencyKey),
    index("complaints_shipment_idx").on(table.tenantId, table.shipmentId),
    index("complaints_merchant_idx").on(table.tenantId, table.merchantId, table.createdAt),
  ],
);

/**
 * The append-only activity trail (domain §3.20 rule 5).
 *
 * UPDATE and DELETE are revoked from `dp_app`: the history of a dispute must not
 * be rewritable, because a dispute is exactly when it is read.
 */
export const complaintActivity = pgTable(
  "complaint_activity",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    complaintId: uuid("complaint_id").notNull(),

    /** STATUS_CHANGED | COMMENT | ASSIGNED | ATTACHMENT_ADDED | REVERSAL_POSTED. */
    kind: text("kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note"),

    actorType: text("actor_type").notNull().default("STAFF"),
    actorId: uuid("actor_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("complaint_activity_complaint_idx").on(table.complaintId, table.createdAt)],
);

/** Per-tenant SLA hours per complaint type. Config as data, never code. */
export const complaintSlaPolicies = pgTable("complaint_sla_policies", {
  tenantId: uuid("tenant_id").notNull(),
  type: text("type").notNull(),
  dueHours: integer("due_hours").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Complaint = typeof complaints.$inferSelect;
export type NewComplaint = typeof complaints.$inferInsert;
export type ComplaintActivityRow = typeof complaintActivity.$inferSelect;
