import { z } from "zod";

/**
 * Validated input contracts for les dépenses.
 *
 * Amounts arrive in MINOR UNITS as an integer, like every other amount on this
 * API. The web form converts from the decimal a human types by string
 * arithmetic — `Number(x) * 1000` is wrong on values like 4.005, and an expense
 * is exactly the kind of number nobody re-checks.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

export const PAYMENT_SOURCES = ["HUB_CASH", "BANK"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const EXPENSE_STATUSES = ["DRAFT", "APPROVED", "REJECTED"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

const currencyCode = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase());

export const createExpenseCategorySchema = z.strictObject({
  code: nonEmpty("code").max(50),
  name: nonEmpty("name").max(200),
  nameAr: nonEmpty("nameAr").max(200).optional(),
});
export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = z
  .strictObject({
    name: nonEmpty("name").max(200).optional(),
    nameAr: nonEmpty("nameAr").max(200).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

/**
 * Recording what was spent.
 *
 * `paidFromHubId` is required with HUB_CASH and forbidden with BANK — cash
 * leaves a specific box, or it is not cash. Expressed as a refinement AND as a
 * database CHECK, because the ledger posting depends on it: without the hub
 * there is no account to credit.
 */
export const createExpenseSchema = z
  .strictObject({
    categoryId: z.uuid(),
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: currencyCode,
    /** ISO date. Frequently not today — receipts arrive late. */
    spentOn: z.iso.date(),
    description: nonEmpty("description").max(500),
    receiptKey: nonEmpty("receiptKey").max(500).optional(),
    supplierReference: nonEmpty("supplierReference").max(200).optional(),
    driverId: z.uuid().optional(),
    vehicleId: z.uuid().optional(),
    hubId: z.uuid().optional(),
    paidFrom: z.enum(PAYMENT_SOURCES),
    paidFromHubId: z.uuid().optional(),
  })
  .refine(
    (value) =>
      value.paidFrom === "BANK"
        ? value.paidFromHubId === undefined
        : value.paidFromHubId !== undefined,
    { message: "cash must name the hub it left", path: ["paidFromHubId"] },
  );
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const rejectExpenseSchema = z.strictObject({
  reason: nonEmpty("reason").max(1000),
});
export type RejectExpenseInput = z.infer<typeof rejectExpenseSchema>;

export const listExpensesSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  categoryId: z.uuid().optional(),
  hubId: z.uuid().optional(),
  vehicleId: z.uuid().optional(),
  /** Inclusive bounds on `spentOn`, for the monthly report. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type ListExpensesInput = z.infer<typeof listExpensesSchema>;

/** The report: approved spend per category over a period. */
export const expenseSummarySchema = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
});
export type ExpenseSummaryInput = z.infer<typeof expenseSummarySchema>;
