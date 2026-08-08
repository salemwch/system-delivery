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
 * Finance context schema (docs/02-domain-model.md §3.14–3.16). The authoritative
 * DDL — RLS, the append-only REVOKE, the deferred zero-sum trigger — lives in
 * migration 0012_finance.sql; these give the query builder its types.
 */

// `currencies` is ISO 4217 REFERENCE data and lives in `shared/money` — it is a
// property of the currency, not of the ledger, and `shipment` needs it to print a
// COD amount on a delivery note. finance owns every table that records a MOVEMENT
// of money; this one records none.

/**
 * A named balance container per (tenant, type, owner, currency). `balanceMinor` is
 * a cache reconciled against SUM(entries); drift is a P1 alert (domain §3.14 r2).
 */
export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    accountType: text("account_type").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    currency: text("currency").notNull(),
    balanceMinor: bigint("balance_minor", { mode: "bigint" }).notNull().default(0n),
    normalBalance: text("normal_balance").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ledger_accounts_owner_uq").on(
      table.tenantId,
      table.accountType,
      table.ownerType,
      table.ownerId,
      table.currency,
    ),
    index("ledger_accounts_tenant_idx").on(table.tenantId),
  ],
);

/**
 * One side of one money movement. Immutable, append-only (migration REVOKEs
 * UPDATE/DELETE). `amountMinor` is always positive; `direction` carries the sign.
 * Every `transactionId` group sums to zero per currency (deferred DB trigger).
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    transactionId: uuid("transaction_id").notNull(),
    accountId: uuid("account_id").notNull(),
    direction: text("direction").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    entryType: text("entry_type").notNull(),
    shipmentId: uuid("shipment_id"),
    remittanceId: uuid("remittance_id"),
    settlementId: uuid("settlement_id"),
    reversalOfEntryId: uuid("reversal_of_entry_id"),
    /** The domain event that produced this entry; the idempotency backstop keys on it. */
    sourceEventId: uuid("source_event_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    description: text("description").notNull().default(""),
  },
  (table) => [
    index("ledger_entries_account_idx").on(table.tenantId, table.accountId, table.occurredAt),
    index("ledger_entries_transaction_idx").on(table.transactionId),
    uniqueIndex("ledger_entries_source_event_uq")
      .on(table.tenantId, table.sourceEventId, table.accountId, table.direction)
      .where(sql`source_event_id IS NOT NULL`),
  ],
);

/**
 * A driver → hub cash handoff (domain §3.13). Records expected/declared/counted
 * separately so shrinkage is attributable; confirmation posts the ledger by the
 * counted amount. Never deleted (migration REVOKEs DELETE). RLS+FORCE.
 */
export const codRemittances = pgTable(
  "cod_remittances",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    code: text("code").notNull(),
    driverId: uuid("driver_id").notNull(),
    hubId: uuid("hub_id").notNull(),
    receivedByUserId: uuid("received_by_user_id"),
    status: text("status").notNull().default("SUBMITTED"),
    expectedAmountMinor: bigint("expected_amount_minor", { mode: "bigint" }).notNull(),
    declaredAmountMinor: bigint("declared_amount_minor", { mode: "bigint" }).notNull(),
    countedAmountMinor: bigint("counted_amount_minor", { mode: "bigint" }),
    varianceMinor: bigint("variance_minor", { mode: "bigint" }).notNull().default(0n),
    currency: text("currency").notNull(),
    shipmentIds: uuid("shipment_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    varianceReason: text("variance_reason"),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("cod_remittances_code_uq").on(table.tenantId, table.code),
    index("cod_remittances_driver_idx").on(table.tenantId, table.driverId, table.status),
    index("cod_remittances_hub_idx").on(table.tenantId, table.hubId, table.status),
  ],
);

export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type CodRemittance = typeof codRemittances.$inferSelect;
export type NewCodRemittance = typeof codRemittances.$inferInsert;

/**
 * A merchant COD payout for a period (domain §3.16). Ledger posts on PAID. Never
 * deleted (migration REVOKEs DELETE). RLS+FORCE. The approver-≠-drafter separation
 * of duties is a CHECK plus a service guard.
 */
