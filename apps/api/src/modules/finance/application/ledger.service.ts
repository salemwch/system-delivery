import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { DatabaseService } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError } from "../../../shared/errors/index.js";
import {
  asNormalBalance,
  balanceDelta,
  normalBalanceFor,
  toAccountType,
  toDirection,
  toOwnerType,
} from "../domain/ledger.js";
import type {
  AccountType,
  Direction,
  EntryType,
  NormalBalance,
  OwnerType,
} from "../domain/ledger.js";
import { ledgerAccounts, ledgerEntries } from "../domain/schema.js";

/** Identifies the account a posting line touches; resolved to a row by owner. */
export interface AccountRef {
  readonly ownerType: OwnerType;
  readonly ownerId: string;
  readonly accountType: AccountType;
}

/** One side of a transaction. `amountMinor` is always positive; direction signs it. */
export interface PostingLine {
  readonly account: AccountRef;
  readonly direction: Direction;
  readonly amountMinor: bigint;
}

export interface PostTransactionInput {
  readonly tenantId: string;
  readonly entryType: EntryType;
  readonly currency: string;
  readonly lines: readonly PostingLine[];
  readonly occurredAt?: Date;
  readonly description?: string;
  /** The domain event that produced this transaction; makes re-posting idempotent. */
  readonly sourceEventId?: string;
  readonly shipmentId?: string;
  readonly remittanceId?: string;
  readonly settlementId?: string;
  readonly createdByUserId?: string;
}

