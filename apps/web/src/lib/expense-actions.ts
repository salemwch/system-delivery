"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";
import { toMinorUnits } from "./minor-units";

/**
 * Les dépenses — recording and deciding.
 *
 * ⚠️ APPROVING POSTS TO THE LEDGER. It is not a workflow flag: it debits an
 * expense account and credits a hub's cash box or the bank, and there is no
 * undo — a mistake is corrected by a reversing adjustment, never an edit.
 *
 * Amounts are typed as DECIMALS ("45.500") and converted by string arithmetic.
 * `Number(x) * 1000` is wrong on values like 4.005, and an expense is exactly
 * the kind of figure nobody re-checks.
 */

/** `FormData.get` returns `string | File | null`; a File coerces to "[object File]". */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

function optional(formData: FormData, field: string): string | undefined {
  const value = text(formData, field).trim();
  return value === "" ? undefined : value;
}

/** Spread-friendly optional — `exactOptionalPropertyTypes` forbids `undefined`. */
function spread(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

const createSchema = z
  .object({
    categoryId: z.uuid(),
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,12}([.,]\d{1,6})?$/u, "invalid"),
    currency: z.string().trim().length(3),
    exponent: z.coerce.number().int().min(0).max(6),
    spentOn: z.iso.date(),
    description: z.string().trim().min(1, "required").max(500),
    supplierReference: z.string().trim().max(200).optional(),
    vehicleId: z.uuid().optional(),
    hubId: z.uuid().optional(),
    paidFrom: z.enum(["HUB_CASH", "BANK"]),
    paidFromHubId: z.uuid().optional(),
  })
  .refine(
    (value) =>
      value.paidFrom === "BANK"
        ? value.paidFromHubId === undefined
        : value.paidFromHubId !== undefined,
    { message: "required", path: ["paidFromHubId"] },
  );

export async function recordExpense(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = createSchema.safeParse({
    categoryId: text(formData, "categoryId"),
    amount: text(formData, "amount"),
    currency: text(formData, "currency"),
    exponent: text(formData, "exponent"),
    spentOn: text(formData, "spentOn"),
    description: text(formData, "description"),
    ...spread("supplierReference", optional(formData, "supplierReference")),
    ...spread("vehicleId", optional(formData, "vehicleId")),
    ...spread("hubId", optional(formData, "hubId")),
    paidFrom: text(formData, "paidFrom"),
    ...spread("paidFromHubId", optional(formData, "paidFromHubId")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const { amount, exponent, ...rest } = parsed.data;
  const amountMinor = Number(toMinorUnits(amount, exponent));

  // The regex admits 12 integer digits, which past exponent 3 exceeds what a
  // double holds exactly. Caught here rather than sent, because the API takes a
  // JSON number and a silently rounded expense is money nobody can trace.
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { error: "validation", fieldErrors: { amount: "invalid" } };
  }

  try {
    await apiFetch("/v1/expenses", {
      method: "POST",
      body: { ...rest, currency: rest.currency.toUpperCase(), amountMinor },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/finance/expenses`);
  return { error: null, fieldErrors: {} };
}

const decideSchema = z.object({
  expenseId: z.uuid(),
  reason: z.string().trim().max(1000).optional(),
});

export async function approveExpense(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(locale, formData, "approve");
}

export async function rejectExpense(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(locale, formData, "reject");
}

/**
 * Both decisions, spelled once.
 *
 * They differ only in the path and in whether a reason is required; two copies
 * would be two places for the error handling to drift apart.
 */
async function decide(
  locale: string,
  formData: FormData,
  outcome: "approve" | "reject",
): Promise<FormState> {
  const parsed = decideSchema.safeParse({
    expenseId: text(formData, "expenseId"),
    ...spread("reason", optional(formData, "reason")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  // Mandatory on rejection here, in the API schema, and in a database CHECK.
  if (outcome === "reject" && parsed.data.reason === undefined) {
    return { error: "validation", fieldErrors: { reason: "required" } };
  }

  try {
    await apiFetch(`/v1/expenses/${parsed.data.expenseId}/${outcome}`, {
      method: "POST",
      body: outcome === "reject" ? { reason: parsed.data.reason } : {},
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: {} };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/finance/expenses`);
  return { error: null, fieldErrors: {} };
}

const categorySchema = z.object({
  code: z.string().trim().min(1, "required").max(50),
  name: z.string().trim().min(1, "required").max(200),
  nameAr: z.string().trim().max(200).optional(),
});

export async function createExpenseCategory(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = categorySchema.safeParse({
    code: text(formData, "code"),
    name: text(formData, "name"),
    ...spread("nameAr", optional(formData, "nameAr")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/expenses/categories", { method: "POST", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/finance/expenses`);
  return { error: null, fieldErrors: {} };
}
