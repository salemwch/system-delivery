"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { signIn } from "@/lib/actions";
import { EMPTY_FORM_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * The sign-in form.
 *
 * A client component only because it needs pending state — the credentials
 * themselves are posted to a server action and never touched by client code.
 *
 * ⚠️ ONE error message for every failure. Wrong password, unknown email and
 * locked account are indistinguishable here, because telling them apart turns
 * this form into an oracle for which addresses have accounts.
 */
export function LoginForm({ locale }: { locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(signIn.bind(null, locale), EMPTY_FORM_STATE);

  return (
    <form action={action} className="mt-6 space-y-4">
      {state.error === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {messages.signInFailed}
        </p>
      )}

      <Field label={messages.email} name="email">
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
          // A merchant on a phone should get the email keyboard, and iOS should
          // not capitalise the first letter of an address.
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
          className={INPUT_CLASS}
        />
      </Field>

      <Field label={messages.password} name="password">
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          dir="ltr"
          className={INPUT_CLASS}
        />
      </Field>

      <SubmitButton label={messages.signInAction} />
    </form>
  );
}

/**
 * Disabled while submitting.
 *
 * Not cosmetic: without it a merchant on a slow connection taps twice, and the
 * second attempt races the first — which for a login means a spurious failed
 * attempt counted against the account's lockout threshold.
 */
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${BUTTON_CLASS} w-full`}>
      {pending ? "…" : label}
    </button>
  );
}
