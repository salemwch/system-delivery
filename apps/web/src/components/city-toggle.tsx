"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { INITIAL_STATE } from "@/lib/form-state";
import { setCityActive } from "@/lib/city-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Retire a city, or bring it back.
 *
 * Never a delete, and the label says so: past invoices reference the tariff a
 * city carried, so removing the row would leave documents pointing at nothing.
 * Retiring stops it being quoted for new shipments and changes nothing else.
 */
export function CityToggle({
  cityId,
  active,
  locale,
}: {
  cityId: string;
  active: boolean;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(setCityActive.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action}>
      <input type="hidden" name="cityId" value={cityId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <SubmitButton label={active ? messages.retire : messages.restore} pending={messages.loading} />
      {state.error === null ? null : (
        <p role="alert" className="mt-1 text-xs font-medium text-red-700">
          <span className="ltr-isolate font-mono">{state.error}</span>
        </p>
      )}
    </form>
  );
}

function SubmitButton({ label, pending: pendingLabel }: { label: string; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
