"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { INPUT_CLASS } from "@/components/ui";
import { approveCorrection, rejectCorrection } from "@/lib/correction-actions";
import { INITIAL_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Approve or refuse one held pin correction.
 *
 * One form, two submit buttons, so the optional note goes with whichever
 * decision is pressed; each button names its own action (`formAction`).
 * Enter in the note field is swallowed: implicit submission would press the
 * FIRST button, and approving moves the pin every later delivery relies on.
 */
export function CorrectionDecision({
  correctionId,
  locale,
}: {
  correctionId: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [approveState, approve] = useActionState(
    approveCorrection.bind(null, locale),
    INITIAL_STATE,
  );
  const [rejectState, reject] = useActionState(rejectCorrection.bind(null, locale), INITIAL_STATE);
  const error = approveState.error ?? rejectState.error;

  return (
    <form className="space-y-2">
      <input type="hidden" name="correctionId" value={correctionId} />
      <label className="sr-only" htmlFor={`note-${correctionId}`}>
        {messages.correctionNote}
      </label>
      <input
        id={`note-${correctionId}`}
        name="note"
        maxLength={1000}
        placeholder={messages.correctionNote}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
        className={`${INPUT_CLASS} w-full`}
      />
      <div className="flex flex-wrap gap-2">
        <Submit
          action={approve}
          label={messages.approveCorrection}
          pendingLabel={messages.loading}
          className="inline-flex min-h-9 items-center rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
        />
        <Submit
          action={reject}
          label={messages.rejectApplication}
          pendingLabel={messages.loading}
          className="inline-flex min-h-9 items-center rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-60"
        />
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs font-medium text-red-700">
          <span className="ltr-isolate font-mono">{error}</span>
        </p>
      )}
    </form>
  );
}

function Submit({
  action,
  label,
  pendingLabel,
  className,
}: {
  action: (formData: FormData) => void;
  label: string;
  pendingLabel: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" formAction={action} disabled={pending} className={className}>
      {pending ? pendingLabel : label}
    </button>
  );
}
