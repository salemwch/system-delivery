"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { createPortalLogin } from "@/lib/merchant-actions";
import { INITIAL_CREDENTIAL_STATE } from "@/lib/form-state";
import { apiErrorMessage, fieldErrorMessage } from "@/lib/api-errors";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Mints the *expéditeur*'s portal login and shows the password once.
 *
 * The credential lives in this component's action state and nowhere else — not
 * in the URL, not re-fetchable, gone on the next navigation. That is the whole
 * design: possession of the password is evidence of having just created it.
 */
export function PortalLoginForm({
  merchantId,
  locale,
}: {
  merchantId: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(createPortalLogin, INITIAL_CREDENTIAL_STATE);

  if (state.credential !== null) {
    return (
      <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4">
        <p className="text-sm font-medium text-emerald-900">{messages.credentialShownOnce}</p>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-emerald-800">{messages.email}</dt>
            <dd className="ltr-isolate font-mono break-all select-all">
              {state.credential.email}
            </dd>
          </div>
          <div>
            <dt className="text-emerald-800">{messages.temporaryPassword}</dt>
            <dd className="ltr-isolate font-mono text-base break-all select-all">
              {state.credential.password}
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <form action={action} className="max-w-xl space-y-4">
      <input type="hidden" name="merchantId" value={merchantId} />

      {state.error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {apiErrorMessage(state.error, locale)}
        </p>
      ) : null}

      <Field label={messages.fullName} name="fullName" error={fieldErrorMessage(state.fieldErrors["fullName"], locale)}>
        <input id="fullName" name="fullName" required maxLength={200} className={INPUT_CLASS} />
      </Field>

      <Field label={messages.email} name="email" error={fieldErrorMessage(state.fieldErrors["email"], locale)}>
        <input
          id="email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="off"
          className={`${INPUT_CLASS} ltr-isolate`}
        />
      </Field>

      <Field label={messages.phone} name="phone" hint={messages.phoneHint} error={fieldErrorMessage(state.fieldErrors["phone"], locale)}>
        <input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          className={`${INPUT_CLASS} ltr-isolate`}
        />
      </Field>

      <SubmitButton label={messages.createPortalLogin} />
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
