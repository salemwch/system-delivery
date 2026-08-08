"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * Support — replying to and managing a ticket.
 *
 * ⚠️ `internal` IS A REAL SWITCH, not a display hint. A message sent with it is
 * invisible to the merchant, enforced by RLS on the API. The form makes that
 * unmistakable rather than burying it in a checkbox label, because a note the
 * author believes is private and is not is the worst possible outcome here.
 */

/** `FormData.get` returns `string | File | null`; a File coerces to "[object File]". */
function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

const CATEGORIES = ["BILLING", "PICKUP", "DELIVERY", "ACCOUNT", "TECHNICAL", "OTHER"] as const;
const STATUSES = ["OPEN", "PENDING_MERCHANT", "RESOLVED", "CLOSED"] as const;

const replySchema = z.object({
  ticketId: z.uuid(),
  body: z.string().trim().min(1, "required").max(5000),
  // An unchecked checkbox sends nothing at all, so "" must read as off rather
  // than as a missing required field.
  internal: z.enum(["on", ""]).transform((value) => value === "on"),
});

export async function replyToTicket(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = replySchema.safeParse({
    ticketId: text(formData, "ticketId"),
    body: text(formData, "body"),
    internal: text(formData, "internal"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const { ticketId, ...body } = parsed.data;

  try {
    await apiFetch(`/v1/support-tickets/${ticketId}/messages`, { method: "POST", body });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  const safeLocale = toLocale(locale);
  revalidatePath(`/${safeLocale}/support/${ticketId}`);
  revalidatePath(`/${safeLocale}/support`);
  return { error: null, fieldErrors: {} };
}

const updateSchema = z.object({
  ticketId: z.uuid(),
  status: z.enum(STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
});

/** Close, reopen, or recategorise. Staff only — the API demands `support:manage`. */
export async function updateTicket(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const status = text(formData, "status");
  const category = text(formData, "category");

  const parsed = updateSchema.safeParse({
    ticketId: text(formData, "ticketId"),
    ...(status === "" ? {} : { status }),
    ...(category === "" ? {} : { category }),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  const { ticketId, ...body } = parsed.data;
  if (Object.keys(body).length === 0) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch(`/v1/support-tickets/${ticketId}`, { method: "PATCH", body });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: {} };
    }
    throw error;
  }

  const safeLocale = toLocale(locale);
  revalidatePath(`/${safeLocale}/support/${ticketId}`);
  revalidatePath(`/${safeLocale}/support`);
  return { error: null, fieldErrors: {} };
}

const openSchema = z.object({
  merchantId: z.uuid(),
  subject: z.string().trim().min(1, "required").max(200),
  body: z.string().trim().min(1, "required").max(5000),
  category: z.enum(CATEGORIES),
});

/** Staff opening a ticket on a merchant's behalf — the phone-call case. */
export async function openTicket(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = openSchema.safeParse({
    merchantId: text(formData, "merchantId"),
    subject: text(formData, "subject"),
    body: text(formData, "body"),
    category: text(formData, "category"),
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  try {
    await apiFetch("/v1/support-tickets", { method: "POST", body: parsed.data });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/support`);
  return { error: null, fieldErrors: {} };
}