/**
 * The single sanctioned writer of `ledger_entries` (docs/02-domain-model.md §3.15
 * rule 7 — entries are only ever created by domain operations, never a direct
 * write). It enforces the accounting invariants in application code for a clear
 * error, backed by the database's own deferred zero-sum trigger as the hard
 * guarantee:
 *
 *   - at least two lines, every amount strictly positive;
 *   - total debits equal total credits (balanced);
 *   - all lines share one currency (the caller's).
 *
 * Accounts are created on demand by owner — a driver/hub/merchant account springs
 * into existence the first time money moves through it. This respects the module
 * layering (finance is Layer 3; it cannot reach up into fleet/directory to create
 * an account atomically with the driver) and avoids event-ordering fragility: the
 * account is guaranteed to exist exactly when the ledger needs it.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Posts a balanced transaction inside the caller's tenant-scoped tx. Returns the
   * `transactionId` that groups its entries. Runs inside the SAME transaction as
   * the business change (or the consumer's idempotent handler), never its own.
   */
  async postTransaction(tx: TenantTransaction, input: PostTransactionInput): Promise<string> {
    this.assertBalanced(input.lines);

    const transactionId = randomUUID();
    const occurredAt = input.occurredAt ?? new Date();

    for (const line of input.lines) {
      const account = await this.ensureAccount(tx, input.tenantId, input.currency, line.account);

      await tx.insert(ledgerEntries).values({
        tenantId: input.tenantId,
        transactionId,
        accountId: account.id,
        direction: line.direction,
        amountMinor: line.amountMinor,
        currency: input.currency,
        entryType: input.entryType,
        occurredAt,
        description: input.description ?? "",
        ...(input.shipmentId === undefined ? {} : { shipmentId: input.shipmentId }),
        ...(input.remittanceId === undefined ? {} : { remittanceId: input.remittanceId }),
        ...(input.settlementId === undefined ? {} : { settlementId: input.settlementId }),
        ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
        ...(input.createdByUserId === undefined ? {} : { createdBy: input.createdByUserId }),
      });

      // Keep the cached balance in step. The truth remains SUM(entries); this is
      // the reconciled cache (domain §3.14 rule 2). Atomic per row under its lock.
      const delta = balanceDelta(account.normalBalance, line.direction, line.amountMinor);
      await tx
        .update(ledgerAccounts)
        .set({
          balanceMinor: sql`${ledgerAccounts.balanceMinor} + ${delta}`,
          updatedAt: sql`now()`,
        })
        .where(eq(ledgerAccounts.id, account.id));
    }

    return transactionId;
  }

  /**
   * Reads posted entries back, resolved to their account references.
   *
   * Exists so a REVERSAL can mirror what was actually posted rather than
   * recomputing it. Those differ more often than one would like: a partial
   * collection, a later adjustment, a shipment whose COD was edited before
   * delivery. Reversing a recomputed figure leaves the ledger balanced against
   * itself but wrong against reality, which is the harder error to find.
   *
   * Joins to `ledger_accounts` because a reversal needs the owner triple, not the
   * opaque `account_id` — `postTransaction` resolves accounts by reference.
   */
  async entriesFor(
    tx: TenantTransaction,
    filter: { readonly shipmentId: string; readonly entryType: EntryType },
  ): Promise<
    readonly {
      readonly account: AccountRef;
      readonly direction: Direction;
      readonly amountMinor: bigint;
      readonly currency: string;
    }[]
  > {
    const rows = await tx
      .select({
        ownerType: ledgerAccounts.ownerType,
        ownerId: ledgerAccounts.ownerId,
        accountType: ledgerAccounts.accountType,
        direction: ledgerEntries.direction,
        amountMinor: ledgerEntries.amountMinor,
        currency: ledgerEntries.currency,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(
        and(
          eq(ledgerEntries.shipmentId, filter.shipmentId),
          eq(ledgerEntries.entryType, filter.entryType),
        ),
      )
      .orderBy(ledgerEntries.id);

    return rows.map((row) => ({
      account: {
        // TEXT columns behind CHECK constraints; narrowed on the way out so an
        // unrecognised value fails here rather than deep inside a posting.
        ownerType: toOwnerType(row.ownerType),
        ownerId: row.ownerId,
        accountType: toAccountType(row.accountType),
      },
      direction: toDirection(row.direction),
      amountMinor: row.amountMinor,
      currency: row.currency,
    }));
  }

  /**
   * True if a transaction has already been posted for this event — the ledger's
   * own idempotency check, independent of the consumer's `processed_events` ledger,
   * so a redelivery cannot double-post cash even if the two commits interleave.
   */
  async hasPostedForEvent(
    tx: TenantTransaction,
    tenantId: string,
    eventId: string,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.sourceEventId, eventId)))
      .limit(1);
    return rows.length > 0;
  }

  /** The cached balance of an account, or 0 when it has never been touched. */
  async balanceOf(
    tx: TenantTransaction,
    tenantId: string,
    currency: string,
    ref: AccountRef,
  ): Promise<bigint> {
    const rows = await tx
      .select({ balance: ledgerAccounts.balanceMinor })
      .from(ledgerAccounts)
      .where(this.accountWhere(tenantId, currency, ref))
      .limit(1);
    return rows[0]?.balance ?? 0n;
  }

  /** Finds the account for an owner, creating it on first use. Idempotent under races. */
  private async ensureAccount(
    tx: TenantTransaction,
    tenantId: string,
    currency: string,
    ref: AccountRef,
  ): Promise<{ id: string; normalBalance: NormalBalance }> {
    const existing = await tx
      .select({ id: ledgerAccounts.id, normalBalance: ledgerAccounts.normalBalance })
      .from(ledgerAccounts)
      .where(this.accountWhere(tenantId, currency, ref))
      .limit(1);
    const found = existing[0];
    if (found !== undefined) {
      return { id: found.id, normalBalance: asNormalBalance(found.normalBalance) };
    }

    const normalBalance = normalBalanceFor(ref.accountType);
    const inserted = await tx
      .insert(ledgerAccounts)
      .values({
        tenantId,
        accountType: ref.accountType,
        ownerType: ref.ownerType,
        ownerId: ref.ownerId,
        currency,
        normalBalance,
      })
      .onConflictDoNothing({
        target: [
          ledgerAccounts.tenantId,
          ledgerAccounts.accountType,
          ledgerAccounts.ownerType,
          ledgerAccounts.ownerId,
          ledgerAccounts.currency,
        ],
      })
      .returning({ id: ledgerAccounts.id });
    const created = inserted[0];
    if (created !== undefined) {
      return { id: created.id, normalBalance };
    }

    // A concurrent caller created it between our select and insert — re-read.
    const reselected = await tx
      .select({ id: ledgerAccounts.id, normalBalance: ledgerAccounts.normalBalance })
      .from(ledgerAccounts)
      .where(this.accountWhere(tenantId, currency, ref))
      .limit(1);
    const row = reselected[0];
    if (row === undefined) {
      throw new Error("ensureAccount: account not found after ON CONFLICT DO NOTHING");
    }
    return { id: row.id, normalBalance: asNormalBalance(row.normalBalance) };
  }

  private accountWhere(tenantId: string, currency: string, ref: AccountRef) {
    return and(
      eq(ledgerAccounts.tenantId, tenantId),
      eq(ledgerAccounts.accountType, ref.accountType),
      eq(ledgerAccounts.ownerType, ref.ownerType),
      eq(ledgerAccounts.ownerId, ref.ownerId),
      eq(ledgerAccounts.currency, currency),
    );
  }

  private assertBalanced(lines: readonly PostingLine[]): void {
    if (lines.length < 2) {
      throw new BusinessRuleError(
        "LEDGER_UNBALANCED",
        "A ledger transaction needs at least two entries",
      );
    }
    let debits = 0n;
    let credits = 0n;
    for (const line of lines) {
      if (line.amountMinor <= 0n) {
        throw new BusinessRuleError(
          "LEDGER_INVALID_AMOUNT",
          "Ledger amounts must be positive; the direction carries the sign",
        );
      }
      if (line.direction === "DEBIT") {
        debits += line.amountMinor;
      } else {
        credits += line.amountMinor;
      }
    }
    if (debits !== credits) {
      throw new BusinessRuleError(
        "LEDGER_UNBALANCED",
        `Ledger transaction is not balanced: debits ${debits.toString()} != credits ${credits.toString()}`,
      );
    }
  }
}
