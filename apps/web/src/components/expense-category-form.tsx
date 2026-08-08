"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Field, INPUT_CLASS } from "@/components/ui";
import { INITIAL_STATE } from "@/lib/form-state";
import { createExpenseCategory } from "@/lib/expense-actions";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * The chart of expenses.
 *
 * ⚠️ WITHOUT AT LEAST ONE CATEGORY THE EXPENSE FORM CANNOT BE SUBMITTED — the
 * category is required, and a fresh tenant has none. So this is not an optional
 * admin nicety: it is the first thing a new courier must do here, which is why
 * it opens automatically when the list is empty rather than hiding behind a
 * settings page nobody visits.
 *
 * Categories are retired, never deleted: past expenses reference them, and an
 * accountant reading last year's numbers needs the names to still resolve.
 */
export function ExpenseCategoryForm({
  locale,
  hasCategories,
}: {
  locale: Locale;
  hasCategories: boolean;
}) {
  const messages = MESSAGES[locale];
  const [open, setOpen] = useState(!hasCategories);
  const [state, action] = useActionState(createExpenseCategory.bind(null, locale), INITIAL_STATE);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="text-sm text-brand hover:underline"
      >
        + {messages.category}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      {hasCategories ? null : (
        <p className="text-sm text-slate-600">{messages.expenseCategoriesEmpty}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={messages.reference} name="code" error={state.fieldErrors["code"]}>
          <input
            id="code"
            name="code"
            required
            maxLength={50}
            placeholder="FUEL"
            className={`${INPUT_CLASS} ltr-isolate font-mono`}
          />
        </Field>

        <Field label={messages.category} name="name" error={state.fieldErrors["name"]}>
          <input id="name" name="name" required maxLength={200} className={INPUT_CLASS} />
        </Field>

        <Field label={messages.nameArabic} name="nameAr" error={state.fieldErrors["nameAr"]}>
          <input id="nameAr" name="nameAr" dir="rtl" maxLength={200} className={INPUT_CLASS} />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Submit label={messages.create} pendingLabel={messages.loading} />
        {hasCategories ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="text-sm text-slate-500 hover:underline"
          >
            {messages.cancel}
          </button>
        ) : null}
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
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-9 items-center rounded-lg border border-brand bg-white px-4 py-1.5 text-sm font-semibold text-brand transition hover:bg-brand-soft disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
