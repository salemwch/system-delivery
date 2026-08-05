"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { signIn, submitMfa } from "@/lib/actions";
import { INITIAL_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { isMfaState } from "@/lib/login-state";
import type { LoginState } from "@/lib/login-state";

export function LoginForm({ locale }: { locale: Locale }) {
  const messages = MESSAGES[locale];
  const [loginState, loginAction] = useActionState(signIn.bind(null, locale), INITIAL_STATE as LoginState);
  const [mfaState, mfaAction] = useActionState(submitMfa.bind(null, locale), INITIAL_STATE as LoginState);

  const [mfa, setMfa] = useState<{
    status: "MFA_REQUIRED" | "MFA_ENROLMENT_REQUIRED";
    challenge: string;
    uri: string | undefined;
    secret: string | undefined;
  } | null>(null);

  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isMfaState(loginState)) {
      setMfa({
        status: loginState.status,
        challenge: loginState.challenge,
        uri: loginState.uri,
        secret: loginState.secret,
      });
    }
  }, [loginState]);

  useEffect(() => {
    if (mfa !== null) {
      codeRef.current?.focus();
    }
  }, [mfa]);

  if (mfa !== null) {
    const errorMsg = !isMfaState(mfaState) && mfaState.error !== null;
    return (
      <form action={mfaAction} className="mt-6 space-y-4">
        <input type="hidden" name="challenge" value={mfa.challenge} />
        <input type="hidden" name="status" value={mfa.status} />

        {errorMsg ? (
          <p
            role="alert"
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
          >
            {messages.invalidCredentials}
          </p>
        ) : null}

        <p className="text-sm text-slate-600">
          {mfa.status === "MFA_ENROLMENT_REQUIRED"
            ? messages.mfaEnrolRequired
            : messages.mfaRequired}
        </p>

        {mfa.status === "MFA_ENROLMENT_REQUIRED" && mfa.secret !== undefined ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">{messages.mfaEnrolInstructions}</p>
            <p className="ltr-isolate rounded bg-slate-100 px-3 py-2 text-center font-mono text-xs break-all select-all">
              {mfa.secret}
            </p>
          </div>
        ) : null}

        <Field label={messages.mfaCode} name="code">
          <input
            ref={codeRef}
            id="code"
            name="code"
            type="text"
            required
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            minLength={6}
            maxLength={8}
            dir="ltr"
            className={INPUT_CLASS}
          />
        </Field>

        <SubmitButton label={messages.mfaVerify} />
      </form>
    );
  }

  return (
    <form action={loginAction} className="mt-6 space-y-4">
      {!isMfaState(loginState) && loginState.error !== null ? (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {messages.invalidCredentials}
        </p>
      ) : null}

      <Field label={messages.email} name="email">
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="username"
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

      <SubmitButton label={messages.signIn} />
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${BUTTON_CLASS} w-full`}>
      {pending ? "…" : label}
    </button>
  );
}
