"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { logLead } from "@/lib/application-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * A lead a commercial logged after meeting someone.
 *
 * Collapsed by default: this page is a queue, and a form permanently occupying
 * the top of it pushes the work out of sight. Opening it is one click and the
 * queue is still visible below.
 *
 * The lead is recorded as an APPLICATION, not as a merchant — even though the
 * person entering it has `merchant:create` and could make one directly. That is
 * the point: a lead someone met is not yet an account, and putting it in the
 * queue means the decision is still recorded when it is taken.
 */
export function LeadForm({ locale }: { locale: Locale }) {
  const messages = MESSAGES[locale];
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(logLead.bind(null, locale), INITIAL_STATE);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
      >
        + {messages.logLead}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={messages.merchants}
          name="businessName"
          error={state.fieldErrors["businessName"]}
        >
          <input
            id="businessName"
            name="businessName"
            required
            maxLength={200}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label={messages.contact} name="contactName" error={state.fieldErrors["contactName"]}>
          <input id="contactName" name="contactName" required maxLength={200} className={INPUT_CLASS} />
        </Field>

        {/*
          `24201314` is what a Tunisian types. The action normalises it to E.164
          before the API sees it, so the hint describes the local form rather
          than demanding the international one.
        */}
        <Field
          label={messages.phone}
          name="contactPhone"
          hint="24201314"
          error={state.fieldErrors["contactPhone"]}
        >
          <input
            id="contactPhone"
            type="tel"
            name="contactPhone"
            required
            inputMode="tel"
            className={`${INPUT_CLASS} ltr-isolate`}
          />
        </Field>

        <Field label={messages.email} name="contactEmail" error={state.fieldErrors["contactEmail"]}>
          <input
            id="contactEmail"
            type="email"
            name="contactEmail"
            maxLength={254}
            className={`${INPUT_CLASS} ltr-isolate`}
          />
        </Field>

        <Field label={messages.city} name="city" error={state.fieldErrors["city"]}>
          <input id="city" name="city" maxLength={120} className={INPUT_CLASS} />
        </Field>

        <Field
          label={messages.expectedVolume}
          name="expectedVolume"
          error={state.fieldErrors["expectedVolume"]}
        >
          <input
            id="expectedVolume"
            type="number"
            name="expectedVolume"
            min={0}
            max={1000000}
            className={`${INPUT_CLASS} text-end tabular-nums`}
          />
        </Field>
      </div>

      <Field label={messages.reason} name="message" error={state.fieldErrors["message"]}>
        <textarea id="message" name="message" rows={2} maxLength={2000} className={INPUT_CLASS} />
      </Field>

      <div className="flex items-center gap-3">
        <Submit label={messages.logLead} pendingLabel={messages.loading} />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
          className="text-sm text-slate-500 hover:underline"
        >
          {messages.cancel}
        </button>
        {state.error === null || state.error === "validation" ? null : (
          <p role="alert" className="text-sm font-medium text-red-700">
            <span className="ltr-isolate font-mono">{state.error}</span>
          </p>
        )}
      </div>
    </form>
  );
}

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={BUTTON_CLASS}>
      {pending ? pendingLabel : label}
    </button>
  );
}
