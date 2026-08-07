"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { timezone } from "./config";
import { fieldErrorsFrom } from "./form-state";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";
import { toE164 } from "./phone";
import { zonedToUtcIso } from "./zoned-time";

/**
 * Taking a collection run.
 *
 * The command carries no collector: `POST /v1/pickups/:id/claim` reads it from
 * the bearer token, so this action *cannot* assign the run to anyone but the
 * signed-in user — which is exactly why a COMMERCIAL may hold it and
 * `pickup:assign` (dispatching the fleet) stays with dispatch.
 */

const requestSchema = z.object({
  merchantId: z.uuid(),
  pickupAddressId: z.uuid(),
  contactName: z.string().trim().min(1, "required").max(200),
  contactPhone: z
    .string()
    .trim()
    .transform(toE164)
    .refine((value) => value !== null, "phone"),
  /** Wall-clock, from `<input type="datetime-local">`. Converted below. */
  from: z.string().trim().min(1, "required"),
  to: z.string().trim().min(1, "required"),
  notes: z.string().trim().max(2000).optional(),
});

interface CreatedPickup {
  readonly id: string;
}

/**
 * Asks the courier to come and collect.
 *
 * The window arrives as two wall-clock strings with no zone. They are read in
 * the TENANT's timezone, not the server's — a container running UTC would
 * otherwise book every pickup an hour out. See `lib/zoned-time.ts`.
 */
export async function requestPickup(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = requestSchema.safeParse({
    merchantId: formData.get("merchantId"),
    pickupAddressId: formData.get("pickupAddressId"),
    contactName: formData.get("contactName"),
    contactPhone: formData.get("contactPhone"),
    from: formData.get("from"),
    to: formData.get("to"),
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: fieldErrorsFrom(parsed.error) };
  }

  const zone = timezone();
  const from = zonedToUtcIso(parsed.data.from, zone);
  const to = zonedToUtcIso(parsed.data.to, zone);
  if (from === null || to === null) {
    return { error: "validation", fieldErrors: { from: "format", to: "format" } };
  }
  // Checked here as well as by the API so the message lands on the field. The
  // API is still the authority — it raises PICKUP_WINDOW_INVALID regardless.
  if (Date.parse(to) <= Date.parse(from)) {
    return { error: "validation", fieldErrors: { to: "windowOrder" } };
  }

  let created: CreatedPickup;
  try {
    created = await apiFetch<CreatedPickup>("/v1/pickups", {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: {
        idempotencyKey: randomUUID(),
        merchantId: parsed.data.merchantId,
        pickupAddressId: parsed.data.pickupAddressId,
        contactName: parsed.data.contactName,
        contactPhone: parsed.data.contactPhone,
        requestedWindowFrom: from,
        requestedWindowTo: to,
        ...(parsed.data.notes === undefined ? {} : { notes: parsed.data.notes }),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  // The new run belongs on the pickups list, where it can be accepted.
  revalidatePath(`/${toLocale(locale)}/pickups`);
  redirect(`/${toLocale(locale)}/pickups?created=${encodeURIComponent(created.id)}`);
}

const pickupIdSchema = z.object({
  pickupId: z.uuid(),
});

/**
 * Takes the request on: REQUESTED → ACCEPTED.
 *
 * Separate from claiming. Accepting says the courier will do it; claiming says
 * who goes. A commercial holds both for their own portfolio, but they are two
 * decisions and the state machine keeps them apart.
 */
export async function acceptPickup(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = pickupIdSchema.safeParse({ pickupId: formData.get("pickupId") });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch(`/v1/pickups/${encodeURIComponent(parsed.data.pickupId)}/accept`, {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: { idempotencyKey: randomUUID() },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  revalidatePath(`/${toLocale(locale)}/pickups`);
  return { error: null, fieldErrors: {} };
}

const claimSchema = z.object({
  pickupId: z.uuid(),
});

export async function claimPickup(
  locale: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = claimSchema.safeParse({ pickupId: formData.get("pickupId") });
  if (!parsed.success) {
    return { error: "validation", fieldErrors: {} };
  }

  try {
    await apiFetch(`/v1/pickups/${encodeURIComponent(parsed.data.pickupId)}/claim`, {
      method: "POST",
      // One key per submission. A commercial claiming a run on a phone in a
      // shop doorway will double-tap; the second attempt must not produce a
      // second state transition.
      idempotencyKey: randomUUID(),
      body: { idempotencyKey: randomUUID() },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // Two failures are ordinary rather than exceptional and both surface as
      // the row simply not being claimable: a colleague claimed it first
      // (PICKUP_INVALID_TRANSITION), or it belongs to a merchant outside this
      // caller's portfolio (404, never 403 — see invariant I25).
      return { error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }

  // The row's status and collector both changed; re-render the list so the
  // button disappears rather than lingering on an already-assigned run.
  revalidatePath(`/${toLocale(locale)}/pickups`);
  return { error: null, fieldErrors: {} };
}
