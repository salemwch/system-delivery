"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { claimPickup } from "@/lib/pickup-actions";
import { INITIAL_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * "I'll take this one."
 *
 * A client component solely for pending state: a commercial standing in a shop
 * doorway on a slow connection will tap twice otherwise, and while the action
 * is idempotent, a button that does not visibly respond gets tapped a third
 * time. Rendered only on ACCEPTED rows, and only for a caller holding
 * `pickup:claim` — the API refuses it in every other case regardless.
 */
export function ClaimPickupButton({
  pickupId,
  locale,
}: {
  pickupId: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(claimPickup.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="pickupId" value={pickupId} />
      <SubmitButton label={messages.claimPickup} pendingLabel={messages.loading} />
      {state.error === null ? null : (
        <span role="alert" className="text-xs font-medium text-red-700">
          {messages.pickupNotClaimable}
        </span>
      )}
    </form>
  );
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-9 items-center rounded-lg border border-brand bg-white px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
