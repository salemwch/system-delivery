import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Support module schema.
 *
 * The authoritative DDL — RLS (including the internal-message predicate), the
 * CHECK constraints and the composite foreign keys — is migration
 * `0039_support.sql`. These definitions give the query builder its types; they
 * are not the source of truth.
 */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Human-quotable, sequential per tenant per year: `S-2026-00042`. */
    reference: text("reference").notNull(),
    subject: text("subject").notNull(),
    /** OPEN | PENDING_MERCHANT | RESOLVED | CLOSED. */
    status: text("status").notNull().default("OPEN"),
    /** BILLING | PICKUP | DELIVERY | ACCOUNT | TECHNICAL | OTHER. */
    category: text("category").notNull().default("OTHER"),
    /** Always set — this is the merchant support channel. */
    merchantId: uuid("merchant_id").notNull(),
    shipmentId: uuid("shipment_id"),
    openedByUserId: uuid("opened_by_user_id").notNull(),
    assignedToUserId: uuid("assigned_to_user_id"),
    /** Denormalised from the thread so the queue sorts without aggregating. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("support_tickets_reference_uq").on(table.tenantId, table.reference),
    index("support_tickets_queue_idx").on(table.tenantId, table.lastMessageAt),
    index("support_tickets_merchant_idx").on(table.merchantId, table.lastMessageAt),
  ],
);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    ticketId: uuid("ticket_id").notNull(),
    body: text("body").notNull(),
    /** PUBLIC | INTERNAL. RLS hides INTERNAL from a merchant login. */
    visibility: text("visibility").notNull().default("PUBLIC"),
    authorUserId: uuid("author_user_id").notNull(),
    /** MERCHANT | COURIER — denormalised so the thread renders without a join. */
    authorSide: text("author_side").notNull(),
    attachmentKeys: text("attachment_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("support_messages_thread_idx").on(table.ticketId, table.createdAt)],
);

export const supportTicketSequences = pgTable("support_ticket_sequences", {
  tenantId: uuid("tenant_id").notNull(),
  year: integer("year").notNull(),
  lastNumber: integer("last_number").notNull().default(0),
});

export type SupportTicket = typeof supportTickets.$inferSelect;
export type NewSupportTicket = typeof supportTickets.$inferInsert;
export type SupportMessage = typeof supportMessages.$inferSelect;
export type NewSupportMessage = typeof supportMessages.$inferInsert;
