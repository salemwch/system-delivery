"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Field, INPUT_CLASS, SECONDARY_BUTTON_CLASS } from "./ui";
import { cancelShipment } from "@/lib/actions";
import { EMPTY_FORM_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Cancelling a parcel.
 *
 * ⚠️ Two steps, deliberately. Cancellation is irreversible and sits on a screen
 * a merchant reaches while browsing, so a single misplaced tap must not do it.
 * The confirmation also asks for a reason, which the courier needs and the audit
 * trail records.
 *
 * Only rendered for a parcel still `CREATED` or `ASSIGNED`. Past pickup the
 * courier physically holds it and the API refuses — showing the button anyway
 * would offer an action that always fails.
 */
export function CancelShipmentForm({
  locale,
  shipmentId,
}: {
  locale: Locale;
  shipmentId: string;
}) {
  const messages = MESSAGES[locale];
  const [confirming, setConfirming] = useState(false);
  const [state, action] = useActionState(cancelShipment.bind(null, locale), EMPTY_FORM_STATE);

  if (!confirming) {
    return (
      <section className="border-t border-slate-200 pt-4">
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
          className={`${SECONDARY_BUTTON_CLASS} border-red-300 text-red-700 hover:bg-red-50`}
        >
          {messages.cancelShipment}
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-red-300 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-900">{messages.cancelConfirm}</p>

      {state.error === null ? null : (
        <p role="alert" className="mt-2 text-sm font-medium text-red-800">
          {messages.somethingWentWrong}
        </p>
      )}

      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="shipmentId" value={shipmentId} />

        <Field label={messages.cancelReason} name="reason">
          <input id="reason" name="reason" required maxLength={500} className={INPUT_CLASS} />
        </Field>

        <div className="flex gap-2">
          <ConfirmButton label={messages.confirm} />
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
            className={SECONDARY_BUTTON_CLASS}
          >
            {messages.back}
          </button>
        </div>
      </form>
    </section>
  );
}

function ConfirmButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-800 disabled:opacity-60"
    >
      {pending ? "…" : label}
    </button>
  );
}
