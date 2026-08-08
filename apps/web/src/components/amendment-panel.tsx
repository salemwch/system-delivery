"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { requestAmendment } from "@/lib/amendment-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface AmendmentItem {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly decisionReason: string | null;
  /** Already rendered by the server as "field: old → new" lines. */
  readonly lines: readonly string[];
  readonly at: string;
}

/**
 * A parcel's change history, and the form to ask for another.
 *
 * ⚠️ Only ONE open request per parcel exists, so when one is pending the form is
 * replaced by it. Offering a second would produce a conflict the operator can
 * neither predict nor act on — the database refuses it, and a form that always
 * failed would be a worse way to say so.
 *
 * A dispatcher's own request is applied on the spot, because they hold the
 * approve permission. The button says so rather than saying "request".
 */
export function AmendmentPanel({
  locale,
  shipmentId,
  currency,
  exponent,
  amendments,
  canRequest,
  appliesImmediately,
}: {
  locale: Locale;
  shipmentId: string;
  currency: string;
  exponent: number;
  amendments: readonly AmendmentItem[];
  canRequest: boolean;
  appliesImmediately: boolean;
}) {
  const messages = MESSAGES[locale];
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(requestAmendment.bind(null, locale), INITIAL_STATE);

  const pending = amendments.find((item) => item.status === "PENDING");

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">{messages.amendments}</h2>

      {amendments.length === 0 ? (
        <p className="text-sm text-slate-500">{messages.noAmendments}</p>
      ) : (
        <ul className="space-y-2">
          {amendments.map((item) => (
            <li key={item.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    item.status === "APPLIED"
                      ? "rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800"
                      : item.status === "REJECTED"
                        ? "rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-800"
                        : "rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900"
                  }
                >
                  {statusLabel(item.status, locale)}
                </span>
                <span className="text-xs text-slate-500">{item.at}</span>
              </div>

              <ul className="mt-2 space-y-0.5">
                {item.lines.map((line) => (
                  <li key={line} className="ltr-isolate font-mono text-xs text-slate-700">
                    {line}
                  </li>
                ))}
              </ul>

              {item.reason === null ? null : (
                <p className="mt-1 text-xs text-slate-500">{item.reason}</p>
              )}
              {item.decisionReason === null ? null : (
                <p className="mt-1 text-xs font-medium text-red-700">{item.decisionReason}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {!canRequest || pending !== undefined ? null : open ? (
        <form action={action} className="space-y-3 border-t border-slate-200 pt-3">
          <input type="hidden" name="shipmentId" value={shipmentId} />
          <input type="hidden" name="exponent" value={exponent} />

          <p className="text-xs text-slate-500">{messages.amendHint}</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={messages.contact}
              name="recipientName"
              error={state.fieldErrors["recipientName"]}
            >
              <input id="recipientName" name="recipientName" maxLength={200} className={INPUT_CLASS} />
            </Field>

            <Field
              label={messages.phone}
              name="recipientPhone"
              hint="24201314"
              error={state.fieldErrors["recipientPhone"]}
            >
              <input
                id="recipientPhone"
                name="recipientPhone"
                type="tel"
                inputMode="tel"
                className={`${INPUT_CLASS} ltr-isolate`}
              />
            </Field>

            <Field
              label={messages.destination}
              name="destinationRawInput"
              error={state.fieldErrors["destinationRawInput"]}
            >
              <input
                id="destinationRawInput"
                name="destinationRawInput"
                maxLength={500}
                className={INPUT_CLASS}
              />
            </Field>

            <Field
              label={messages.city}
              name="destinationCity"
              error={state.fieldErrors["destinationCity"]}
            >
              <input id="destinationCity" name="destinationCity" maxLength={120} className={INPUT_CLASS} />
            </Field>

            {/*
              Text with inputMode="decimal", not type="number": a number input
              strips the trailing zero from "45.000", which an operator entering
              millimes reads as the value having changed.
            */}
            <Field
              label={`${messages.codCollected} (${currency})`}
              name="codAmount"
              error={state.fieldErrors["codAmount"]}
            >
              <input
                id="codAmount"
                name="codAmount"
                type="text"
                inputMode="decimal"
                placeholder={(0).toFixed(exponent)}
                className={`${INPUT_CLASS} text-end tabular-nums`}
              />
            </Field>
          </div>

          <Field label={messages.reason} name="reason" error={state.fieldErrors["reason"]}>
            <input id="reason" name="reason" maxLength={1000} className={INPUT_CLASS} />
          </Field>

          <div className="flex items-center gap-3">
            <Submit
              label={appliesImmediately ? messages.applyChange : messages.requestChange}
              pendingLabel={messages.loading}
            />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
              }}
              className="text-sm text-slate-500 hover:underline"
            >
              {messages.cancel}
            </button>
            {state.error === null || state.error === "validation" ? null : (
              <p role="alert" className="text-sm font-medium text-red-700">
                <span className="ltr-isolate font-mono">{state.error}</span>
              </p>
            )}
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
        >
          + {appliesImmediately ? messages.applyChange : messages.requestChange}
        </button>
      )}
    </section>
  );
}

function statusLabel(status: string, locale: Locale): string {
  const messages = MESSAGES[locale];
  switch (status) {
    case "APPLIED":
      return messages.applied;
    case "REJECTED":
      return messages.rejected;
    default:
      return messages.pending;
  }
}

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={BUTTON_CLASS}>
      {pending ? pendingLabel : label}
    </button>
  );
}
