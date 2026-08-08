import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, lt, lte, sql, sum } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { AuditService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  createExpenseCategorySchema,
  createExpenseSchema,
  expenseSummarySchema,
  listExpensesSchema,
  rejectExpenseSchema,
  updateExpenseCategorySchema,
} from "../domain/expense-dtos.js";
import { expenseCategories, expenses } from "../domain/expense-schema.js";
import type { Expense, ExpenseCategory } from "../domain/expense-schema.js";
import { LedgerService } from "./ledger.service.js";

export interface ExpensePage {
  readonly items: readonly Expense[];
  readonly nextCursor: string | null;
}

/** One line of the spend report. */
export interface ExpenseSummaryRow {
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly count: number;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Les dépenses — what the courier spends.
 *
 * ⚠️ AN APPROVED EXPENSE POSTS A REAL DOUBLE-ENTRY TRANSACTION, and that is the
 * reason this exists rather than a spreadsheet: money paid out of a hub's cash
 * box reduces what that box holds, which is the same figure `cashInField`
 * reconciles against. An untracked fuel payment shows up as a hub being short,
 * and the manager gets asked where the money went when the answer is "into the
 * tank of the van outside".
 *
 * DEBIT EXPENSE (spending rises), CREDIT the source (HUB_CASH or BANK).
 */
@Injectable()
export class ExpenseService {
  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  // ── Categories ─────────────────────────────────────────────────────────────

