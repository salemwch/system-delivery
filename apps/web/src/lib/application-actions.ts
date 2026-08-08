"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";
import { toE164 } from "./phone";

/**
 * Deciding a merchant application — nouveaux clients.
 *
 * Both actions are gated by `merchant:decide_application` on the API, which is
 * deliberately NOT `merchant:create`: entering an account the courier already
 * agreed to and accepting a stranger are different authorities.
 */

/** `FormData.get` returns `string | File | null`; a File coerces to "[object File]". */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

const approveSchema = z.object({
  applicationId: z.uuid(),
  code: z.string().trim().max(50).optional(),
  name: z.string().trim().max(200).optional(),
});

export async function approveApplication(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const code = text(formData, "code").trim();
  const name = text(formData, "name").trim();

  const parsed = approveSchema.safeParse({
    applicationId: text(formData, "applicationId"),
    ...(code === "" ? {} : { code }),
    ...(name === "" ? {} : { name }),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const { applicationId, ...body } = parsed.data;

  try {
    await apiFetch(`/v1/merchant-applications/${applicationId}/approve`, {
      method: "POST",
      body,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/applications`);
  // The approval created a merchant, so the merchant list is stale too.
  revalidatePath(`/${toLocale(locale)}/merchants`);
  return { error: null, fieldErrors: {} };
}

const rejectSchema = z.object({
  applicationId: z.uuid(),
  reason: z.string().trim().min(1, "required").max(1000),
});

/**
 * Reject, with a reason.
 *
 * The reason is mandatory here, in the API schema, AND in a database CHECK —
 * three layers for one field, because a rejection nobody can explain is not
 * reviewable, and the applicant who telephones deserves an answer.
 */
export async function rejectApplication(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = rejectSchema.safeParse({
    applicationId: text(formData, "applicationId"),
    reason: text(formData, "reason"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch(`/v1/merchant-applications/${parsed.data.applicationId}/reject`, {
      method: "POST",
      body: { reason: parsed.data.reason },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/applications`);
  return { error: null, fieldErrors: {} };
}

const leadSchema = z.object({
  businessName: z.string().trim().min(1, "required").max(200),
  contactName: z.string().trim().min(1, "required").max(200),
  contactPhone: z
    .string()
    .trim()
    .transform(toE164)
    .refine((value) => value !== null, "invalid"),
  contactEmail: z.email().max(254).optional(),
  city: z.string().trim().max(120).optional(),
  expectedVolume: z.coerce.number().int().min(0).max(1_000_000).optional(),
  message: z.string().trim().max(2000).optional(),
});

/**
 * A lead a commercial logged after meeting someone.
 *
 * ⚠️ The phone is normalised HERE, not just validated. Tunisians write
 * `24201314`; the API takes E.164 only. Rejecting the form for a format the
 * operator has no reason to know about is the wrong end of the problem.
 */
export async function logLead(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const optional = (field: string): string | undefined => {
    const value = text(formData, field).trim();
    return value === "" ? undefined : value;
  };

  const parsed = leadSchema.safeParse({
    businessName: text(formData, "businessName"),
    contactName: text(formData, "contactName"),
    contactPhone: text(formData, "contactPhone"),
    ...(optional("contactEmail") === undefined ? {} : { contactEmail: optional("contactEmail") }),
    ...(optional("city") === undefined ? {} : { city: optional("city") }),
    ...(optional("expectedVolume") === undefined
      ? {}
      : { expectedVolume: optional("expectedVolume") }),
    ...(optional("message") === undefined ? {} : { message: optional("message") }),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/merchant-applications", { method: "POST", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/applications`);
  return { error: null, fieldErrors: {} };
}
