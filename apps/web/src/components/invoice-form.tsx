"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { createInvoiceDraft } from "@/lib/invoice-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface MerchantOption {
  readonly id: string;
  readonly name: string;
}

/**
 * Drafts a facture.
 *
 * A client component for one reason beyond pending state: the line table grows.
 * Everything else is a plain uncontrolled form, so a slow connection or a
 * hydration failure still leaves a form the browser can submit on its own.
 *
 * ⚠️ Prices are typed as DECIMALS ("4.500") and converted to minor units in the
 * server action, by string arithmetic. Doing it here in JavaScript would put
 * `4.005 * 1000 === 4004.999999999999` onto a tax document.
 *
 * The currency's exponent travels in a hidden field rather than being assumed:
 * TND has three decimals and EUR has two, and the conversion has to know which.
 */
export function InvoiceForm({
  locale,
  merchants,
  currency,
  exponent,
  defaultPeriodFrom,
  defaultPeriodTo,
}: {
  locale: Locale;
  merchants: readonly MerchantOption[];
  currency: string;
  exponent: number;
  defaultPeriodFrom: string;
  defaultPeriodTo: string;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(createInvoiceDraft.bind(null, locale), INITIAL_STATE);
  // One row to start. The operator adds more; there is no maximum worth
  // enforcing here — the API caps the payload.
  const [lineCount, setLineCount] = useState(1);

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="exponent" value={exponent} />

      <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <Field
          label={messages.merchants}
          name="merchantId"
          error={state.fieldErrors["merchantId"]}
        >
          <select id="merchantId" name="merchantId" required className={INPUT_CLASS} defaultValue="">
            <option value="" disabled>
              —
            </option>
            {merchants.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={messages.period}
          name="periodFrom"
          hint={currency}
          error={state.fieldErrors["periodFrom"]}
        >
          <input
            id="periodFrom"
            type="date"
            name="periodFrom"
            required
            defaultValue={defaultPeriodFrom}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="→" name="periodTo" error={state.fieldErrors["periodTo"]}>
          <input
            id="periodTo"
            type="date"
            name="periodTo"
            required
            defaultValue={defaultPeriodTo}
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-900">{messages.description}</h2>

        {Array.from({ length: lineCount }, (_, index) => (
          <div key={index} className="grid gap-3 sm:grid-cols-[1fr_5rem_8rem]">
            <input
              name={`lines[${String(index)}].description`}
              placeholder={messages.description}
              maxLength={500}
              className={INPUT_CLASS}
              aria-label={`${messages.description} ${String(index + 1)}`}
            />
            <input
              type="number"
              name={`lines[${String(index)}].quantity`}
              min={1}
              step={1}
              defaultValue={1}
              className={INPUT_CLASS}
              aria-label={`${messages.quantity} ${String(index + 1)}`}
            />
            {/*
              `inputMode="decimal"` and a text input, not `type="number"`:
              a number input strips a trailing zero, so "4.500" becomes "4.5" —
              still correct here because the action pads to the exponent, but
              it reads as data loss to an operator entering millimes.
            */}
            <input
              type="text"
              inputMode="decimal"
              name={`lines[${String(index)}].unitPrice`}
              placeholder="0.000"
              className={`${INPUT_CLASS} text-end tabular-nums`}
              aria-label={`${messages.unitPrice} ${String(index + 1)}`}
            />
          </div>
        ))}

        <button
          type="button"
          onClick={() => {
            setLineCount((count) => count + 1);
          }}
          className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          + {messages.addLine}
        </button>

        {state.fieldErrors["lines"] === undefined ? null : (
          <p role="alert" className="text-xs font-medium text-red-700">
            {messages.addLine}
          </p>
        )}
      </div>

      <Field label={messages.reason} name="notes" error={state.fieldErrors["notes"]}>
        <textarea id="notes" name="notes" maxLength={2000} rows={2} className={INPUT_CLASS} />
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton label={messages.create} pendingLabel={messages.loading} />
        {state.error === null || state.error === "validation" ? null : (
          <p role="alert" className="text-sm font-medium text-red-700">
            <span className="ltr-isolate font-mono">{state.error}</span>
          </p>
        )}
      </div>
    </form>
  );
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-10 items-center rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
