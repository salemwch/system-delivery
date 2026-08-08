"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { BUTTON_CLASS, Field, INPUT_CLASS } from "./ui";
import { importShipments } from "@/lib/import-actions";
import { INITIAL_IMPORT_STATE } from "@/lib/import-state";
import { apiErrorMessage } from "@/lib/api-errors";
import { MESSAGES } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";

/**
 * Bulk import for one merchant.
 *
 * The file is read in the browser and posted as TEXT, not as a multipart
 * upload. A CSV of 100 parcels is a few kilobytes, the server action already
 * accepts a form field, and this avoids an upload endpoint that would need its
 * own size limits and content-type checks for no benefit.
 *
 * Reading it client-side also lets the user see the row count before
 * submitting, which is the moment to notice they picked last month's file.
 */
export function ImportForm({
  merchantId,
  currencyExponent,
  locale,
}: {
  merchantId: string;
  currencyExponent: number;
  locale: Locale;
}) {
  const messages = MESSAGES[locale];
  const [state, action] = useActionState(
    importShipments.bind(null, merchantId, currencyExponent),
    INITIAL_IMPORT_STATE,
  );
  const [csv, setCsv] = useState("");

  const lineCount = csv.trim() === "" ? 0 : Math.max(0, csv.trim().split("\n").length - 1);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file !== undefined) {
      setCsv(await file.text());
    }
  }

  return (
    <form action={action} className="max-w-3xl space-y-4">
      <input type="hidden" name="csv" value={csv} />

      {state.error === null ? null : (
        <p
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
        >
          {importErrorMessage(state.error, state.fieldErrors["csv"], locale)}
        </p>
      )}

      {state.succeeded > 0 ? (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900">
          {messages.importSucceeded}: {state.succeeded}
        </p>
      ) : null}

      {/* Per-row failures, with the line number as it appears in the
          spreadsheet. "3 failed" without saying which three is unusable on a
          hundred-line file. */}
      {state.rowErrors.length === 0 ? null : (
        <ul className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          {state.rowErrors.map((row) => (
            <li key={row.line}>
              <span className="font-semibold">
                {messages.importLine} {row.line}
              </span>
              {" — "}
              {row.message}
            </li>
          ))}
        </ul>
      )}

      <Field label={messages.importFile} name="file" hint={messages.importColumns}>
        <input
          id="file"
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            void onFile(event);
          }}
          className={INPUT_CLASS}
        />
      </Field>

      <Field label={messages.importDelimiter} name="delimiter" hint={messages.importDelimiterHint}>
        <select id="delimiter" name="delimiter" defaultValue="," className={INPUT_CLASS}>
          <option value=",">,</option>
          <option value=";">;</option>
        </select>
      </Field>

      {lineCount > 0 ? (
        <p className="text-sm text-slate-600">
          {messages.importRowsReady}: <strong className="tabular-nums">{lineCount}</strong>
        </p>
      ) : null}

      <SubmitButton label={messages.importShipments} disabled={csv.trim() === ""} />
    </form>
  );
}

/** Import failures are file-shaped, not API-shaped, so they get their own copy. */
function importErrorMessage(code: string, detail: string | undefined, locale: Locale): string {
  const messages = MESSAGES[locale];
  switch (code) {
    case "emptyFile":
      return messages.importEmpty;
    case "tooManyRows":
      return messages.importTooMany;
    case "missingColumns":
      return `${messages.importMissingColumns}: ${detail ?? ""}`;
    case "rowErrors":
      return messages.importRowErrors;
    case "partial":
      return messages.importPartial;
    default:
      return apiErrorMessage(code, locale);
  }
}

function SubmitButton({ label, disabled }: { label: string; disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} className={BUTTON_CLASS}>
      {label}
    </button>
  );
}
