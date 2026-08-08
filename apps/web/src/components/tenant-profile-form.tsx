"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { updateTenantProfile } from "@/lib/tenant-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import type { TenantProfile } from "@/lib/queries";

const LOCALES = ["ar", "fr", "en"] as const;

/** The zones a Tunisian courier plausibly operates in, plus UTC as an escape. */
const TIMEZONES = ["Africa/Tunis", "Africa/Algiers", "Africa/Casablanca", "Europe/Paris", "UTC"];

/**
 * Général — the courier's own name, timezone and languages.
 *
 * ⚠️ THE DEFAULT LANGUAGE MUST BE ONE OF THE SUPPORTED ONES, and the form
 * enforces it live rather than letting the API reject the submission: the
 * default select lists only what is currently ticked. A server-side rejection
 * would be correct and useless — the operator would have to work out which of
 * two fields to change.
 *
 * The API checks it too. This is the courtesy; that is the guarantee.
 */
export function TenantProfileForm({
  locale,
  profile,
}: {
  locale: Locale;
  profile: TenantProfile;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(updateTenantProfile.bind(null, locale), INITIAL_STATE);
  const [supported, setSupported] = useState<readonly string[]>(profile.supportedLocales);

  return (
    <form action={action} className="max-w-xl space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <Field label={messages.courierName} name="name" error={state.fieldErrors["name"]}>
        <input
          id="name"
          name="name"
          required
          maxLength={200}
          defaultValue={profile.name}
          className={INPUT_CLASS}
        />
      </Field>

      <Field
        label={messages.timezoneLabel}
        name="timezone"
        hint={messages.timezoneHint}
        error={state.fieldErrors["timezone"]}
      >
        <select
          id="timezone"
          name="timezone"
          defaultValue={profile.timezone}
          className={INPUT_CLASS}
        >
          {/* The current value first, in case it is one this list does not carry —
              a tenant provisioned with an unusual zone must not have it silently
              replaced by whichever option happens to be first. */}
          {[profile.timezone, ...TIMEZONES.filter((tz) => tz !== profile.timezone)].map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </Field>

      <fieldset>
        <legend className="mb-1 block text-sm font-medium text-slate-700">
          {messages.supportedLanguages}
        </legend>
        <div className="flex gap-4">
          {LOCALES.map((candidate) => (
            <label key={candidate} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="supportedLocales"
                value={candidate}
                defaultChecked={profile.supportedLocales.includes(candidate)}
                onChange={(event) => {
                  setSupported((current) =>
                    event.target.checked
                      ? [...current, candidate]
                      : current.filter((value) => value !== candidate),
                  );
                }}
                className="size-4"
              />
              {candidate.toUpperCase()}
            </label>
          ))}
        </div>
        {state.fieldErrors["supportedLocales"] === undefined ? null : (
          <p role="alert" className="mt-1 text-xs font-medium text-red-700">
            {messages.errorRequired}
          </p>
        )}
      </fieldset>

      <Field
        label={messages.defaultLanguage}
        name="defaultLocale"
        error={state.fieldErrors["defaultLocale"]}
      >
        <select
          id="defaultLocale"
          name="defaultLocale"
          defaultValue={profile.defaultLocale}
          className={INPUT_CLASS}
        >
          {/* Only what is ticked above: a default the courier does not publish
              would render every document in a language they do not offer. */}
          {supported.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate.toUpperCase()}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex items-center gap-3">
        <Submit label={messages.save} pendingLabel={messages.loading} />
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
