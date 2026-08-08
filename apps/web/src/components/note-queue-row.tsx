"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { INITIAL_STATE } from "@/lib/form-state";
import { updateNote } from "@/lib/note-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import type { NoteSummary } from "@/lib/queries";

/**
 * One row of the remarks queue.
 *
 * A client component only because the resolve button needs pending state — the
 * row itself is static. The button is the whole reason this is a work list
 * rather than a report: a queue you cannot clear from is a queue nobody uses.
 */
export function NoteQueueRow({
  locale,
  note,
  href,
  writtenAt,
  canWrite,
}: {
  locale: Locale;
  note: NoteSummary;
  href: string;
  /** Formatted on the server — the client has no tenant timezone. */
  writtenAt: string;
  canWrite: boolean;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(updateNote.bind(null, locale), INITIAL_STATE);
  const open = note.resolvedAt === null;

  return (
    <tr className="hover:bg-slate-50">
      <td className="px-4 py-3">
        <Link href={href} className="text-sm text-brand hover:underline">
          {subjectLabel(note.subjectType, locale)}
        </Link>
      </td>
      <td className="px-4 py-3 text-sm text-slate-800">
        {note.pinned ? <span className="me-1 text-amber-600">★</span> : null}
        {note.body}
      </td>
      <td className="px-4 py-3 text-sm text-slate-600">{note.authorName ?? "—"}</td>
      <td className="px-4 py-3 text-sm text-slate-500">{writtenAt}</td>
      <td className="px-4 py-3">
        {canWrite ? (
          <form action={action}>
            <input type="hidden" name="noteId" value={note.id} />
            <input type="hidden" name="resolved" value={open ? "true" : "false"} />
            <Submit label={open ? messages.resolveRemark : messages.reopen} />
            {state.error === null ? null : (
              <p role="alert" className="mt-1 text-xs font-medium text-red-700">
                <span className="ltr-isolate font-mono">{state.error}</span>
              </p>
            )}
          </form>
        ) : null}
      </td>
    </tr>
  );
}

function subjectLabel(subjectType: string, locale: Locale): string {
  const messages = MESSAGES[locale];
  switch (subjectType) {
    case "SHIPMENT":
      return messages.shipments;
    case "MERCHANT":
      return messages.merchants;
    default:
      return messages.fleet;
  }
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
    >
      {label}
    </button>
  );
}
