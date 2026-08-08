"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { INITIAL_STATE, fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";
import { toMinorUnits } from "./minor-units";

/**
 * Invoicing commands.
 *
 * ⚠️ Amounts are typed by the operator as DECIMALS ("4.500") and sent as minor
 * units ("4500"). The conversion happens once, in {@link toMinorUnits} — integer
 * string arithmetic, never `Math.round(x * 1000)`, because `4.005 * 1000` is
 * `4004.999999999999` in IEEE 754 and that becomes a 4.004 TND unit price on a
 * legal document.
 *
 * ⚠️ A Server Action REFRESHES IN PLACE; only a render redirects. Issuing and
 * paying therefore call `revalidatePath` and return, so an error can be shown on
 * the page the operator is already looking at. Only `createDraft` redirects,
 * because it has a new page to go to.
 */

/** ISO-8601 date (`<input type="date">`). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "format");

/**
 * A decimal amount as typed, e.g. "4.500" or "4,5".
 *
 * Accepts a comma: a French or Arabic keyboard produces one, and rejecting it
 * reads to the operator as "the number is wrong".
 */
const decimalAmount = z
  .string()
  .trim()
  .min(1, "required")
  .regex(/^\d+([.,]\d{1,6})?$/u, "format");

const lineSchema = z.object({
  description: z.string().trim().min(1, "required").max(500),
  quantity: z.coerce.number().int().min(1, "min").max(1_000_000),
  unitPrice: decimalAmount,
});

const createSchema = z.object({
  merchantId: z.uuid(),
  periodFrom: isoDate,
  periodTo: isoDate,
  currency: z.string().trim().length(3).toUpperCase(),
  /** The currency's exponent, echoed back from the page that rendered the form. */
  exponent: z.coerce.number().int().min(0).max(6),
  notes: z.string().trim().max(2000).optional(),
});

interface CreatedInvoice {
  readonly id: string;
}

interface RawLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

/**
 * A form field as text, or "" if it is absent or a File.
 *
 * ⚠️ `FormData.get` returns `string | File | null`. Coercing a File with
 * `String()` yields `"[object File]"` — which would sail through the schema as a
 * perfectly valid line description. Anything that is not a string is treated as
 * missing, so a crafted multipart body cannot smuggle an object onto an invoice.
 */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

/**
 * Reads the repeated line fields out of a FormData.
 *
 * The form posts `lines[0].description`, `lines[0].quantity`, … A single
 * `getAll` per field would lose the pairing as soon as one line is blank, so
 * the index is walked until a row is missing entirely.
 */
function linesFrom(formData: FormData): RawLine[] {
  const rows: RawLine[] = [];
  for (let index = 0; ; index += 1) {
    const prefix = `lines[${String(index)}]`;
    if (!formData.has(`${prefix}.description`)) {
      return rows;
    }
    const description = text(formData, `${prefix}.description`);
    const unitPrice = text(formData, `${prefix}.unitPrice`);
    // A wholly blank row is the empty template the form always renders last.
    if (description.trim() === "" && unitPrice.trim() === "") {
      continue;
    }
    const quantity = text(formData, `${prefix}.quantity`);
    rows.push({ description, quantity: quantity === "" ? "1" : quantity, unitPrice });
  }
}

