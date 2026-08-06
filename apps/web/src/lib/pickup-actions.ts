"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import type { FormState } from "./form-state";
import { toLocale } from "./i18n";

/**
 * Taking a collection run.
 *
 * The command carries no collector: `POST /v1/pickups/:id/claim` reads it from
 * the bearer token, so this action *cannot* assign the run to anyone but the
 * signed-in user — which is exactly why a COMMERCIAL may hold it and
 * `pickup:assign` (dispatching the fleet) stays with dispatch.
 */

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
