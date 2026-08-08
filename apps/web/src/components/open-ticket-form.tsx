"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { openTicket } from "@/lib/support-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface TicketMerchantOption {
  readonly id: string;
  readonly name: string;
}

const CATEGORIES = ["BILLING", "PICKUP", "DELIVERY", "ACCOUNT", "TECHNICAL", "OTHER"] as const;

/**
 * Staff opening a ticket on a merchant's behalf — the phone-call case.
 *
 * A merchant rings, asks a question, and someone has to record it somewhere the
 * answer can be found again. Without this the call is remembered by one person
 * and the thread starts only if the merchant later writes in.
 *
 * Collapsed by default: this page is a queue, and a form permanently occupying
 * the top of it pushes the work out of sight.
 */
export function OpenTicketForm({
  locale,
  merchants,
}: {
  locale: Locale;
  merchants: readonly TicketMerchantOption[];
}) {
  const messages = MESSAGES[locale];
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(openTicket.bind(null, locale), INITIAL_STATE);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
      >
        + {messages.support}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={messages.merchants} name="merchantId" error={state.fieldErrors["merchantId"]}>
          <select id="merchantId" name="merchantId" required defaultValue="" className={INPUT_CLASS}>
            <option value="" disabled>
              —
            </option>
            {merchants.map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label={messages.category} name="category" error={state.fieldErrors["category"]}>
          <select id="category" name="category" defaultValue="OTHER" className={INPUT_CLASS}>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={messages.subject} name="subject" error={state.fieldErrors["subject"]}>
        <input id="subject" name="subject" required maxLength={200} className={INPUT_CLASS} />
      </Field>

      <Field label={messages.reply} name="body" error={state.fieldErrors["body"]}>
        <textarea id="body" name="body" rows={3} required maxLength={5000} className={INPUT_CLASS} />
      </Field>

      <div className="flex items-center gap-3">
        <Submit label={messages.create} pendingLabel={messages.loading} />
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
