"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { recordExpense } from "@/lib/expense-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface ExpenseOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Recording a dépense.
 *
 * ⚠️ THE "PAID FROM" CHOICE IS THE CONSEQUENTIAL ONE. Cash means the money left
 * a specific hub's box, and approving the expense reduces that box's balance —
 * the same figure cash reconciliation checks. Choosing the wrong source, or the
 * wrong hub, makes a hub read as short. The hub select therefore appears only
 * for cash, and is required when it does.
 *
 * The amount is typed as a decimal and converted in the action by string
 * arithmetic; the currency's exponent travels in a hidden field rather than
 * being assumed, because TND has three decimals and EUR has two.
 */
export function ExpenseForm({
  locale,
  categories,
  hubs,
  vehicles,
  currency,
  exponent,
  today,
}: {
  locale: Locale;
  categories: readonly ExpenseOption[];
  hubs: readonly ExpenseOption[];
  vehicles: readonly ExpenseOption[];
  currency: string;
  exponent: number;
  /** Server-rendered ISO date — the client's clock may be in another timezone. */
  today: string;
}) {
  const messages = MESSAGES[locale];
  const [open, setOpen] = useState(false);
  const [cash, setCash] = useState(false);
  const [state, action] = useActionState(recordExpense.bind(null, locale), INITIAL_STATE);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
      >
        + {messages.recordExpense}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="exponent" value={exponent} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={messages.category} name="categoryId" error={state.fieldErrors["categoryId"]}>
          <select id="categoryId" name="categoryId" required defaultValue="" className={INPUT_CLASS}>
            <option value="" disabled>
              —
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
        </Field>

        {/*
          Text with inputMode="decimal", not type="number": a number input strips
          the trailing zero from "45.000", which an operator entering millimes
          reads as the value having changed.
        */}
        <Field
          label={`${messages.amount} (${currency})`}
          name="amount"
          error={state.fieldErrors["amount"]}
        >
          <input
            id="amount"
            name="amount"
            type="text"
            inputMode="decimal"
            required
            placeholder={(0).toFixed(exponent)}
            className={`${INPUT_CLASS} text-end tabular-nums`}
          />
        </Field>

        <Field label={messages.spentOn} name="spentOn" error={state.fieldErrors["spentOn"]}>
          <input
            id="spentOn"
            name="spentOn"
            type="date"
            required
            defaultValue={today}
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          label={messages.supplierReference}
          name="supplierReference"
          hint={messages.supplierReferenceHint}
          error={state.fieldErrors["supplierReference"]}
        >
          <input
            id="supplierReference"
            name="supplierReference"
            maxLength={200}
            className={`${INPUT_CLASS} ltr-isolate font-mono`}
          />
        </Field>

        <Field label={messages.paidFrom} name="paidFrom" error={state.fieldErrors["paidFrom"]}>
          <select
            id="paidFrom"
            name="paidFrom"
            defaultValue="BANK"
            onChange={(event) => {
              setCash(event.target.value === "HUB_CASH");
            }}
            className={INPUT_CLASS}
          >
            <option value="BANK">{messages.paidFromBank}</option>
            <option value="HUB_CASH">{messages.paidFromHubCash}</option>
          </select>
        </Field>

        {cash ? (
          <Field
            label={messages.paidFromHub}
            name="paidFromHubId"
            hint={messages.paidFromHubHint}
            error={state.fieldErrors["paidFromHubId"]}
          >
            <select
              id="paidFromHubId"
              name="paidFromHubId"
              required
              defaultValue=""
              className={INPUT_CLASS}
            >
              <option value="" disabled>
                —
              </option>
              {hubs.map((hub) => (
                <option key={hub.id} value={hub.id}>
                  {hub.label}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label={messages.fleet} name="vehicleId" error={state.fieldErrors["vehicleId"]}>
          <select id="vehicleId" name="vehicleId" defaultValue="" className={INPUT_CLASS}>
            <option value="">—</option>
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label={messages.network} name="hubId" error={state.fieldErrors["hubId"]}>
          <select id="hubId" name="hubId" defaultValue="" className={INPUT_CLASS}>
            <option value="">—</option>
            {hubs.map((hub) => (
              <option key={hub.id} value={hub.id}>
                {hub.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={messages.description} name="description" error={state.fieldErrors["description"]}>
        <input id="description" name="description" required maxLength={500} className={INPUT_CLASS} />
      </Field>

      <div className="flex items-center gap-3">
        <Submit label={messages.recordExpense} pendingLabel={messages.loading} />
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
