import { pgTable, smallint, text } from "drizzle-orm/pg-core";

/**
 * Global ISO 4217 reference. NOT tenant-scoped (domain §1) — one row per currency,
 * holding the minor-unit exponent every money conversion reads. Seeded by
 * migration 0012_finance.sql; read-only to the app.
 *
 * ⚠️ In `shared/`, not owned by `finance`. This is REFERENCE data, not ledger
 * data: the exponent is a property of the currency itself, and a delivery note
 * printing "12.500 TND" needs it just as much as a settlement does. It carries no
 * `tenant_id` and no RLS, so there is nothing about it for a bounded context to
 * own. `finance` still owns every table that records a movement of money.
 */
export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(),
  exponent: smallint("exponent").notNull(),
  name: text("name").notNull(),
  symbol: text("symbol"),
});

export type Currency = typeof currencies.$inferSelect;
