"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, INPUT_CLASS } from "./ui";
import { revertTemplate, saveTemplate } from "@/lib/template-actions";
import { apiErrorMessage } from "@/lib/api-errors";
import { INITIAL_STATE } from "@/lib/form-state";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import type { NotificationTemplate } from "@/lib/queries";

/**
 * One template's body, with its segment cost visible while editing.
 *
 * The count comes from the server on load and does NOT update as you type —
 * segment maths depends on the encoding the gateway picks, and a client-side
 * guess that disagrees with the bill is worse than no number. Saving refreshes
 * it from the API.
 */
export function TemplateEditor({
  template,
  locale,
}: {
  template: NotificationTemplate;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [saveState, save] = useActionState(saveTemplate.bind(null, locale), INITIAL_STATE);
  const [revertState, revert] = useActionState(revertTemplate.bind(null, locale), INITIAL_STATE);

  const error = saveState.error ?? revertState.error;
  const fieldError = saveState.fieldErrors["body"];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="ltr-isolate font-mono text-sm font-semibold">{template.key}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs uppercase">
          {template.locale}
        </span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{template.channel}</span>

        {template.isDefault ? (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            {messages.templateDefault}
          </span>
        ) : (
          <span className="rounded bg-brand-soft px-2 py-0.5 text-xs text-brand">
            {messages.templateOverridden}
          </span>
        )}

        {/* Two segments is where an Arabic body usually lands; three is worth
            noticing before it multiplies by every delivery. */}
        <span
          className={
            template.estimatedSegments > 2
              ? "ms-auto rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900"
              : "ms-auto rounded px-2 py-0.5 text-xs text-slate-500"
          }
        >
          {messages.smsSegments}: {template.estimatedSegments}
        </span>
      </div>

      {error === null ? null : (
        <p role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          {apiErrorMessage(error, locale)}
        </p>
      )}

      <form action={save} className="space-y-3">
        <input type="hidden" name="key" value={template.key} />
        <input type="hidden" name="templateLocale" value={template.locale} />
        <input type="hidden" name="channel" value={template.channel} />

        <textarea
          name="body"
          rows={3}
          maxLength={1000}
          defaultValue={template.body}
          dir={template.locale === "ar" ? "rtl" : "ltr"}
          className={INPUT_CLASS}
          aria-label={`${template.key} ${template.locale}`}
        />
        {fieldError === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-red-700">
            {fieldError}
          </p>
        )}

        <div className="flex gap-2">
          <SubmitButton label={messages.save} className={BUTTON_CLASS} />
        </div>
      </form>

      {/* A separate form: reverting is a different action, and nesting forms is
          invalid HTML. Offered only when there is an override to remove. */}
      {template.isDefault ? null : (
        <form action={revert} className="mt-2">
          <input type="hidden" name="key" value={template.key} />
          <input type="hidden" name="templateLocale" value={template.locale} />
          <input type="hidden" name="channel" value={template.channel} />
          <SubmitButton
            label={messages.templateRevert}
            className="inline-flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          />
        </form>
      )}
    </div>
  );
}

function SubmitButton({ label, className }: { label: string; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {label}
    </button>
  );
}
