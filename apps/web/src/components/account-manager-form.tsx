"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { assignAccountManager } from "@/lib/merchant-actions";
import { INITIAL_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface CommercialOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Moves the account between commercials, or back to house-managed.
 *
 * Rendered only for a caller holding `merchant:assign_manager` — an OWNER. A
 * commercial must not be able to help themselves to a colleague's accounts, so
 * the control is absent for them and the API refuses it regardless.
 */
export function AccountManagerForm({
  merchantId,
  current,
  commercials,
  locale,
}: {
  merchantId: string;
  current: string | null;
  commercials: readonly CommercialOption[];
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(
    assignAccountManager.bind(null, locale),
    INITIAL_STATE,
  );

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="merchantId" value={merchantId} />

      <div className="min-w-64">
        <Field label={messages.assignAccountManager} name="accountManagerId">
          <select
            id="accountManagerId"
            name="accountManagerId"
            defaultValue={current ?? ""}
            className={INPUT_CLASS}
          >
            <option value="">{messages.houseManaged}</option>
            {commercials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <SubmitButton label={messages.save} />

      {/* Success needs no message: the page revalidates and renders the new
          owner, which is the only confirmation that cannot be stale. */}
      {state.error === null ? null : (
        <p role="alert" className="text-sm font-medium text-red-700">
          {messages.requestFailed}
        </p>
      )}
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={BUTTON_CLASS}>
      {label}
    </button>
  );
}
