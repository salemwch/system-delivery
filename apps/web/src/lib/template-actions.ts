"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * Editing the copy every customer of the tenant reads.
 *
 * Guarded by `feature:manage` on the API — OWNER only. Message text carries the
 * brand and, in a COD market, instructions about money; that is not a
 * dispatcher-level authority.
 */

const LOCALES = ["ar", "fr", "en"] as const;
const CHANNELS = ["SMS", "PUSH", "EMAIL"] as const;

const templateSchema = z.object({
  key: z.string().trim().min(1).max(128),
  locale: z.enum(LOCALES),
  channel: z.enum(CHANNELS),
  body: z.string().trim().min(1, "required").max(1000),
});

export async function saveTemplate(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = templateSchema.safeParse({
    key: formData.get("key"),
    locale: formData.get("templateLocale"),
    channel: formData.get("channel"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/notification-templates", { method: "PUT", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      // The API validates placeholders against a known-token list and returns
      // the available ones in the message. Worth showing verbatim: "unknown
      // placeholder {{foo}}" is only useful if the operator sees which are real.
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/settings/templates`);
  return { error: null, fieldErrors: {} };
}

const revertSchema = z.object({
  key: z.string().trim().min(1).max(128),
  locale: z.enum(LOCALES),
  channel: z.enum(CHANNELS),
});

/** Drops the override so the built-in default applies again. */
export async function revertTemplate(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = revertSchema.safeParse({
    key: formData.get("key"),
    locale: formData.get("templateLocale"),
    channel: formData.get("channel"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch("/v1/notification-templates/revert", { method: "POST", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: {} };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/settings/templates`);
  return { error: null, fieldErrors: {} };
}
