import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Note module schema.
 *
 * The authoritative DDL — the exclusive-subject CHECK, the immutability trigger,
 * RLS, and the partial indexes — is migration `0035_notes.sql`. These definitions
 * give the query builder its types; they are not the source of truth.
 */
export const notes = pgTable(
  "notes",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Exactly one of the three is set — enforced by `notes_one_subject_chk`. */
    shipmentId: uuid("shipment_id"),
    merchantId: uuid("merchant_id"),
    driverId: uuid("driver_id"),
    body: text("body").notNull(),
    authorUserId: uuid("author_user_id").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notes_tenant_open_idx").on(table.tenantId, table.createdAt),
    index("notes_shipment_idx").on(table.shipmentId, table.pinned, table.createdAt),
    index("notes_merchant_idx").on(table.merchantId, table.pinned, table.createdAt),
    index("notes_driver_idx").on(table.driverId, table.pinned, table.createdAt),
  ],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
