"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { createMerchant } from "@/lib/merchant-actions";
import { INITIAL_STATE } from "@/lib/form-state";
import { apiErrorMessage, fieldErrorMessage } from "@/lib/api-errors";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Registers an *expéditeur*.
 *
 * A client component only because it needs pending state — a commercial
 * standing in a shop on a slow connection must see the button disable, or they
 * press it twice. The submission itself is a server action; nothing about the
 * merchant is written from the browser.
 */
export function MerchantForm({ locale }: { locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(createMerchant.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="max-w-xl space-y-4">
      {state.error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {apiErrorMessage(state.error, locale)}
        </p>
      ) : null}

      <Field label={messages.merchantName} name="name" error={fieldErrorMessage(state.fieldErrors["name"], locale)}>
        <input id="name" name="name" required maxLength={200} className={INPUT_CLASS} />
      </Field>

      <Field label={messages.merchantCode} name="code" error={fieldErrorMessage(state.fieldErrors["code"], locale)}>
        <input id="code" name="code" maxLength={50} className={`${INPUT_CLASS} ltr-isolate`} />
      </Field>

      <Field
        label={messages.contactName}
        name="contactName"
        error={fieldErrorMessage(state.fieldErrors["contactName"], locale)}
      >
        <input id="contactName" name="contactName" maxLength={200} className={INPUT_CLASS} />
      </Field>

      <Field
        label={messages.contactPhone}
        name="contactPhone"
        hint={messages.phoneHint}
        error={fieldErrorMessage(state.fieldErrors["contactPhone"], locale)}
      >
        <input
          id="contactPhone"
          name="contactPhone"
          type="tel"
          inputMode="tel"
          className={`${INPUT_CLASS} ltr-isolate`}
        />
      </Field>

      <Field
        label={messages.contactEmail}
        name="contactEmail"
        error={fieldErrorMessage(state.fieldErrors["contactEmail"], locale)}
      >
        <input
          id="contactEmail"
          name="contactEmail"
          type="email"
          maxLength={254}
          className={`${INPUT_CLASS} ltr-isolate`}
        />
      </Field>

      <Field
        label={messages.pickupAddress}
        name="addressLine"
        hint={messages.pickupAddressHint}
        error={fieldErrorMessage(state.fieldErrors["addressLine"], locale)}
      >
        <input id="addressLine" name="addressLine" maxLength={500} className={INPUT_CLASS} />
      </Field>

      <Field label={messages.city} name="city" error={fieldErrorMessage(state.fieldErrors["city"], locale)}>
        <input id="city" name="city" maxLength={200} className={INPUT_CLASS} />
      </Field>

      <SubmitButton label={messages.create} />
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
