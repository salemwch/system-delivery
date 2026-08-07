"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { acceptPickup } from "@/lib/pickup-actions";
import { apiErrorMessage } from "@/lib/api-errors";
import { INITIAL_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * "Yes, we will collect this."
 *
 * REQUESTED → ACCEPTED, the step before anyone can claim the run. Shown only on
 * REQUESTED rows: that is the sole transition into ACCEPTED, so a button
 * anywhere else is an offer the API would refuse.
 */
export function AcceptPickupButton({
  pickupId,
  locale,
}: {
  pickupId: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(acceptPickup.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="pickupId" value={pickupId} />
      <SubmitButton label={messages.acceptPickup} pendingLabel={messages.loading} />
      {state.error === null ? null : (
        <span role="alert" className="text-xs font-medium text-red-700">
          {apiErrorMessage(state.error, locale)}
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
      className="inline-flex min-h-9 items-center rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
