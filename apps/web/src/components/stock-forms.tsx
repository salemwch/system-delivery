"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { createInventoryItem, recordMovement, transferStock } from "@/lib/inventory-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

export interface StockOption {
  readonly id: string;
  readonly label: string;
}

const UNITS = ["UNIT", "ROLL", "BOX", "METRE", "LITRE"] as const;
const REASONS = ["RECEIPT", "CONSUMPTION", "STOCKTAKE", "DAMAGE"] as const;

/**
 * The three things a storeman does: define an item, move stock, send it
 * elsewhere.
 *
 * One component with a tab switch rather than three stacked forms, because this
 * page's real content is the stock TABLE — three permanently-open forms would
 * push it below the fold, and the table is what someone came to read.
 */
export function StockForms({
  locale,
  items,
  hubs,
}: {
  locale: Locale;
  items: readonly StockOption[];
  hubs: readonly StockOption[];
}) {
  const messages = MESSAGES[locale];
  const [tab, setTab] = useState<"none" | "move" | "transfer" | "item">("none");

  const tabs = [
    { key: "move" as const, label: messages.recordMovement },
    { key: "transfer" as const, label: messages.transferStock },
    { key: "item" as const, label: messages.newItem },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(tab === entry.key ? "none" : entry.key);
            }}
            aria-pressed={tab === entry.key}
            className={
              tab === entry.key
                ? "rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white"
                : "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50"
            }
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "move" ? <MovementForm locale={locale} items={items} hubs={hubs} /> : null}
      {tab === "transfer" ? <TransferForm locale={locale} items={items} hubs={hubs} /> : null}
      {tab === "item" ? <ItemForm locale={locale} /> : null}
    </div>
  );
}

function MovementForm({
  locale,
  items,
  hubs,
}: {
  locale: Locale;
  items: readonly StockOption[];
  hubs: readonly StockOption[];
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(recordMovement.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
      <Field label={messages.item} name="itemId" error={state.fieldErrors["itemId"]}>
        <Select id="itemId" name="itemId" options={items} required />
      </Field>

      <Field label={messages.network} name="hubId" error={state.fieldErrors["hubId"]}>
        <Select id="hubId" name="hubId" options={hubs} required />
      </Field>

      <Field label={messages.quantity} name="quantity" error={state.fieldErrors["quantity"]}>
        <input
          id="quantity"
          name="quantity"
          type="number"
          min={1}
          required
          className={`${INPUT_CLASS} text-end tabular-nums`}
        />
      </Field>

      {/*
        Direction and reason are separate because they answer different
        questions: IN/OUT is arithmetic, the reason is why — and a monthly review
        reads the reason, not the sign.
      */}
      <Field label={messages.direction} name="direction" error={state.fieldErrors["direction"]}>
        <select id="direction" name="direction" defaultValue="IN" className={INPUT_CLASS}>
          <option value="IN">{messages.stockIn}</option>
          <option value="OUT">{messages.stockOut}</option>
        </select>
      </Field>

      <Field label={messages.reason} name="reason" error={state.fieldErrors["reason"]}>
        <select id="reason" name="reason" defaultValue="RECEIPT" className={INPUT_CLASS}>
          {REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {reason}
            </option>
          ))}
        </select>
      </Field>

      <Field label={messages.notes} name="note" error={state.fieldErrors["note"]}>
        <input id="note" name="note" maxLength={500} className={INPUT_CLASS} />
      </Field>

      <div className="sm:col-span-3">
        <Submit label={messages.recordMovement} pendingLabel={messages.loading} state={state} />
      </div>
    </form>
  );
}

function TransferForm({
  locale,
  items,
  hubs,
}: {
  locale: Locale;
  items: readonly StockOption[];
  hubs: readonly StockOption[];
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(transferStock.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
      <Field label={messages.item} name="itemId" error={state.fieldErrors["itemId"]}>
        <Select id="itemId" name="itemId" options={items} required />
      </Field>

      <Field label={messages.quantity} name="quantity" error={state.fieldErrors["quantity"]}>
        <input
          id="quantity"
          name="quantity"
          type="number"
          min={1}
          required
          className={`${INPUT_CLASS} text-end tabular-nums`}
        />
      </Field>

      <Field label={messages.transferFrom} name="fromHubId" error={state.fieldErrors["fromHubId"]}>
        <Select id="fromHubId" name="fromHubId" options={hubs} required />
      </Field>

      <Field label={messages.transferTo} name="toHubId" error={state.fieldErrors["toHubId"]}>
        <Select id="toHubId" name="toHubId" options={hubs} required />
      </Field>

      <div className="sm:col-span-2">
        <Submit label={messages.transferStock} pendingLabel={messages.loading} state={state} />
      </div>
    </form>
  );
}

function ItemForm({ locale }: { locale: Locale }) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(createInventoryItem.bind(null, locale), INITIAL_STATE);

  return (
    <form action={action} className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
      <Field label={messages.reference} name="sku" error={state.fieldErrors["sku"]}>
        <input
          id="sku"
          name="sku"
          required
          maxLength={50}
          placeholder="ROLL-THERMAL"
          className={`${INPUT_CLASS} ltr-isolate font-mono`}
        />
      </Field>

      <Field label={messages.item} name="name" error={state.fieldErrors["name"]}>
        <input id="name" name="name" required maxLength={200} className={INPUT_CLASS} />
      </Field>

      <Field label={messages.nameArabic} name="nameAr" error={state.fieldErrors["nameAr"]}>
        <input id="nameAr" name="nameAr" dir="rtl" maxLength={200} className={INPUT_CLASS} />
      </Field>

      <Field label={messages.unit} name="unit" error={state.fieldErrors["unit"]}>
        <select id="unit" name="unit" defaultValue="UNIT" className={INPUT_CLASS}>
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={messages.reorderLevel}
        name="reorderLevel"
        hint={messages.reorderLevelHint}
        error={state.fieldErrors["reorderLevel"]}
      >
        <input
          id="reorderLevel"
          name="reorderLevel"
          type="number"
          min={0}
          className={`${INPUT_CLASS} text-end tabular-nums`}
        />
      </Field>

      <div className="sm:col-span-3">
        <Submit label={messages.create} pendingLabel={messages.loading} state={state} />
      </div>
    </form>
  );
}

function Select({
  id,
  name,
  options,
  required,
}: {
  id: string;
  name: string;
  options: readonly StockOption[];
  required?: boolean;
}) {
  return (
    <select id={id} name={name} required={required} defaultValue="" className={INPUT_CLASS}>
      <option value="" disabled>
        —
      </option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Submit({
  label,
  pendingLabel,
  state,
}: {
  label: string;
  pendingLabel: string;
  state: { readonly error: string | null };
}) {
  const { pending } = useFormStatus();
  return (
    <div className="flex items-center gap-3">
      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? pendingLabel : label}
      </button>
      {state.error === null || state.error === "validation" ? null : (
        <p role="alert" className="text-sm font-medium text-red-700">
          <span className="ltr-isolate font-mono">{state.error}</span>
        </p>
      )}
    </div>
  );
}
