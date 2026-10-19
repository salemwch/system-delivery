"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * Deciding a driver pin correction held for review (moved more than 2 km).
 *
 * Approving MOVES THE PIN every later delivery to that address is routed and
 * fraud-checked against. The API applies it from the address as it is now, and
 * turns it into SUPERSEDED if a newer pin arrived while it waited; nothing here
 * decides either. The note is optional on both decisions: the API records who
 * decided and when, which is the part an auditor needs.
 */
const decideSchema = z.object({
  correctionId: z.uuid(),
  note: z.string().trim().max(1000).optional(),
});

export async function approveCorrection(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(locale, formData, "approve");
}

export async function rejectCorrection(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return decide(locale, formData, "reject");
}

async function decide(
  locale: string,
  formData: FormData,
  outcome: "approve" | "reject",
): Promise<FormState> {
  const note = text(formData, "note").trim();
  const parsed = decideSchema.safeParse({
    correctionId: text(formData, "correctionId"),
    ...(note === "" ? {} : { note }),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch(`/v1/address-corrections/${parsed.data.correctionId}/${outcome}`, {
      method: "POST",
      body: parsed.data.note === undefined ? {} : { note: parsed.data.note },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  // The layout too: the sidebar badge counts what is still waiting.
  revalidatePath(`/${toLocale(locale)}`, "layout");
  return { error: null, fieldErrors: {} };
}

/** `FormData.get` returns `string | File | null`; a File coerces to "[object File]". */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}
