"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { updateBillingSettings } from "@/lib/invoice-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * The tenant's billing configuration.
 *
 * ⚠️ Changing the VAT rate NEVER touches an existing invoice. Every document
 * stores the rate it was drafted with, so a correction today cannot rewrite what
 * a customer was charged last quarter — which is why this screen carries no
 * warning about historical data: there is nothing to warn about.
 *
 * The rate is entered as a percentage ("19", "19.5") and stored in basis points.
 * Entering it in basis points would be technically honest and practically a
 * source of hundredfold mistakes.
 */
export function BillingSettingsForm({
  locale,
  vatRateBp,
  stampDuty,
  paymentTermsDays,
  legalName,
  taxIdentifier,
  legalAddress,
  currency,
  exponent,
}: {
  locale: Locale;
  vatRateBp: number;
  /** Already formatted as a decimal string by the page. */
  stampDuty: string;
  paymentTermsDays: number;
  legalName: string | null;
  taxIdentifier: string | null;
  legalAddress: string | null;
  currency: string;
  exponent: number;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(updateBillingSettings.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="max-w-xl space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <input type="hidden" name="exponent" value={exponent} />

      <Field label={messages.vatRate} name="vatRate" error={state.fieldErrors["vatRate"]}>
        <input
          id="vatRate"
          type="text"
          inputMode="decimal"
          name="vatRate"
          required
          // Basis points → percent for display. Two decimals, so 1950 shows as
          // "19.50" and round-trips back to 1950 exactly.
          defaultValue={(vatRateBp / 100).toFixed(2)}
          className={`${INPUT_CLASS} text-end tabular-nums`}
        />
      </Field>

      <Field
        label={`${messages.stampDuty} (${currency})`}
        name="stampDuty"
        error={state.fieldErrors["stampDuty"]}
      >
        <input
          id="stampDuty"
          type="text"
          inputMode="decimal"
          name="stampDuty"
          required
          defaultValue={stampDuty}
          className={`${INPUT_CLASS} text-end tabular-nums`}
        />
      </Field>

      <Field
        label={messages.paymentTerms}
        name="paymentTermsDays"
        error={state.fieldErrors["paymentTermsDays"]}
      >
        <input
          id="paymentTermsDays"
          type="number"
          name="paymentTermsDays"
          min={0}
          max={365}
          required
          defaultValue={paymentTermsDays}
          className={`${INPUT_CLASS} text-end tabular-nums`}
        />
      </Field>

      <Field label={messages.legalName} name="legalName" error={state.fieldErrors["legalName"]}>
        <input
          id="legalName"
          name="legalName"
          maxLength={200}
          defaultValue={legalName ?? ""}
          className={INPUT_CLASS}
        />
      </Field>

      <Field
        label={messages.taxIdentifier}
        name="taxIdentifier"
        error={state.fieldErrors["taxIdentifier"]}
      >
        <input
          id="taxIdentifier"
          name="taxIdentifier"
          maxLength={50}
          defaultValue={taxIdentifier ?? ""}
          className={`${INPUT_CLASS} ltr-isolate font-mono`}
        />
      </Field>

      <Field label={messages.legalAddress} name="legalAddress" error={state.fieldErrors["legalAddress"]}>
        <textarea
          id="legalAddress"
          name="legalAddress"
          maxLength={500}
          rows={2}
          defaultValue={legalAddress ?? ""}
          className={INPUT_CLASS}
        />
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton label={messages.save} pendingLabel={messages.loading} />
        <Result state={state} savedLabel={messages.save} />
      </div>
    </form>
  );
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={BUTTON_CLASS}>
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Success or failure, in place.
 *
 * The action refreshes the page rather than redirecting, so `error === null`
 * after a submit means it landed. Distinguishing "not yet submitted" from
 * "submitted successfully" would need a third state the form does not have and
 * the operator does not need: the fields already show what was saved.
 */
function Result({
  state,
  savedLabel,
}: {
  state: { readonly error: string | null };
  savedLabel: string;
}) {
  if (state.error === null) {
    return null;
  }
  return (
    <p role="alert" className="text-sm font-medium text-red-700">
      {savedLabel} <span className="ltr-isolate font-mono">({state.error})</span>
    </p>
  );
}
