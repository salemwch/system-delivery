"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { approveAmendment, rejectAmendment } from "@/lib/amendment-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Approve or refuse one requested change.
 *
 * ⚠️ APPROVING WRITES TO THE PARCEL — a new phone number, a new destination, a
 * different amount of cash for the driver to collect. There is no undo: the
 * correction for a mistaken approval is another amendment, which is why the
 * previous values are snapshotted server-side when this button is pressed.
 *
 * Refusing opens a reason box first. The reason is mandatory in the action, in
 * the API schema and in a database CHECK; a button that failed until you typed
 * something would be a worse way to say the same thing.
 */
export function AmendmentDecision({
  amendmentId,
  locale,
}: {
  amendmentId: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [rejecting, setRejecting] = useState(false);

  if (rejecting) {
    return (
      <RejectForm
        amendmentId={amendmentId}
        locale={locale}
        onCancel={() => {
          setRejecting(false);
        }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <ApproveForm amendmentId={amendmentId} locale={locale} />
      <button
        type="button"
        onClick={() => {
          setRejecting(true);
        }}
        className="text-xs font-medium text-red-700 hover:underline"
      >
        {messages.rejectApplication}
      </button>
    </div>
  );
}

function ApproveForm({ amendmentId, locale }: { amendmentId: string; locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(approveAmendment.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action}>
      <input type="hidden" name="amendmentId" value={amendmentId} />
      <Submit
        label={messages.applyChange}
        pendingLabel={messages.loading}
        className="inline-flex min-h-9 items-center rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
      />
      {state.error === null ? null : (
        <p role="alert" className="mt-1 text-xs font-medium text-red-700">
          <span className="ltr-isolate font-mono">{state.error}</span>
        </p>
      )}
    </form>
  );
}

function RejectForm({
  amendmentId,
  locale,
  onCancel,
}: {
  amendmentId: string;
  locale: Locale;
  onCancel: () => void;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(rejectAmendment.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="amendmentId" value={amendmentId} />
      <label className="sr-only" htmlFor={`reason-${amendmentId}`}>
        {messages.reason}
      </label>
      <input
        id={`reason-${amendmentId}`}
        name="reason"
        required
        autoFocus
        maxLength={1000}
        placeholder={messages.reason}
        className={`${INPUT_CLASS} w-full`}
      />
      <div className="flex gap-2">
        <Submit
          label={messages.rejectApplication}
          pendingLabel={messages.loading}
          className="inline-flex min-h-9 items-center rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-medium text-slate-500 hover:underline"
        >
          {messages.cancel}
        </button>
      </div>
      {state.error === null || state.error === "validation" ? null : (
        <p role="alert" className="text-xs font-medium text-red-700">
          <span className="ltr-isolate font-mono">{state.error}</span>
        </p>
      )}
    </form>
  );
}

function Submit({
  label,
  pendingLabel,
  className,
}: {
  label: string;
  pendingLabel: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingLabel : label}
    </button>
  );
}