/** Opens a draft with its lines. No number is taken until it is issued. */
export async function createInvoiceDraft(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = createSchema.safeParse({
    merchantId: formData.get("merchantId"),
    periodFrom: formData.get("periodFrom"),
    periodTo: formData.get("periodTo"),
    currency: formData.get("currency"),
    exponent: formData.get("exponent"),
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const lines = z.array(lineSchema).min(1, "required").safeParse(linesFrom(formData));
  if (!lines.success) {
    return { error: "validation", fieldErrors: { lines: "required" } };
  }
  // Checked here so the message lands on the field. The API raises its own
  // constraint regardless — this is convenience, not the authority.
  if (parsed.data.periodTo < parsed.data.periodFrom) {
    return { error: "validation", fieldErrors: { periodTo: "periodOrder" } };
  }

  let created: CreatedInvoice;
  try {
    created = await apiFetch<CreatedInvoice>("/v1/invoices", {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: {
        merchantId: parsed.data.merchantId,
        periodFrom: parsed.data.periodFrom,
        periodTo: parsed.data.periodTo,
        currency: parsed.data.currency,
        lines: lines.data.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitPriceMinor: toMinorUnits(line.unitPrice, parsed.data.exponent),
        })),
        ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  const language = toLocale(locale);
  revalidatePath(`/${language}/finance/invoices`);
  redirect(`/${language}/finance/invoices/${encodeURIComponent(created.id)}`);
}

const invoiceIdSchema = z.object({ invoiceId: z.uuid() });

/**
 * Issues the invoice — irreversible.
 *
 * The number it consumes cannot be released, so this is deliberately its own
 * action with its own button rather than a status dropdown: an operator must
 * mean it.
 */
export async function issueInvoice(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return command(locale, formData, (id) => `/v1/invoices/${id}/issue`);
}

/** Records payment: ISSUED → PAID. */
export async function markInvoicePaid(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return command(locale, formData, (id) => `/v1/invoices/${id}/pay`);
}

const cancelSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(1, "required").max(500),
});

/** Cancels a DRAFT. An issued invoice is corrected with a credit note. */
export async function cancelInvoiceDraft(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = cancelSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch(`/v1/invoices/${encodeURIComponent(parsed.data.invoiceId)}/cancel`, {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: { reason: parsed.data.reason },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidateInvoice(locale, parsed.data.invoiceId);
  return INITIAL_STATE;
}

const creditNoteSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(1, "required").max(500),
});

/**
 * Drafts a credit note (avoir) against an issued invoice.
 *
 * Full credit: the original's lines are copied by the API. A partial credit is
 * a different, rarer operation and belongs on its own screen rather than behind
 * an optional field nobody notices.
 */
export async function createCreditNote(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = creditNoteSchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  let created: CreatedInvoice;
  try {
    created = await apiFetch<CreatedInvoice>("/v1/invoices/credit-notes", {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: { correctsInvoiceId: parsed.data.invoiceId, reason: parsed.data.reason },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  const language = toLocale(locale);
  revalidatePath(`/${language}/finance/invoices`);
  redirect(`/${language}/finance/invoices/${encodeURIComponent(created.id)}`);
}

const settingsSchema = z.object({
  /** Typed as a percentage ("19" or "19.5"); stored as basis points. */
  vatRate: z
    .string()
    .trim()
    .regex(/^\d{1,3}([.,]\d{1,2})?$/u, "format")
    .refine((value) => Number(value.replace(",", ".")) <= 100, "max"),
  stampDuty: decimalAmount,
  exponent: z.coerce.number().int().min(0).max(6),
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
  legalName: z.string().trim().max(200),
  taxIdentifier: z.string().trim().max(50),
  legalAddress: z.string().trim().max(500),
});

/**
 * Writes the billing configuration.
 *
 * ⚠️ The rate is entered as a PERCENTAGE and stored in basis points, because a
 * NUMERIC rate lets floating-point rounding into a tax calculation. "19.5"
 * becomes 1950 by the same exact string arithmetic the amounts use.
 *
 * Changing the rate never touches an existing invoice — each one stores the rate
 * it was drafted with.
 */
export async function updateBillingSettings(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = settingsSchema.safeParse({
    vatRate: formData.get("vatRate"),
    stampDuty: formData.get("stampDuty"),
    exponent: formData.get("exponent"),
    paymentTermsDays: formData.get("paymentTermsDays"),
    legalName: formData.get("legalName") ?? "",
    taxIdentifier: formData.get("taxIdentifier") ?? "",
    legalAddress: formData.get("legalAddress") ?? "",
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/invoices/settings", {
      method: "PUT",
      idempotencyKey: randomUUID(),
      body: {
        // Percent → basis points: exponent 2 is exactly that conversion.
        vatRateBp: Number(toMinorUnits(parsed.data.vatRate, 2)),
        stampDutyMinor: toMinorUnits(parsed.data.stampDuty, parsed.data.exponent),
        paymentTermsDays: parsed.data.paymentTermsDays,
        // Blank clears the field rather than storing an empty string, so the
        // document falls back to the tenant's own name instead of printing "".
        legalName: parsed.data.legalName === "" ? null : parsed.data.legalName,
        taxIdentifier: parsed.data.taxIdentifier === "" ? null : parsed.data.taxIdentifier,
        legalAddress: parsed.data.legalAddress === "" ? null : parsed.data.legalAddress,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/finance/invoices/settings`);
  return INITIAL_STATE;
}

/**
 * The shape shared by issue and pay: one id, one POST, refresh in place.
 *
 * Both are irreversible transitions with no body, and duplicating the
 * try/catch/revalidate for each is how one of them quietly stops reporting its
 * errors.
 */
async function command(
  locale: string,
  formData: FormData,
  path: (id: string) => string,
): Promise<FormState> {
  const parsed = invoiceIdSchema.safeParse({ invoiceId: formData.get("invoiceId") });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch(path(encodeURIComponent(parsed.data.invoiceId)), {
      method: "POST",
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidateInvoice(locale, parsed.data.invoiceId);
  return INITIAL_STATE;
}

/** Both the detail page and the list it appears on. */
function revalidateInvoice(locale: string, invoiceId: string): void {
  const language = toLocale(locale);
  revalidatePath(`/${language}/finance/invoices/${invoiceId}`);
  revalidatePath(`/${language}/finance/invoices`);
}
