"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { updatePickupAddress } from "@/lib/merchant-actions";
import { INITIAL_STATE } from "@/lib/form-state";
import { apiErrorMessage, fieldErrorMessage } from "@/lib/api-errors";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Sets or replaces where the courier collects from.
 *
 * Rendered blank rather than pre-filled: a merchant stores only the address
 * ID, and the API returns no way to read the text back. Showing an empty box
 * beside "address on file / none" is honest; pre-filling it with a guess
 * would not be.
 */
export function PickupAddressForm({
  merchantId,
  hasAddress,
  locale,
}: {
  merchantId: string;
  hasAddress: boolean;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(updatePickupAddress.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="max-w-xl space-y-4">
      <input type="hidden" name="merchantId" value={merchantId} />

      <p className={hasAddress ? "text-sm text-slate-600" : "text-sm font-medium text-amber-800"}>
        {hasAddress ? messages.addressOnFile : messages.addressMissing}
      </p>

      {state.error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {apiErrorMessage(state.error, locale)}
        </p>
      ) : null}

      <Field
        label={messages.pickupAddress}
        name="pickupAddressLine"
        error={fieldErrorMessage(state.fieldErrors["addressLine"], locale)}
      >
        <input
          id="pickupAddressLine"
          name="addressLine"
          required
          maxLength={500}
          className={INPUT_CLASS}
        />
      </Field>

      <Field label={messages.city} name="pickupCity" error={fieldErrorMessage(state.fieldErrors["city"], locale)}>
        <input id="pickupCity" name="city" maxLength={200} className={INPUT_CLASS} />
      </Field>

      <SubmitButton label={hasAddress ? messages.save : messages.create} />
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
