import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
 * Expense schema — les dépenses (migration `0040_expenses.sql`).
 *
 * In its own file rather than appended to `schema.ts`: the ledger tables are the
 * accounting core and this is a feed INTO them, so keeping the two apart makes
 * it obvious which is which.
 *
 * The authoritative DDL — RLS, the decision CHECK, the duplicate-invoice index —
 * is the migration. These definitions give the query builder its types.
 */
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Short code an accountant recognises: FUEL, MAINT, RENT. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("expense_categories_code_uq").on(table.tenantId, table.code)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** Human-quotable, sequential per tenant per year: `DEP-2026-00042`. */
    reference: text("reference").notNull(),
    categoryId: uuid("category_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    /** A DATE: nobody records the minute they bought diesel. */
    spentOn: date("spent_on").notNull(),
    description: text("description").notNull(),
    receiptKey: text("receipt_key"),
    /** The supplier's own invoice number — what stops it being entered twice. */
    supplierReference: text("supplier_reference"),
    driverId: uuid("driver_id"),
    vehicleId: uuid("vehicle_id"),
    hubId: uuid("hub_id"),
    /** HUB_CASH | BANK — where the money came from. */
    paidFrom: text("paid_from").notNull(),
    paidFromHubId: uuid("paid_from_hub_id"),
    /** DRAFT | APPROVED | REJECTED. Only APPROVED posts to the ledger. */
    status: text("status").notNull().default("DRAFT"),
    /** The ledger transaction this produced; its presence blocks double-posting. */
    transactionId: uuid("transaction_id"),
    recordedByUserId: uuid("recorded_by_user_id").notNull(),
    approvedByUserId: uuid("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("expenses_reference_uq").on(table.tenantId, table.reference),
    index("expenses_reporting_idx").on(table.tenantId, table.spentOn, table.categoryId),
    index("expenses_vehicle_idx").on(table.vehicleId, table.spentOn),
  ],
);

export const expenseSequences = pgTable("expense_sequences", {
  tenantId: uuid("tenant_id").notNull(),
  year: integer("year").notNull(),
  lastNumber: integer("last_number").notNull().default(0),
});

export type ExpenseCategory = typeof expenseCategories.$inferSelect;
export type NewExpenseCategory = typeof expenseCategories.$inferInsert;
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;
