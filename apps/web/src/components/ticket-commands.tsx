"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { INITIAL_STATE } from "@/lib/form-state";
import { updateTicket } from "@/lib/support-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Close, resolve or reopen a ticket.
 *
 * Each button is rendered only on the status its transition starts from — a
 * "close" button on an already-closed ticket is a button whose only outcome is
 * an error message.
 *
 * Resolving and closing are deliberately separate. RESOLVED means "we answered";
 * CLOSED means "no more replies", and a merchant who disagrees with the answer
 * needs a thread that is still open to say so.
 */
export function TicketCommands({
  ticketId,
  status,
  locale,
}: {
  ticketId: string;
  status: string;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];

  if (status === "CLOSED") {
    return (
      <StatusButton
        ticketId={ticketId}
        to="OPEN"
        locale={locale}
        label={messages.reopen}
        className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50 disabled:opacity-60"
      />
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {status === "RESOLVED" ? null : (
        <StatusButton
          ticketId={ticketId}
          to="RESOLVED"
          locale={locale}
          label={messages.markResolved}
          className="inline-flex min-h-9 items-center rounded-lg border border-brand bg-white px-4 py-2 text-sm font-semibold text-brand transition hover:bg-brand-soft disabled:opacity-60"
        />
      )}
      <StatusButton
        ticketId={ticketId}
        to="CLOSED"
        locale={locale}
        label={messages.closeTicket}
        className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
      />
    </div>
  );
}

function StatusButton({
  ticketId,
  to,
  locale,
  label,
  className,
}: {
  ticketId: string;
  to: string;
  locale: Locale;
  label: string;
  className: string;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(updateTicket.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="status" value={to} />
      <Submit label={label} pendingLabel={messages.loading} className={className} />
      {state.error === null ? null : (
        <p role="alert" className="mt-1 text-xs font-medium text-red-700">
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