export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id").notNull(),
    code: text("code").notNull(),
    status: text("status").notNull().default("DRAFT"),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    grossCodAmountMinor: bigint("gross_cod_amount_minor", { mode: "bigint" }).notNull(),
    deliveryFeesMinor: bigint("delivery_fees_minor", { mode: "bigint" }).notNull().default(0n),
    adjustmentsMinor: bigint("adjustments_minor", { mode: "bigint" }).notNull().default(0n),
    netPayableMinor: bigint("net_payable_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    shipmentCount: integer("shipment_count").notNull().default(0),
    paymentMethod: text("payment_method"),
    paymentReference: text("payment_reference"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    approvedByUserId: uuid("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("settlements_code_uq").on(table.tenantId, table.code),
    index("settlements_merchant_idx").on(table.tenantId, table.merchantId, table.status),
  ],
);

/**
 * The shipments a settlement covers. The unique index on (tenant_id, shipment_id)
 * enforces at-most-one-settlement-per-shipment (domain §3.16 rule 2).
 */
export const settlementShipments = pgTable(
  "settlement_shipments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    settlementId: uuid("settlement_id").notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("settlement_shipments_shipment_uq").on(table.tenantId, table.shipmentId),
    index("settlement_shipments_settlement_idx").on(table.settlementId),
  ],
);

export type Settlement = typeof settlements.$inferSelect;
export type NewSettlement = typeof settlements.$inferInsert;
export type SettlementShipment = typeof settlementShipments.$inferSelect;
export type NewSettlementShipment = typeof settlementShipments.$inferInsert;

// ── Invoicing ────────────────────────────────────────────────────────────────
//
// Authoritative DDL — gapless numbering, the immutability triggers, and RLS —
// lives in migration 0032_invoices.sql. These give the query builder its types.

export const billingSettings = pgTable("billing_settings", {
  tenantId: uuid("tenant_id").primaryKey(),
  /** TVA in basis points: 1900 = 19.00%. An integer, never a float. */
  vatRateBp: integer("vat_rate_bp").notNull().default(1900),
  /** Timbre fiscal, charged once per invoice. Minor units. */
  stampDutyMinor: bigint("stamp_duty_minor", { mode: "bigint" }).notNull().default(1000n),
  legalName: text("legal_name"),
  taxIdentifier: text("tax_identifier"),
  legalAddress: text("legal_address"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Gapless counters, one row per (tenant, kind, year).
 *
 * Not a Postgres sequence: `nextval()` does not roll back, and a gap in a tax
 * number series reads as a destroyed invoice.
 */
export const invoiceSequences = pgTable("invoice_sequences", {
  tenantId: uuid("tenant_id").notNull(),
  kind: text("kind").notNull(),
  year: integer("year").notNull(),
  lastNumber: integer("last_number").notNull().default(0),
});

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id").notNull(),
    /** INVOICE | CREDIT_NOTE — separate legal series sharing no numbers. */
    kind: text("kind").notNull().default("INVOICE"),
    /** NULL until issued: an abandoned draft consumes no number. */
    number: text("number"),
    numberYear: integer("number_year"),
    /** DRAFT | ISSUED | PAID | CANCELLED. Never deleted. */
    status: text("status").notNull().default("DRAFT"),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    currency: text("currency").notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull().default(0n),
    vatRateBp: integer("vat_rate_bp").notNull(),
    vatAmountMinor: bigint("vat_amount_minor", { mode: "bigint" }).notNull().default(0n),
    stampDutyMinor: bigint("stamp_duty_minor", { mode: "bigint" }).notNull().default(0n),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull().default(0n),
    /** Snapshot at issue: the document must still print correctly in five years. */
    sellerName: text("seller_name"),
    sellerTaxId: text("seller_tax_id"),
    sellerAddress: text("seller_address"),
    buyerName: text("buyer_name"),
    buyerTaxId: text("buyer_tax_id"),
    buyerAddress: text("buyer_address"),
    correctsInvoiceId: uuid("corrects_invoice_id"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    issuedByUserId: uuid("issued_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invoices_tenant_number_uq")
      .on(table.tenantId, table.kind, table.number)
      .where(sql`number IS NOT NULL`),
    index("invoices_tenant_merchant_idx").on(table.tenantId, table.merchantId, table.createdAt),
    index("invoices_tenant_status_idx").on(table.tenantId, table.status, table.createdAt),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    /** 1-based: it is printed on the document. */
    position: integer("position").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invoice_lines_position_uq").on(table.invoiceId, table.position),
    index("invoice_lines_invoice_idx").on(table.invoiceId),
  ],
);

export type BillingSettings = typeof billingSettings.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type NewInvoiceLine = typeof invoiceLines.$inferInsert;
