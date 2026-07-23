import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  pgTable,
  smallint,
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

/**
 * Global ISO 4217 reference. NOT tenant-scoped (domain §1) — one row per currency,
 * holding the minor-unit exponent every money conversion reads. Seeded by the
 * migration; read-only to the app.
 */
export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  exponent: smallint("exponent").notNull(),
  name: text("name").notNull(),
  symbol: text("symbol"),
});

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

export type Currency = typeof currencies.$inferSelect;
export type LedgerAccount = typeof ledgerAccounts.$inferSelect;
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
