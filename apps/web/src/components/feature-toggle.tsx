"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { INITIAL_STATE } from "@/lib/form-state";
import { setFeature } from "@/lib/tenant-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * One flag, on or off.
 *
 * A submit button rather than a checkbox that saves on change: a stray click on
 * a checkbox would silently turn COD off for the whole company. The button
 * states which direction it moves, so the action is deliberate and readable
 * before it is taken.
 *
 * ⚠️ The API refuses a change that breaks the dependency map — enabling linehaul
 * without multi-hub, or disabling multi-hub while linehaul is on — and its
 * message names the flags involved. Shown verbatim, because "cannot disable" is
 * useless without "because linehaul still needs it".
 */
export function FeatureToggle({
  featureKey,
  enabled,
  locale,
}: {
  featureKey: string;
  enabled: boolean;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(setFeature.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="key" value={featureKey} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <Submit enabled={enabled} onLabel={messages.enable} offLabel={messages.disable} />
      {state.error === null ? null : (
        <p role="alert" className="max-w-xs text-end text-xs font-medium text-red-700">
          <span className="ltr-isolate font-mono">{state.error}</span>
        </p>
      )}
    </form>
  );
}

function Submit({
  enabled,
  onLabel,
  offLabel,
}: {
  enabled: boolean;
  onLabel: string;
  offLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      // The CURRENT state is the colour; the label is the ACTION. Colouring by
      // the action would make an enabled feature look like a warning.
      className={
        enabled
          ? "min-h-9 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-900 transition hover:bg-emerald-100 disabled:opacity-60"
          : "min-h-9 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
      }
    >
      {enabled ? offLabel : onLabel}
    </button>
  );
}
