"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { createNote, updateNote } from "@/lib/note-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface NoteItem {
  readonly id: string;
  readonly body: string;
  readonly authorName: string | null;
  readonly pinned: boolean;
  readonly resolvedAt: string | null;
  /** Already formatted by the server component — the client has no timezone. */
  readonly writtenAt: string;
}

/**
 * The remarks on one subject, plus the box to add another.
 *
 * ⚠️ NO EDIT CONTROL, on purpose. The body is frozen by a database trigger and a
 * correction is a new note. An edit box that always failed would be worse than
 * its absence; a working one would destroy the only property this log has.
 *
 * Resolving is how a remark leaves the queue. It stays readable afterwards —
 * "handled" is not "never happened".
 */
export function NotePanel({
  locale,
  subjectType,
  subjectId,
  notes,
  canWrite,
}: {
  locale: Locale;
  subjectType: "SHIPMENT" | "MERCHANT" | "DRIVER";
  subjectId: string;
  notes: readonly NoteItem[];
  canWrite: boolean;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(createNote.bind(null, locale), INITIAL_STATE);

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">{messages.internalRemarks}</h2>

      {notes.length === 0 ? (
        <p className="text-sm text-slate-500">{messages.noRemarks}</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className={
                note.pinned
                  ? "rounded-lg border border-amber-300 bg-amber-50 p-3"
                  : "rounded-lg border border-slate-200 p-3"
              }
            >
              <p className="whitespace-pre-wrap text-sm text-slate-800">{note.body}</p>
              <p className="mt-1 text-xs text-slate-500">
                {note.authorName ?? "—"} · {note.writtenAt}
              </p>
              {canWrite ? (
                <div className="mt-2 flex gap-2">
                  <StateButton
                    locale={locale}
                    noteId={note.id}
                    field="pinned"
                    value={note.pinned ? "false" : "true"}
                    label={note.pinned ? messages.unpin : messages.pin}
                  />
                  <StateButton
                    locale={locale}
                    noteId={note.id}
                    field="resolved"
                    value={note.resolvedAt === null ? "true" : "false"}
                    label={note.resolvedAt === null ? messages.resolveRemark : messages.reopen}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <form action={action} className="space-y-2 border-t border-slate-200 pt-3">
          <input type="hidden" name="subjectType" value={subjectType} />
          <input type="hidden" name="subjectId" value={subjectId} />

          <label htmlFor="note-body" className="sr-only">
            {messages.addRemark}
          </label>
          <textarea
            id="note-body"
            name="body"
            rows={2}
            required
            maxLength={2000}
            placeholder={messages.addRemark}
            className={INPUT_CLASS}
          />

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" name="pinned" value="on" className="size-4" />
              {messages.pin}
            </label>
            <AddButton label={messages.addRemark} pendingLabel={messages.loading} />
            {state.error === null ? null : (
              <p role="alert" className="text-xs font-medium text-red-700">
                <span className="ltr-isolate font-mono">{state.error}</span>
              </p>
            )}
          </div>
        </form>
      ) : null}
    </section>
  );
}

/** Pin/unpin or resolve/reopen — one form each, so each shows its own pending. */
function StateButton({
  locale,
  noteId,
  field,
  value,
  label,
}: {
  locale: Locale;
  noteId: string;
  field: "pinned" | "resolved";
  value: string;
  label: string;
}) {
  const [, action] = useActionState(updateNote.bind(null, locale), INITIAL_STATE);
  return (
    <form action={action}>
      <input type="hidden" name="noteId" value={noteId} />
      <input type="hidden" name={field} value={value} />
      <SmallSubmit label={label} />
    </form>
  );
}

function SmallSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
    >
      {label}
    </button>
  );
}

function AddButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-9 items-center rounded-lg bg-brand px-4 py-1.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
