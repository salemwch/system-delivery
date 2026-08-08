"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * Général — the courier's own name, timezone and languages.
 *
 * ⚠️ NEITHER THE SLUG NOR THE CURRENCY IS EDITABLE, and neither appears in this
 * file. The slug is in every tracking URL already sent to a customer; the
 * currency is stamped on every shipment, invoice and ledger entry ever written,
 * and changing it would reinterpret a year of amounts rather than convert them.
 */

/** `FormData.get` returns `string | File | null`; a File coerces to "[object File]". */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

const LOCALES = ["ar", "fr", "en"] as const;

const profileSchema = z.object({
  name: z.string().trim().min(1, "required").max(200),
  timezone: z.string().trim().min(1, "required"),
  defaultLocale: z.enum(LOCALES),
  supportedLocales: z.array(z.enum(LOCALES)).min(1, "required"),
});

export async function updateTenantProfile(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Checkboxes: `getAll` returns every checked box, and an empty array when
  // none are — which the schema rejects, because a courier with no language
  // has no language to print a document in.
  const supportedLocales = formData
    .getAll("supportedLocales")
    .filter((value): value is string => typeof value === "string");

  const parsed = profileSchema.safeParse({
    name: text(formData, "name"),
    timezone: text(formData, "timezone"),
    defaultLocale: text(formData, "defaultLocale"),
    supportedLocales,
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/tenant/profile", { method: "PUT", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      // The API refuses a default locale that is not in the supported set; its
      // message names both, which is more useful than anything invented here.
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  const safeLocale = toLocale(locale);
  revalidatePath(`/${safeLocale}/settings/general`);
  // The courier name is in the sidebar of every page.
  revalidatePath(`/${safeLocale}`, "layout");
  return { error: null, fieldErrors: {} };
}

const featureSchema = z.object({
  key: z.string().trim().min(1).max(64),
  enabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

/**
 * Options — a feature flag, on or off.
 *
 * ⚠️ Flags are how per-tenant behaviour is expressed at all (invariant I17):
 * nothing in this codebase branches on a literal tenant id, so turning COD off
 * for one courier IS this switch. That makes it a consequential screen, not a
 * cosmetic one.
 */
export async function setFeature(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = featureSchema.safeParse({
    key: text(formData, "key"),
    enabled: text(formData, "enabled"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch(`/v1/features/${parsed.data.key}`, {
      method: "PUT",
      body: { enabled: parsed.data.enabled },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: {} };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/settings/options`);
  return { error: null, fieldErrors: {} };
}
