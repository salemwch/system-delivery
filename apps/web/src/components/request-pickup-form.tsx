"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { requestPickup } from "@/lib/pickup-actions";
import { apiErrorMessage, fieldErrorMessage } from "@/lib/api-errors";
import { INITIAL_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * "Come and collect from this merchant."
 *
 * Rendered only when the merchant HAS a pickup address — the command requires
 * an address id, and offering a form that can only fail is worse than not
 * offering it. The merchant's own contact details are pre-filled because that
 * is who the driver will be looking for, and they are editable because the
 * person on the shop floor today is often somebody else.
 *
 * The window is two wall-clock inputs. They carry no timezone, so the action
 * reads them in the tenant's zone rather than the server's.
 */
export function RequestPickupForm({
  merchantId,
  pickupAddressId,
  contactName,
  contactPhone,
  defaultFrom,
  defaultTo,
  locale,
}: {
  merchantId: string;
  pickupAddressId: string;
  contactName: string;
  contactPhone: string;
  defaultFrom: string;
  defaultTo: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(requestPickup.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="max-w-xl space-y-4">
      <input type="hidden" name="merchantId" value={merchantId} />
      <input type="hidden" name="pickupAddressId" value={pickupAddressId} />

      {state.error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {apiErrorMessage(state.error, locale)}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={messages.pickupWindowFrom}
          name="from"
          error={fieldErrorMessage(state.fieldErrors["from"], locale)}
        >
          <input
            id="from"
            name="from"
            type="datetime-local"
            required
            defaultValue={defaultFrom}
            className={`${INPUT_CLASS} ltr-isolate`}
          />
        </Field>

        <Field
          label={messages.pickupWindowTo}
          name="to"
          error={fieldErrorMessage(state.fieldErrors["to"], locale)}
        >
          <input
            id="to"
            name="to"
            type="datetime-local"
            required
            defaultValue={defaultTo}
            className={`${INPUT_CLASS} ltr-isolate`}
          />
        </Field>
      </div>

      <Field
        label={messages.contactName}
        name="pickupContactName"
        error={fieldErrorMessage(state.fieldErrors["contactName"], locale)}
      >
        <input
          id="pickupContactName"
          name="contactName"
          required
          maxLength={200}
          defaultValue={contactName}
          className={INPUT_CLASS}
        />
      </Field>

      <Field
        label={messages.contactPhone}
        name="pickupContactPhone"
        hint={messages.phoneHint}
        error={fieldErrorMessage(state.fieldErrors["contactPhone"], locale)}
      >
        <input
          id="pickupContactPhone"
          name="contactPhone"
          type="tel"
          inputMode="tel"
          required
          defaultValue={contactPhone}
          className={`${INPUT_CLASS} ltr-isolate`}
        />
      </Field>

      <Field
        label={messages.notes}
        name="pickupNotes"
        error={fieldErrorMessage(state.fieldErrors["notes"], locale)}
      >
        <textarea id="pickupNotes" name="notes" maxLength={2000} rows={2} className={INPUT_CLASS} />
      </Field>

      <SubmitButton label={messages.requestPickup} />
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={BUTTON_CLASS}>
      {label}
    </button>
  );
}
