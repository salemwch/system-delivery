"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * Remarques — the internal note staff leave on a parcel, a merchant or a driver.
 *
 * ⚠️ THERE IS NO EDIT ACTION, and there never will be. Migration 0035 freezes
 * the body with a trigger: a correction is a new note. The value of the log is
 * that Tuesday's entry still says what it said on Tuesday, and an edit form
 * would quietly destroy that whatever the trigger does.
 */

/** `FormData.get` returns `string | File | null`; a File coerces to "[object File]". */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

const SUBJECT_TYPES = ["SHIPMENT", "MERCHANT", "DRIVER"] as const;

const createSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.uuid(),
  body: z.string().trim().min(1, "required").max(2000),
  pinned: z.enum(["on", ""]).transform((value) => value === "on"),
});

/** Where the note was written from, so the right page is revalidated. */
function pathFor(locale: string, subjectType: string, subjectId: string): string {
  switch (subjectType) {
    case "SHIPMENT":
      return `/${locale}/shipments/${subjectId}`;
    case "MERCHANT":
      return `/${locale}/merchants/${subjectId}`;
    default:
      return `/${locale}/fleet`;
  }
}

export async function createNote(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = createSchema.safeParse({
    subjectType: text(formData, "subjectType"),
    subjectId: text(formData, "subjectId"),
    body: text(formData, "body"),
    // An unchecked checkbox sends nothing at all, which `z.enum` must be able
    // to read as "off" rather than as a missing required field.
    pinned: text(formData, "pinned"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/notes", { method: "POST", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  const safeLocale = toLocale(locale);
  revalidatePath(pathFor(safeLocale, parsed.data.subjectType, parsed.data.subjectId));
  revalidatePath(`/${safeLocale}/remarks`);
  return { error: null, fieldErrors: {} };
}

const updateSchema = z.object({
  noteId: z.uuid(),
  pinned: z.enum(["true", "false"]).optional(),
  resolved: z.enum(["true", "false"]).optional(),
});

/**
 * Pin, unpin, resolve or reopen — the note's STATE, never its content.
 *
 * One action for both because they are the same request to the same endpoint;
 * two would duplicate the error handling and the revalidation for no gain.
 */
export async function updateNote(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = {
    noteId: text(formData, "noteId"),
    ...(text(formData, "pinned") === "" ? {} : { pinned: text(formData, "pinned") }),
    ...(text(formData, "resolved") === "" ? {} : { resolved: text(formData, "resolved") }),
  };
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  const body = {
    ...(parsed.data.pinned === undefined ? {} : { pinned: parsed.data.pinned === "true" }),
    ...(parsed.data.resolved === undefined ? {} : { resolved: parsed.data.resolved === "true" }),
  };
  if (Object.keys(body).length === 0) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch(`/v1/notes/${parsed.data.noteId}`, { method: "PATCH", body });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: {} };
    }
    throw error;
  }

  const safeLocale = toLocale(locale);
  // The subject page is not known here — the note id alone does not say which
  // parcel it belongs to. Revalidating the layout covers every page that shows
  // a note, which is cheaper than threading the subject through every button.
  revalidatePath(`/${safeLocale}`, "layout");
  return { error: null, fieldErrors: {} };
}
