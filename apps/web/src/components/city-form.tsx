"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { saveCity } from "@/lib/city-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/** The subset of a city this form edits; `null` opens a blank one. */
export interface CityFormValues {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly governorate: string;
  readonly postalCode: string | null;
  /** Decimal strings, already formatted by the page against the exponent. */
  readonly deliveryFee: string;
  readonly returnFee: string;
  readonly deliveryDelayDays: number;
  readonly aliases: readonly string[];
}

/**
 * Add or edit a served city and its tariff.
 *
 * ⚠️ THE ALIASES ARE THE POINT, not decoration. A merchant's CSV says
 * "Ariana Ville" or "أريانة"; the courier's list says "Ariana". Every spelling
 * the operator adds here is one the import will price correctly instead of
 * rejecting, so the field is prominent and its hint explains the format.
 *
 * The code is immutable once created: it is written on paper manifests, and
 * changing it silently orphans every document that already carries it. The
 * input is therefore rendered read-only on an edit rather than hidden, so the
 * operator can see what it is.
 */
export function CityForm({
  locale,
  city,
  currency,
  exponent,
}: {
  locale: Locale;
  city: CityFormValues | null;
  currency: string;
  exponent: number;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(
    saveCity.bind(null, locale, city?.id ?? null),
    INITIAL_STATE,
  );

  return (
    <form
      action={action}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"
    >
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="exponent" value={exponent} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={messages.reference} name="code" error={state.fieldErrors["code"]}>
          <input
            id="code"
            name="code"
            required
            maxLength={50}
            readOnly={city !== null}
            defaultValue={city?.code ?? ""}
            placeholder="TUN-ARIANA"
            className={`${INPUT_CLASS} ltr-isolate font-mono ${city === null ? "" : "bg-slate-50 text-slate-500"}`}
          />
        </Field>

        <Field label={messages.city} name="name" error={state.fieldErrors["name"]}>
          <input
            id="name"
            name="name"
            required
            maxLength={120}
            defaultValue={city?.name ?? ""}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label={messages.nameArabic} name="nameAr" error={state.fieldErrors["nameAr"]}>
          <input
            id="nameAr"
            name="nameAr"
            dir="rtl"
            maxLength={120}
            defaultValue={city?.nameAr ?? ""}
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          label={messages.governorate}
          name="governorate"
          error={state.fieldErrors["governorate"]}
        >
          <input
            id="governorate"
            name="governorate"
            required
            maxLength={120}
            defaultValue={city?.governorate ?? ""}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label={messages.postalCode} name="postalCode" error={state.fieldErrors["postalCode"]}>
          <input
            id="postalCode"
            name="postalCode"
            maxLength={20}
            defaultValue={city?.postalCode ?? ""}
            className={`${INPUT_CLASS} ltr-isolate tabular-nums`}
          />
        </Field>

        <Field
          label={messages.deliveryDelay}
          name="deliveryDelayDays"
          error={state.fieldErrors["deliveryDelayDays"]}
        >
          <input
            id="deliveryDelayDays"
            type="number"
            name="deliveryDelayDays"
            min={0}
            max={365}
            required
            defaultValue={city?.deliveryDelayDays ?? 1}
            className={`${INPUT_CLASS} text-end tabular-nums`}
          />
        </Field>

        {/*
          Text inputs with `inputMode="decimal"`, not `type="number"`: a number
          input strips the trailing zero from "7.500", and an operator entering
          millimes reads that as the value having changed.
        */}
        <Field
          label={`${messages.deliveryFee} (${currency})`}
          name="deliveryFee"
          error={state.fieldErrors["deliveryFee"]}
        >
          <input
            id="deliveryFee"
            type="text"
            inputMode="decimal"
            name="deliveryFee"
            required
            defaultValue={city?.deliveryFee ?? ""}
            placeholder={(0).toFixed(exponent)}
            className={`${INPUT_CLASS} text-end tabular-nums`}
          />
        </Field>

        <Field
          label={`${messages.returnFee} (${currency})`}
          name="returnFee"
          error={state.fieldErrors["returnFee"]}
        >
          <input
            id="returnFee"
            type="text"
            inputMode="decimal"
            name="returnFee"
            required
            defaultValue={city?.returnFee ?? ""}
            placeholder={(0).toFixed(exponent)}
            className={`${INPUT_CLASS} text-end tabular-nums`}
          />
        </Field>
      </div>

      <Field
        label={messages.aliasesLabel}
        name="aliases"
        hint={messages.aliasesHint}
        error={state.fieldErrors["aliases"]}
      >
        <textarea
          id="aliases"
          name="aliases"
          rows={3}
          maxLength={2000}
          defaultValue={city?.aliases.join("\n") ?? ""}
          className={INPUT_CLASS}
        />
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton label={city === null ? messages.addCity : messages.save} pendingLabel={messages.loading} />
        {state.error === null ? null : (
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
    <button type="submit" disabled={pending} className={BUTTON_CLASS}>
      {pending ? pendingLabel : label}
    </button>
  );
}
