"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";
import { toE164 } from "./phone";
import { toMinorUnits } from "./minor-units";

/**
 * Modification Colis — requesting and deciding a change to a parcel.
 *
 * ⚠️ A DISPATCHER'S REQUEST IS APPLIED IMMEDIATELY, because they hold the
 * approve permission and there is nobody left to ask. The API decides that from
 * the token; nothing here may claim it. That is why `request` sends no "apply
 * now" flag — one would be a way to approve your own change without the
 * authority to do so.
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

const decimalAmount = z
  .string()
  .trim()
  .regex(/^\d{1,12}([.,]\d{1,6})?$/u, "invalid");

const requestSchema = z
  .object({
    shipmentId: z.uuid(),
    exponent: z.coerce.number().int().min(0).max(6),
    recipientName: z.string().trim().max(200).optional(),
    // Normalised, not merely validated: `24201314` is what a Tunisian types and
    // correcting a wrong number is the single most common amendment there is.
    recipientPhone: z
      .string()
      .trim()
      .transform(toE164)
      .refine((value) => value !== null, "invalid")
      .optional(),
    destinationRawInput: z.string().trim().max(500).optional(),
    destinationCity: z.string().trim().max(120).optional(),
    codAmount: decimalAmount.optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine(
    (value) =>
      value.recipientName !== undefined ||
      value.recipientPhone !== undefined ||
      value.destinationRawInput !== undefined ||
      value.codAmount !== undefined,
    { message: "required", path: ["reason"] },
  );

export async function requestAmendment(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = requestSchema.safeParse({
    shipmentId: text(formData, "shipmentId"),
    exponent: text(formData, "exponent"),
    ...spread("recipientName", optional(formData, "recipientName")),
    ...spread("recipientPhone", optional(formData, "recipientPhone")),
    ...spread("destinationRawInput", optional(formData, "destinationRawInput")),
    ...spread("destinationCity", optional(formData, "destinationCity")),
    ...spread("codAmount", optional(formData, "codAmount")),
    ...spread("reason", optional(formData, "reason")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const { shipmentId, exponent, codAmount, ...rest } = parsed.data;

  // String arithmetic, as everywhere money is converted: `Number(x) * 1000` is
  // wrong on 4.005 and the error lands on what a driver collects.
  const codAmountMinor = codAmount === undefined ? undefined : toMinorUnits(codAmount, exponent);
  if (codAmountMinor !== undefined && !Number.isSafeInteger(Number(codAmountMinor))) {
    return { error: "validation", fieldErrors: { codAmount: "invalid" } };
  }

  try {
    await apiFetch(`/v1/shipments/${shipmentId}/amendments`, {
      method: "POST",
      body: {
        ...rest,
        // Sent as a STRING: the API's amountMinor schema accepts a digit string
        // and a bigint survives the round trip that a JSON number would round.
        ...(codAmountMinor === undefined ? {} : { codAmountMinor }),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  const safeLocale = toLocale(locale);
  revalidatePath(`/${safeLocale}/shipments/${shipmentId}`);
  revalidatePath(`/${safeLocale}/amendments`);
  return { error: null, fieldErrors: {} };
}

const decideSchema = z.object({
  amendmentId: z.uuid(),
  reason: z.string().trim().max(1000).optional(),
});

export async function approveAmendment(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(locale, formData, "approve");
}

export async function rejectAmendment(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(locale, formData, "reject");
}

/**
 * Both decisions, spelled once.
 *
 * They differ only in the path and in whether a reason is required, so two
 * copies of the error handling and the revalidation would be two places for the
 * two to drift apart.
 */
async function decide(
  locale: string,
  formData: FormData,
  outcome: "approve" | "reject",
): Promise<FormState> {
  const parsed = decideSchema.safeParse({
    amendmentId: text(formData, "amendmentId"),
    ...spread("reason", optional(formData, "reason")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  // Mandatory on rejection — in this schema, in the API's, and in a database
  // CHECK. A refusal nobody can explain is not reviewable.
  if (outcome === "reject" && parsed.data.reason === undefined) {
    return { error: "validation", fieldErrors: { reason: "required" } };
  }

  try {
    await apiFetch(`/v1/shipment-amendments/${parsed.data.amendmentId}/${outcome}`, {
      method: "POST",
      body: outcome === "reject" ? { reason: parsed.data.reason } : {},
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  const safeLocale = toLocale(locale);
  // The parcel it belongs to is not known here — the amendment id alone does not
  // say. Revalidating the layout covers every page that shows one.
  revalidatePath(`/${safeLocale}`, "layout");
  return { error: null, fieldErrors: {} };
}

/** Spread-friendly optional field — `exactOptionalPropertyTypes` forbids `undefined`. */
function spread(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}