  async createCategory(input: unknown): Promise<ExpenseCategory> {
    const dto = parseWithZod(createExpenseCategorySchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const inserted = await tx
          .insert(expenseCategories)
          .values({
            tenantId,
            code: dto.code.toUpperCase(),
            name: dto.name,
            ...(dto.nameAr === undefined ? {} : { nameAr: dto.nameAr }),
          })
          .returning();
        return requireRow(inserted, "Expense category insert returned no row");
      });
    } catch (error) {
      if (isUniqueViolation(error, "expense_categories_code_uq")) {
        throw new ConflictError(
          "EXPENSE_CATEGORY_CODE_TAKEN",
          `Category code "${dto.code}" is already in use.`,
        );
      }
      throw error;
    }
  }

  async updateCategory(id: string, input: unknown): Promise<ExpenseCategory> {
    const dto = parseWithZod(updateExpenseCategorySchema, input);

    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(expenseCategories)
        .set({
          updatedAt: sql`now()`,
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.nameAr === undefined ? {} : { nameAr: dto.nameAr }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
        })
        .where(eq(expenseCategories.id, id))
        .returning();
      return requireRow(updated, "Expense category not found");
    });
  }

  async listCategories(activeOnly = false): Promise<readonly ExpenseCategory[]> {
    return this.database.withTenant(async (tx) =>
      tx
        .select()
        .from(expenseCategories)
        .where(activeOnly ? eq(expenseCategories.active, true) : undefined)
        .orderBy(asc(expenseCategories.code)),
    );
  }

  // ── Expenses ───────────────────────────────────────────────────────────────

  /**
   * Records what was spent. DRAFT — nothing reaches the ledger yet.
   *
   * Deliberately two steps even though most couriers will approve their own
   * entries: the person holding the receipt is often not the person who answers
   * for the month's numbers, and an expense that posted on entry could not be
   * corrected without a reversing ledger transaction.
   */
  async create(input: unknown, actorUserId: string): Promise<Expense> {
    const dto = parseWithZod(createExpenseSchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const year = new Date().getUTCFullYear();
        const reference = `DEP-${String(year)}-${String(
          await nextExpenseNumber(tx, tenantId, year),
        ).padStart(5, "0")}`;

        const inserted = await tx
          .insert(expenses)
          .values({
            tenantId,
            reference,
            categoryId: dto.categoryId,
            amountMinor: BigInt(dto.amountMinor),
            currency: dto.currency,
            spentOn: dto.spentOn,
            description: dto.description,
            paidFrom: dto.paidFrom,
            recordedByUserId: actorUserId,
            ...(dto.receiptKey === undefined ? {} : { receiptKey: dto.receiptKey }),
            ...(dto.supplierReference === undefined
              ? {}
              : { supplierReference: dto.supplierReference }),
            ...(dto.driverId === undefined ? {} : { driverId: dto.driverId }),
            ...(dto.vehicleId === undefined ? {} : { vehicleId: dto.vehicleId }),
            ...(dto.hubId === undefined ? {} : { hubId: dto.hubId }),
            ...(dto.paidFromHubId === undefined ? {} : { paidFromHubId: dto.paidFromHubId }),
          })
          .returning();

        return requireRow(inserted, "Expense insert returned no row");
      });
    } catch (error) {
      // The commonest error in expense bookkeeping: two people both enter the
      // fuel bill and the month is overstated.
      if (isUniqueViolation(error, "expenses_supplier_reference_uq")) {
        throw new ConflictError(
          "EXPENSE_ALREADY_RECORDED",
          `Supplier reference "${dto.supplierReference ?? ""}" has already been recorded.`,
        );
      }
      throw error;
    }
  }

  /**
   * Approve: the expense posts to the ledger.
   *
   * The posting and the status change share ONE transaction. A ledger entry with
   * no approved expense behind it, or an approved expense the accounts never
   * saw, are both worse than a failed approval the operator can retry.
   */
  async approve(id: string, actorUserId: string): Promise<Expense> {
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const expense = await this.requireDraft(tx, id);

      // ⚠️ CREDIT the source of the funds. HUB_CASH means the box holds less —
      // exactly what `cashInField` needs to know. BANK is a tenant-level
      // account, so the owner is the tenant itself.
      const source =
        expense.paidFrom === "HUB_CASH"
          ? {
              accountType: "HUB_CASH" as const,
              ownerType: "HUB" as const,
              // Guaranteed by `expenses_cash_source_chk`; the fallback would be
              // a silent mis-post, so it throws instead.
              ownerId: requireHub(expense.paidFromHubId),
            }
          : {
              accountType: "BANK" as const,
              ownerType: "TENANT" as const,
              ownerId: tenantId,
            };

      const transactionId = await this.ledger.postTransaction(tx, {
        tenantId,
        entryType: "EXPENSE",
        currency: expense.currency,
        description: `${expense.reference} — ${expense.description}`,
        createdByUserId: actorUserId,
        lines: [
          {
            account: { accountType: "EXPENSE", ownerType: "TENANT", ownerId: tenantId },
            direction: "DEBIT",
            amountMinor: expense.amountMinor,
          },
          { account: source, direction: "CREDIT", amountMinor: expense.amountMinor },
        ],
      });

      const updated = await tx
        .update(expenses)
        .set({
          status: "APPROVED",
          transactionId,
          approvedByUserId: actorUserId,
          approvedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        // Re-check the status inside the UPDATE: two approvers who both passed
        // the read above would otherwise post the transaction twice.
        .where(and(eq(expenses.id, id), eq(expenses.status, "DRAFT")))
        .returning();

      const row = updated[0];
      if (row === undefined) {
        throw new BusinessRuleError(
          "EXPENSE_ALREADY_DECIDED",
          "This expense was decided by someone else while you were reviewing it.",
        );
      }

      await this.audit.record(tx, {
        action: "expense.approved",
        resourceType: "expense",
        resourceId: id,
        changes: { status: { from: "DRAFT", to: "APPROVED" } },
        context: {
          reference: expense.reference,
          amountMinor: expense.amountMinor.toString(),
          currency: expense.currency,
          paidFrom: expense.paidFrom,
          transactionId,
        },
      });

      return row;
    });
  }

  async reject(id: string, input: unknown, actorUserId: string): Promise<Expense> {
    const dto = parseWithZod(rejectExpenseSchema, input);

    return this.database.withTenant(async (tx) => {
      const expense = await this.requireDraft(tx, id);

      const updated = await tx
        .update(expenses)
        .set({
          status: "REJECTED",
          approvedByUserId: actorUserId,
          approvedAt: sql`now()`,
          decisionReason: dto.reason,
          updatedAt: sql`now()`,
        })
        .where(and(eq(expenses.id, id), eq(expenses.status, "DRAFT")))
        .returning();

      const row = updated[0];
      if (row === undefined) {
        throw new BusinessRuleError(
          "EXPENSE_ALREADY_DECIDED",
          "This expense was decided by someone else while you were reviewing it.",
        );
      }

      await this.audit.record(tx, {
        action: "expense.rejected",
        resourceType: "expense",
        resourceId: id,
        changes: { status: { from: "DRAFT", to: "REJECTED" } },
        context: { reference: expense.reference, reason: dto.reason },
      });

      return row;
    });
  }

  async getById(id: string): Promise<Expense> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(expenses).where(eq(expenses.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Expense");
      }
      return row;
    });
  }

  async list(input: unknown = {}): Promise<ExpensePage> {
    const dto = parseWithZod(listExpensesSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;

    return this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        ...(dto.status === undefined ? [] : [eq(expenses.status, dto.status)]),
        ...(dto.categoryId === undefined ? [] : [eq(expenses.categoryId, dto.categoryId)]),
        ...(dto.hubId === undefined ? [] : [eq(expenses.hubId, dto.hubId)]),
        ...(dto.vehicleId === undefined ? [] : [eq(expenses.vehicleId, dto.vehicleId)]),
        ...(dto.from === undefined ? [] : [gte(expenses.spentOn, dto.from)]),
        ...(dto.to === undefined ? [] : [lte(expenses.spentOn, dto.to)]),
        ...(dto.cursor === undefined ? [] : [lt(expenses.id, dto.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(expenses)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(expenses.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /** How many are waiting for a decision, for the sidebar badge. */
  async pendingCount(): Promise<number> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ pending: count() })
        .from(expenses)
        .where(eq(expenses.status, "DRAFT"));
      return Number(rows[0]?.pending ?? 0);
    });
  }

  /**
   * Approved spend per category over a period.
   *
   * ⚠️ APPROVED ONLY. A draft is a claim somebody made, not money that left the
   * business, and including it would make the report disagree with the ledger —
   * which is the one thing a spend report must never do.
   *
   * Grouped by currency as well as category: a total that added dinars to euros
   * would be a number with no meaning.
   */
  async summary(input: unknown): Promise<readonly ExpenseSummaryRow[]> {
    const dto = parseWithZod(expenseSummarySchema, input);

    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({
          categoryId: expenses.categoryId,
          categoryCode: expenseCategories.code,
          categoryName: expenseCategories.name,
          currency: expenses.currency,
          totalMinor: sum(expenses.amountMinor),
          count: count(),
        })
        .from(expenses)
        .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
        .where(
          and(
            eq(expenses.status, "APPROVED"),
            gte(expenses.spentOn, dto.from),
            lte(expenses.spentOn, dto.to),
          ),
        )
        .groupBy(
          expenses.categoryId,
          expenseCategories.code,
          expenseCategories.name,
          expenses.currency,
        )
        .orderBy(asc(expenseCategories.code));

      return rows.map((row) => ({
        categoryId: row.categoryId,
        categoryCode: row.categoryCode,
        categoryName: row.categoryName,
        currency: row.currency,
        // `sum()` returns a string — the value can exceed a double, and Drizzle
        // will not silently narrow it. Parsed as a bigint, never as a number.
        totalMinor: BigInt(row.totalMinor ?? "0"),
        count: Number(row.count),
      }));
    });
  }

  private async requireDraft(tx: TenantTransaction, id: string): Promise<Expense> {
    const rows = await tx.select().from(expenses).where(eq(expenses.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Expense");
    }
    if (row.status !== "DRAFT") {
      throw new BusinessRuleError(
        "EXPENSE_ALREADY_DECIDED",
        `This expense is already ${row.status.toLowerCase()}.`,
      );
    }
    return row;
  }
}

