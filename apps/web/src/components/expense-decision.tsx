"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { approveExpense, rejectExpense } from "@/lib/expense-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Approve or refuse one dépense.
 *
 * ⚠️ APPROVING POSTS TO THE LEDGER — it debits an expense account and credits a
 * cash box or the bank. There is no undo: a mistake is corrected by a reversing
 * adjustment, so the button carries a warning line rather than a confirm dialog.
 * A `window.confirm` blocks the page and is dismissed reflexively; a sentence
 * the operator reads before choosing is what actually prevents the mistake.
 */
export function ExpenseDecision({
  expenseId,
  locale,
  postsToCash,
}: {
  expenseId: string;
  locale: Locale;
  /** True when the money leaves a hub's box, which reconciliation will see. */
  postsToCash: boolean;
}) {
  const messages = MESSAGES[locale];
  const [rejecting, setRejecting] = useState(false);

  if (rejecting) {
    return (
      <RejectForm
        expenseId={expenseId}
        locale={locale}
        onCancel={() => {
          setRejecting(false);
        }}
      />
    );
  }

  return (
    <div className="space-y-1">
      <ApproveForm expenseId={expenseId} locale={locale} postsToCash={postsToCash} />
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
  expenseId,
  locale,
  postsToCash,
}: {
  expenseId: string;
  locale: Locale;
  postsToCash: boolean;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(approveExpense.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="expenseId" value={expenseId} />
      {postsToCash ? (
        <p className="max-w-[16rem] text-[11px] text-amber-800">{messages.expenseCashWarning}</p>
      ) : null}
      <Submit
        label={messages.approveApplication}
        pendingLabel={messages.loading}
        className="inline-flex min-h-9 items-center rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
      />
      {state.error === null ? null : (
        <p role="alert" className="text-xs font-medium text-red-700">
          <span className="ltr-isolate font-mono">{state.error}</span>
        </p>
      )}
    </form>
  );
}

function RejectForm({
  expenseId,
  locale,
  onCancel,
}: {
  expenseId: string;
  locale: Locale;
  onCancel: () => void;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(rejectExpense.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="expenseId" value={expenseId} />
      <label className="sr-only" htmlFor={`reason-${expenseId}`}>
        {messages.reason}
      </label>
      <input
        id={`reason-${expenseId}`}
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
