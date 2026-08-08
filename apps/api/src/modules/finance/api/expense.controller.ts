import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { ExpenseService } from "../application/expense.service.js";
import type { ExpenseSummaryRow } from "../application/expense.service.js";
import {
  EXPENSE_STATUSES,
  createExpenseCategorySchema,
  createExpenseSchema,
  rejectExpenseSchema,
  updateExpenseCategorySchema,
} from "../domain/expense-dtos.js";
import type { Expense, ExpenseCategory } from "../domain/expense-schema.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  categoryId: z.string().min(1).optional(),
  hubId: z.string().min(1).optional(),
  vehicleId: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
});

const summaryQuerySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

interface ExpenseResponse {
  readonly id: string;
  readonly reference: string;
  readonly categoryId: string;
  /** Minor units as a string — JSON has no bigint. */
  readonly amountMinor: string;
  readonly currency: string;
  /** ISO 4217 exponent. TND is 3; a client that assumed 2 misprices tenfold. */
  readonly currencyExponent: number;
  readonly spentOn: string;
  readonly description: string;
  readonly receiptKey: string | null;
  readonly supplierReference: string | null;
  readonly driverId: string | null;
  readonly vehicleId: string | null;
  readonly hubId: string | null;
  readonly paidFrom: string;
  readonly paidFromHubId: string | null;
  readonly status: string;
  readonly transactionId: string | null;
  readonly recordedByUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly decisionReason: string | null;
  readonly createdAt: string;
}

interface CategoryResponse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly active: boolean;
}

interface SummaryRowResponse {
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly totalMinor: string;
  readonly count: number;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Les dépenses.
 *
 * Recording is `expense:record` — the person holding the receipt. Approving is
 * `expense:approve`, and it is the one that posts a real ledger transaction
 * against a cash box, which is why it is a separate permission.
 */
@Controller("v1/expenses")
export class ExpenseController {
  constructor(
    private readonly expenses: ExpenseService,
    private readonly currencies: CurrencyService,
  ) {}

  // ── Categories ─────────────────────────────────────────────────────────────
  //
  // Declared before `:id`, which would otherwise match "categories".

  @Post("categories")
  @RequirePermissions("expense:approve")
  @HttpCode(HttpStatus.CREATED)
  async createCategory(
    @Body(zodBody(createExpenseCategorySchema)) body: z.infer<typeof createExpenseCategorySchema>,
  ): Promise<CategoryResponse> {
    return toCategory(await this.expenses.createCategory(body));
  }

  @Get("categories")
  @RequirePermissions("expense:read")
  async listCategories(
    @Query("activeOnly") activeOnly?: string,
  ): Promise<{ readonly data: readonly CategoryResponse[] }> {
    return { data: (await this.expenses.listCategories(activeOnly === "true")).map(toCategory) };
  }

  @Patch("categories/:id")
  @RequirePermissions("expense:approve")
  async updateCategory(
    @Param("id") id: string,
    @Body(zodBody(updateExpenseCategorySchema)) body: z.infer<typeof updateExpenseCategorySchema>,
  ): Promise<CategoryResponse> {
    return toCategory(await this.expenses.updateCategory(id, body));
  }

  /** Approved spend per category. Declared before `:id` for the same reason. */
  @Get("summary")
  @RequirePermissions("expense:read")
  async summary(@Query() query: unknown): Promise<{ readonly data: readonly SummaryRowResponse[] }> {
    const parsed = summaryQuerySchema.parse(query);
    const rows = await this.expenses.summary(parsed);
    return { data: await this.renderSummary(rows) };
  }

  /** How many await a decision. Declared before `:id`. */
  @Get("count")
  @RequirePermissions("expense:read")
  async count(): Promise<{ readonly pending: number }> {
    return { pending: await this.expenses.pendingCount() };
  }

  // ── Expenses ───────────────────────────────────────────────────────────────

  @Post()
  @RequirePermissions("expense:record")
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(zodBody(createExpenseSchema)) body: z.infer<typeof createExpenseSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ExpenseResponse> {
    return this.render(await this.expenses.create(body, principal.userId));
  }

