"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { IDLE_APPLICATION } from "@/lib/application-state";
import { submitApplication } from "@/lib/register-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * The account application — for a shipper who has no login yet.
 *
 * ⚠️ ON SUCCESS THE FORM IS REPLACED BY A CONFIRMATION, not merely cleared. This
 * is the one screen in the portal where the applicant gets no other feedback:
 * there is no account to log into, no email guaranteed, nothing to check. A form
 * that looked the same after submitting would be submitted again, and again.
 *
 * The confirmation is identical whether this was a first application or a repeat
 * from a number the courier already has — see `register-actions.ts` for why that
 * matters.
 */
export function RegisterForm({ locale }: { locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(submitApplication, IDLE_APPLICATION);

  if (state.status === "sent") {
    return (
      <div className="mt-6 space-y-3" role="status">
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
          {messages.applicationReceived}
        </p>
        <p className="text-sm text-slate-600">{messages.applicationReceivedHint}</p>
        <Link href={`/${locale}/login`} className="text-sm font-medium text-brand hover:underline">
          {messages.backToSignIn}
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="mt-6 space-y-4">
      {state.error === null || state.error === "validation" ? null : (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {messages.somethingWentWrong}
        </p>
      )}

      <Field
        label={messages.businessName}
        name="businessName"
        error={state.fieldErrors["businessName"]}
      >
        <input id="businessName" name="businessName" required maxLength={200} className={INPUT_CLASS} />
      </Field>

      <Field
        label={messages.contactName}
        name="contactName"
        error={state.fieldErrors["contactName"]}
      >
        <input id="contactName" name="contactName" required maxLength={200} className={INPUT_CLASS} />
      </Field>

      {/*
        The local form is what a Tunisian types; the action normalises it to
        E.164 before the API sees it. The hint shows the shape they already use.
      */}
      <Field
        label={messages.contactPhone}
        name="contactPhone"
        hint={messages.recipientPhoneHint}
        error={state.fieldErrors["contactPhone"]}
      >
        <input
          id="contactPhone"
          name="contactPhone"
          type="tel"
          required
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          className={INPUT_CLASS}
        />
      </Field>

      <Field label={messages.email} name="contactEmail" error={state.fieldErrors["contactEmail"]}>
        <input
          id="contactEmail"
          name="contactEmail"
          type="email"
          maxLength={254}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
          className={INPUT_CLASS}
        />
      </Field>

      <Field label={messages.city} name="city" error={state.fieldErrors["city"]}>
        <input id="city" name="city" maxLength={120} className={INPUT_CLASS} />
      </Field>

      <Field
        label={messages.expectedVolume}
        name="expectedVolume"
        hint={messages.expectedVolumeHint}
        error={state.fieldErrors["expectedVolume"]}
      >
        <input
          id="expectedVolume"
          name="expectedVolume"
          type="number"
          min={0}
          max={1000000}
          inputMode="numeric"
          className={`${INPUT_CLASS} text-end tabular-nums`}
        />
      </Field>

      <Field label={messages.tellUsMore} name="message" error={state.fieldErrors["message"]}>
        <textarea id="message" name="message" rows={3} maxLength={2000} className={INPUT_CLASS} />
      </Field>

      <SubmitButton label={messages.submitApplication} pendingLabel={messages.loading} />

      <Link
        href={`/${locale}/login`}
        className="block text-center text-sm text-slate-500 hover:underline"
      >
        {messages.backToSignIn}
      </Link>
    </form>
  );
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${BUTTON_CLASS} w-full`}>
      {pending ? pendingLabel : label}
    </button>
  );
}
