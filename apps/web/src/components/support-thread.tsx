"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { replyToTicket } from "@/lib/support-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface ThreadMessage {
  readonly id: string;
  readonly body: string;
  readonly visibility: string;
  readonly authorSide: string;
  /** Formatted by the server — the client has no tenant timezone. */
  readonly at: string;
}

/**
 * The conversation, and the box to add to it.
 *
 * ⚠️ AN INTERNAL NOTE IS VISUALLY UNMISTAKABLE — amber, labelled, and the
 * checkbox that produces one restates what it means. The merchant never
 * receives these rows at all (RLS strips them), so the styling is not what
 * protects them; it is what stops a staff member believing a public reply was
 * private, which is the mistake this design has to make hard.
 */
export function SupportThread({
  locale,
  ticketId,
  messages: thread,
  canReply,
  canWriteInternal,
  closed,
}: {
  locale: Locale;
  ticketId: string;
  messages: readonly ThreadMessage[];
  canReply: boolean;
  canWriteInternal: boolean;
  closed: boolean;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(replyToTicket.bind(null, locale), INITIAL_STATE);

  return (
    <section className="space-y-4">
      <ol className="space-y-3">
        {thread.map((message) => {
          const internal = message.visibility === "INTERNAL";
          const fromCourier = message.authorSide === "COURIER";
          return (
            <li
              key={message.id}
              className={
                internal
                  ? "rounded-xl border border-amber-300 bg-amber-50 p-4"
                  : fromCourier
                    ? "rounded-xl border border-slate-200 bg-white p-4"
                    : "rounded-xl border border-brand-soft bg-brand-soft/30 p-4"
              }
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700">
                  {fromCourier ? messages.sideCourier : messages.sideMerchant}
                  {internal ? (
                    <span className="ms-2 rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                      {messages.internalNote}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-slate-500">{message.at}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800">{message.body}</p>
            </li>
          );
        })}
      </ol>

      {closed ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {messages.ticketClosedHint}
        </p>
      ) : canReply ? (
        <form action={action} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <input type="hidden" name="ticketId" value={ticketId} />

          <label htmlFor="reply-body" className="sr-only">
            {messages.reply}
          </label>
          <textarea
            id="reply-body"
            name="body"
            rows={3}
            required
            maxLength={5000}
            placeholder={messages.reply}
            className={INPUT_CLASS}
          />

          {canWriteInternal ? (
            <label className="flex items-start gap-2 text-xs text-slate-600">
              <input type="checkbox" name="internal" value="on" className="mt-0.5 size-4" />
              <span>
                <span className="font-semibold text-amber-900">{messages.internalNote}</span>{" "}
                {messages.internalNoteHint}
              </span>
            </label>
          ) : null}

          <div className="flex items-center gap-3">
            <Submit label={messages.reply} pendingLabel={messages.loading} />
            {state.error === null || state.error === "validation" ? null : (
              <p role="alert" className="text-sm font-medium text-red-700">
                <span className="ltr-isolate font-mono">{state.error}</span>
              </p>
            )}
          </div>
        </form>
      ) : null}
    </section>
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
