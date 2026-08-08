"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * Gestion de stock — moving stock and defining the items.
 *
 * ⚠️ EVERY MOVEMENT CARRIES A SERVER-MINTED IDEMPOTENCY KEY. A storeman on a bad
 * connection taps "receive" twice, and without one the shelf gains stock that
 * never arrived. Minted here rather than in the browser so it survives a form
 * resubmit — a client-side key regenerates on reload and defeats the purpose.
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

const itemSchema = z.object({
  sku: z.string().trim().min(1, "required").max(50),
  name: z.string().trim().min(1, "required").max(200),
  nameAr: z.string().trim().max(200).optional(),
  unit: z.enum(["UNIT", "ROLL", "BOX", "METRE", "LITRE"]),
  reorderLevel: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export async function createInventoryItem(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = itemSchema.safeParse({
    sku: text(formData, "sku"),
    name: text(formData, "name"),
    ...spread("nameAr", optional(formData, "nameAr")),
    unit: text(formData, "unit"),
    ...spread("reorderLevel", optional(formData, "reorderLevel")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/inventory/items", { method: "POST", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/inventory`);
  return { error: null, fieldErrors: {} };
}

const movementSchema = z.object({
  itemId: z.uuid(),
  hubId: z.uuid(),
  direction: z.enum(["IN", "OUT"]),
  quantity: z.coerce.number().int().positive().max(1_000_000),
  reason: z.enum(["RECEIPT", "CONSUMPTION", "STOCKTAKE", "DAMAGE"]),
  note: z.string().trim().max(500).optional(),
});

export async function recordMovement(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = movementSchema.safeParse({
    itemId: text(formData, "itemId"),
    hubId: text(formData, "hubId"),
    direction: text(formData, "direction"),
    quantity: text(formData, "quantity"),
    reason: text(formData, "reason"),
    ...spread("note", optional(formData, "note")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/inventory/movements", {
      method: "POST",
      body: { ...parsed.data, idempotencyKey: randomUUID() },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/inventory`);
  return { error: null, fieldErrors: {} };
}

const transferSchema = z
  .object({
    itemId: z.uuid(),
    fromHubId: z.uuid(),
    toHubId: z.uuid(),
    quantity: z.coerce.number().int().positive().max(1_000_000),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.fromHubId !== value.toHubId, {
    message: "required",
    path: ["toHubId"],
  });

/** Moves stock between hubs. The API writes both legs, or neither. */
export async function transferStock(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = transferSchema.safeParse({
    itemId: text(formData, "itemId"),
    fromHubId: text(formData, "fromHubId"),
    toHubId: text(formData, "toHubId"),
    quantity: text(formData, "quantity"),
    ...spread("note", optional(formData, "note")),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/inventory/transfers", {
      method: "POST",
      body: { ...parsed.data, idempotencyKey: randomUUID() },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/inventory`);
  return { error: null, fieldErrors: {} };
}
