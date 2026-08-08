"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { INITIAL_STATE } from "@/lib/form-state";
import {
  cancelInvoiceDraft,
  createCreditNote,
  issueInvoice,
  markInvoicePaid,
} from "@/lib/invoice-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * The irreversible buttons.
 *
 * Client components solely for pending state and inline errors: issuing takes a
 * row lock on the tenant's number counter, so on a busy month-end it can visibly
 * wait, and a button that does not respond gets clicked again. The API is
 * idempotent per key, but a second click that produced a second invoice number
 * would be unrecoverable — so the button disables itself while in flight.
 *
 * Each is rendered ONLY on the status its transition starts from. A "Mark paid"
 * button on a draft is a button whose only outcome is an error message.
 */

/**
 * Issue: DRAFT → ISSUED.
 *
 * Carries a visible warning rather than a confirm dialog. A `window.confirm`
 * blocks the page and is dismissed reflexively; a sentence the operator reads
 * before choosing to click is the thing that actually prevents the mistake.
 */
export function IssueInvoiceButton({ invoiceId, locale }: { invoiceId: string; locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(issueInvoice.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <p className="text-xs text-amber-800">{messages.issueWarning}</p>
      <SubmitButton
        label={messages.issueInvoice}
        pendingLabel={messages.loading}
        className="inline-flex min-h-9 items-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <ErrorText state={state} fallback={messages.invoiceActionFailed} />
    </form>
  );
}

/** Record payment: ISSUED → PAID. */
export function MarkPaidButton({ invoiceId, locale }: { invoiceId: string; locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(markInvoicePaid.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <SubmitButton
        label={messages.markPaid}
        pendingLabel={messages.loading}
        className="inline-flex min-h-9 items-center rounded-lg border border-brand bg-white px-4 py-2 text-sm font-semibold text-brand transition hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-60"
      />
      <ErrorText state={state} fallback={messages.invoiceActionFailed} />
    </form>
  );
}

/** Cancel a DRAFT. Requires a reason, which is stored on the record. */
export function CancelDraftForm({ invoiceId, locale }: { invoiceId: string; locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(cancelInvoiceDraft.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <label className="block text-xs font-medium text-slate-600" htmlFor="cancel-reason">
        {messages.reason}
      </label>
      <input
        id="cancel-reason"
        name="reason"
        required
        maxLength={500}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
      />
      <SubmitButton
        label={messages.cancelDraft}
        pendingLabel={messages.loading}
        className="inline-flex min-h-9 items-center rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <ErrorText state={state} fallback={messages.invoiceActionFailed} />
    </form>
  );
}

/**
 * Draft an avoir against this invoice.
 *
 * Redirects to the new credit note on success, so the operator lands on the
 * document they must still review and issue — a credit note is not created
 * already issued, for the same reason an invoice is not.
 */
export function CreditNoteForm({ invoiceId, locale }: { invoiceId: string; locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(createCreditNote.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <label className="block text-xs font-medium text-slate-600" htmlFor="credit-reason">
        {messages.reason}
      </label>
      <input
        id="credit-reason"
        name="reason"
        required
        maxLength={500}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
      />
      <SubmitButton
        label={messages.createCreditNote}
        pendingLabel={messages.loading}
        className="inline-flex min-h-9 items-center rounded-lg border border-amber-400 bg-white px-4 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
      />
      <ErrorText state={state} fallback={messages.invoiceActionFailed} />
    </form>
  );
}

function SubmitButton({
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

/**
 * The API's own error code, falling back to a generic sentence.
 *
 * Showing the code matters: `INVOICE_EMPTY` and `INVOICE_NOT_DRAFT` need
 * different fixes, and a single "something went wrong" leaves the operator
 * clicking the same button again.
 */
function ErrorText({
  state,
  fallback,
}: {
  state: { readonly error: string | null };
  fallback: string;
}) {
  if (state.error === null) {
    return null;
  }
  return (
    <p role="alert" className="text-xs font-medium text-red-700">
      {fallback} <span className="ltr-isolate font-mono">({state.error})</span>
    </p>
  );
}
