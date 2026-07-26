import { Injectable } from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";

import { DatabaseService } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { codRemittances, ledgerAccounts, ledgerEntries } from "../domain/schema.js";

/** A driver's current cash liability. */
export interface DriverCashHolding {
  readonly driverId: string;
  readonly balanceMinor: bigint;
}

/** "How much cash is out there right now?" (docs/01-mvp-scope.md §9.1, §4.5.5). */
export interface CashInField {
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly drivers: readonly DriverCashHolding[];
}

/** A day's COD movement — the daily reconciliation report (§4.5.6). */
export interface DailyReconciliation {
  readonly date: string;
  readonly currency: string;
  readonly collectedMinor: bigint;
  readonly remittedMinor: bigint;
  readonly varianceMinor: bigint;
  /** Collected minus remitted — cash that moved to drivers but not yet to hubs. */
  readonly outstandingMinor: bigint;
}

/**
 * Read models over the ledger (docs/01-mvp-scope.md §4.5). Query-only — it never
 * writes. Every figure derives from `ledger_*` and `cod_remittances`, so it is the
 * ledger's own truth, not a parallel tally that could drift.
 *
 * `cash_in_field` and the daily reconciliation are headline MVP metrics: the
 * platform must be able to answer "how much cash is in drivers' hands right now?"
 * and "did today reconcile?" at any moment (§9).
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly database: DatabaseService) {}

  /** Total (and per-driver) cash currently held by drivers — not yet remitted. */
  async cashInField(currency: string): Promise<CashInField> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ driverId: ledgerAccounts.ownerId, balanceMinor: ledgerAccounts.balanceMinor })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.accountType, "DRIVER_CASH"),
            eq(ledgerAccounts.currency, currency),
            ne(ledgerAccounts.balanceMinor, 0n),
          ),
        );
      let totalMinor = 0n;
      for (const row of rows) {
        totalMinor += row.balanceMinor;
      }
      return { currency, totalMinor, drivers: rows };
    });
  }

  /** Total the courier owes merchants (the MERCHANT_PAYABLE balance). */
  async outstandingMerchantPayable(currency: string): Promise<bigint> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({
          total: sql<string>`coalesce(sum(${ledgerAccounts.balanceMinor}), 0)`,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.accountType, "MERCHANT_PAYABLE"),
            eq(ledgerAccounts.currency, currency),
          ),
        );
      return BigInt(rows[0]?.total ?? "0");
    });
  }

  /** COD collected, remitted, and net variance for one calendar day (UTC date). */
  async dailyReconciliation(date: string, currency: string): Promise<DailyReconciliation> {
    return this.database.withTenant(async (tx) => {
      const collectedMinor = await this.sumEntries(tx, "COD_COLLECTED", currency, date);
      const remittedMinor = await this.sumEntries(tx, "COD_REMITTED", currency, date);

      const varianceRows = await tx
        .select({
          total: sql<string>`coalesce(sum(${codRemittances.varianceMinor}), 0)`,
        })
        .from(codRemittances)
        .where(
          and(
            eq(codRemittances.currency, currency),
            eq(codRemittances.status, "CONFIRMED"),
            sql`${codRemittances.confirmedAt}::date = ${date}`,
          ),
        );
      const varianceMinor = BigInt(varianceRows[0]?.total ?? "0");

      return {
        date,
        currency,
        collectedMinor,
        remittedMinor,
        varianceMinor,
        outstandingMinor: collectedMinor - remittedMinor,
      };
    });
  }

  /**
   * Sums the DEBIT leg of an entry type on a day. Each COD transaction has exactly
   * one debit of the full amount (driver_cash for collection, hub_cash for
   * remittance), so the debit side is the movement total without double-counting.
   */
  private async sumEntries(
    tx: TenantTransaction,
    entryType: "COD_COLLECTED" | "COD_REMITTED",
    currency: string,
    date: string,
  ): Promise<bigint> {
    const rows = await tx
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}), 0)` })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.entryType, entryType),
          eq(ledgerEntries.direction, "DEBIT"),
          eq(ledgerEntries.currency, currency),
          sql`${ledgerEntries.occurredAt}::date = ${date}`,
        ),
      );
    return BigInt(rows[0]?.total ?? "0");
  }
}