  @Get()
  @RequirePermissions("expense:read")
  async list(@Query() query: unknown): Promise<PageResponse<ExpenseResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.expenses.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.categoryId === undefined ? {} : { categoryId: parsed.categoryId }),
      ...(parsed.hubId === undefined ? {} : { hubId: parsed.hubId }),
      ...(parsed.vehicleId === undefined ? {} : { vehicleId: parsed.vehicleId }),
      ...(parsed.from === undefined ? {} : { from: parsed.from }),
      ...(parsed.to === undefined ? {} : { to: parsed.to }),
    });
    return {
      data: await this.renderAll(page.items),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("expense:read")
  async getById(@Param("id") id: string): Promise<ExpenseResponse> {
    return this.render(await this.expenses.getById(id));
  }

  @Post(":id/approve")
  @RequirePermissions("expense:approve")
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ExpenseResponse> {
    return this.render(await this.expenses.approve(id, principal.userId));
  }

  @Post(":id/reject")
  @RequirePermissions("expense:approve")
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param("id") id: string,
    @Body(zodBody(rejectExpenseSchema)) body: z.infer<typeof rejectExpenseSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ExpenseResponse> {
    return this.render(await this.expenses.reject(id, body, principal.userId));
  }

  private async render(expense: Expense): Promise<ExpenseResponse> {
    return toResponse(expense, await this.currencies.exponentOf(expense.currency));
  }

  /** One exponent lookup per DISTINCT currency, not per row. */
  private async renderAll(rows: readonly Expense[]): Promise<ExpenseResponse[]> {
    const exponents = await this.exponentsFor(rows.map((row) => row.currency));
    return rows.map((row) => toResponse(row, exponentOf(exponents, row.currency)));
  }

  private async renderSummary(
    rows: readonly ExpenseSummaryRow[],
  ): Promise<SummaryRowResponse[]> {
    const exponents = await this.exponentsFor(rows.map((row) => row.currency));
    return rows.map((row) => ({
      categoryId: row.categoryId,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      currency: row.currency,
      currencyExponent: exponentOf(exponents, row.currency),
      totalMinor: row.totalMinor.toString(),
      count: row.count,
    }));
  }

  private async exponentsFor(currencies: readonly string[]): Promise<Map<string, number>> {
    const exponents = new Map<string, number>();
    for (const currency of new Set(currencies)) {
      exponents.set(currency, await this.currencies.exponentOf(currency));
    }
    return exponents;
  }
}

/**
 * Unreachable miss — the map is built from the same rows. Thrown rather than
 * defaulted, because a defaulted exponent prints 45000 millimes as "45000 TND"
 * on a report somebody signs off.
 */
function exponentOf(exponents: ReadonlyMap<string, number>, currency: string): number {
  const exponent = exponents.get(currency);
  if (exponent === undefined) {
    throw new Error(`No exponent resolved for currency ${currency}`);
  }
  return exponent;
}

function toResponse(expense: Expense, currencyExponent: number): ExpenseResponse {
  return {
    id: expense.id,
    reference: expense.reference,
    categoryId: expense.categoryId,
    amountMinor: expense.amountMinor.toString(),
    currency: expense.currency,
    currencyExponent,
    spentOn: expense.spentOn,
    description: expense.description,
    receiptKey: expense.receiptKey,
    supplierReference: expense.supplierReference,
    driverId: expense.driverId,
    vehicleId: expense.vehicleId,
    hubId: expense.hubId,
    paidFrom: expense.paidFrom,
    paidFromHubId: expense.paidFromHubId,
    status: expense.status,
    transactionId: expense.transactionId,
    recordedByUserId: expense.recordedByUserId,
    approvedByUserId: expense.approvedByUserId,
    approvedAt: expense.approvedAt?.toISOString() ?? null,
    decisionReason: expense.decisionReason,
    createdAt: expense.createdAt.toISOString(),
  };
}

function toCategory(category: ExpenseCategory): CategoryResponse {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    nameAr: category.nameAr,
    active: category.active,
  };
}