/** The next reference for a tenant-year, from a row-locked counter. */
async function nextExpenseNumber(
  tx: TenantTransaction,
  tenantId: string,
  year: number,
): Promise<number> {
  await tx.execute(sql`
    insert into expense_sequences (tenant_id, year, last_number)
    values (${tenantId}, ${year}, 0)
    on conflict (tenant_id, year) do nothing
  `);

  const locked = await tx.execute<{ last_number: number }>(sql`
    select last_number from expense_sequences
     where tenant_id = ${tenantId} and year = ${year}
       for update
  `);

  const next = Number(locked[0]?.last_number ?? 0) + 1;

  await tx.execute(sql`
    update expense_sequences set last_number = ${next}
     where tenant_id = ${tenantId} and year = ${year}
  `);

  return next;
}

/**
 * The hub a cash expense left.
 *
 * Guaranteed non-null by `expenses_cash_source_chk`; throwing rather than
 * defaulting because the alternative — crediting the wrong account — is a
 * silent mis-post that only surfaces at reconciliation.
 */
function requireHub(hubId: string | null): string {
  if (hubId === null) {
    throw new Error("A HUB_CASH expense has no paid_from_hub_id");
  }
  return hubId;
}

function requireRow<T>(rows: readonly T[], message: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError(message);
  }
  return row;
}
