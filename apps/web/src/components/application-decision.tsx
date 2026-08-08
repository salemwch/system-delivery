"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { approveApplication, rejectApplication } from "@/lib/application-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Approve or reject one application.
 *
 * ⚠️ APPROVAL IS NOT REVERSIBLE from this screen — it creates a merchant, and a
 * merchant is never deleted. The button therefore asks for the code up front
 * rather than approving on one click: the extra field is the pause.
 *
 * Rejection opens a reason box rather than rejecting immediately, because the
 * reason is mandatory in the API and in a database CHECK. A button that always
 * failed until you typed something would be a worse way to say the same thing.
 */
export function ApplicationDecision({
  applicationId,
  suggestedName,
  locale,
}: {
  applicationId: string;
  suggestedName: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [rejecting, setRejecting] = useState(false);

  if (rejecting) {
    return (
      <RejectForm
        applicationId={applicationId}
        locale={locale}
        onCancel={() => {
          setRejecting(false);
        }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <ApproveForm
        applicationId={applicationId}
        suggestedName={suggestedName}
        locale={locale}
      />
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

function ApproveForm({
  applicationId,
  suggestedName,
  locale,
}: {
  applicationId: string;
  suggestedName: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(approveApplication.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="applicationId" value={applicationId} />

      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor={`code-${applicationId}`}>
          {messages.reference}
        </label>
        <input
          id={`code-${applicationId}`}
          name="code"
          maxLength={50}
          placeholder={messages.reference}
          className={`${INPUT_CLASS} ltr-isolate w-28 font-mono`}
        />

        <label className="sr-only" htmlFor={`name-${applicationId}`}>
          {messages.legalName}
        </label>
        <input
          id={`name-${applicationId}`}
          name="name"
          maxLength={200}
          placeholder={suggestedName}
          className={`${INPUT_CLASS} w-44`}
        />

        <Submit
          label={messages.approveApplication}
          className="inline-flex min-h-9 items-center rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          pendingLabel={messages.loading}
        />
      </div>

      {state.error === null ? null : (
        <p role="alert" className="text-xs font-medium text-red-700">
          <span className="ltr-isolate font-mono">{state.error}</span>
        </p>
      )}
    </form>
  );
}

function RejectForm({
  applicationId,
  locale,
  onCancel,
}: {
  applicationId: string;
  locale: Locale;
  onCancel: () => void;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(rejectApplication.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="applicationId" value={applicationId} />

      <label className="sr-only" htmlFor={`reason-${applicationId}`}>
        {messages.reason}
      </label>
      <input
        id={`reason-${applicationId}`}
        name="reason"
        required
        maxLength={1000}
        autoFocus
        placeholder={messages.reason}
        className={`${INPUT_CLASS} w-full`}
      />

      <div className="flex gap-2">
        <Submit
          label={messages.rejectApplication}
          className="inline-flex min-h-9 items-center rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-60"
          pendingLabel={messages.loading}
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
