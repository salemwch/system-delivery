"use server";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ApiError, apiFetch } from "./api";
import { parseCsv } from "./csv";
import { INITIAL_IMPORT_STATE } from "./import-state";
import type { ImportRowError, ImportState } from "./import-state";
import { toE164 } from "./phone";

/**
 * Bulk shipment import from a CSV a merchant exported.
 *
 * The API caps a batch at 100 and reports each row independently — one bad
 * barcode never discards ninety-nine good ones. This action preserves that:
 * the result lists every failure with its ROW NUMBER, because "17 succeeded,
 * 3 failed" without saying which three is not a usable answer when the file
 * has 100 lines.
 */

/** What `POST /v1/shipments/bulk` accepts in one call. */
const MAX_ROWS = 100;

/** The columns we read. Anything else in the file is ignored, not rejected. */
const COLUMNS = [
  "recipientName",
  "recipientPhone",
  "address",
  "city",
  "codAmount",
  "weightGrams",
  "parcelCount",
  "reference",
] as const;

const rowSchema = z.object({
  recipientName: z.string().trim().min(1, "recipientName is required").max(200),
  recipientPhone: z
    .string()
    .trim()
    .transform(toE164)
    .refine((value) => value !== null, "recipientPhone is not a valid number"),
  address: z.string().trim().min(1, "address is required").max(500),
  city: z.string().trim().max(200).optional(),
  codAmount: z.string().trim().max(30).optional(),
  weightGrams: z.string().trim().max(12).optional(),
  parcelCount: z.string().trim().max(6).optional(),
  reference: z.string().trim().max(200).optional(),
});

interface BulkResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly {
    readonly index: number;
    readonly success: boolean;
    readonly error: string | null;
  }[];
}

export async function importShipments(
  merchantId: string,
  currencyExponent: number,
  _previous: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const csv = formData.get("csv");
  const delimiter = formData.get("delimiter") === ";" ? ";" : ",";
  if (typeof csv !== "string" || csv.trim() === "") {
    return { ...INITIAL_IMPORT_STATE, error: "validation", fieldErrors: { csv: "required" } };
  }

  const table = parseCsv(csv, delimiter);
  if (table.rows.length === 0) {
    return { ...INITIAL_IMPORT_STATE, error: "emptyFile", fieldErrors: {} };
  }
  if (table.rows.length > MAX_ROWS) {
    return { ...INITIAL_IMPORT_STATE, error: "tooManyRows", fieldErrors: {} };
  }

  const missing = REQUIRED_COLUMNS.filter((column) => !table.headers.includes(column));
  if (missing.length > 0) {
    return {
      ...INITIAL_IMPORT_STATE,
      error: "missingColumns",
      fieldErrors: { csv: missing.join(", ") },
    };
  }

  // Validate EVERY row before sending any. A file half-imported and half
  // rejected leaves the merchant reconciling two systems by hand; refusing the
  // whole file with line numbers is recoverable in one edit.
  const items: { idempotencyKey: string; data: unknown }[] = [];
  const rowErrors: ImportRowError[] = [];

  for (const [index, cells] of table.rows.entries()) {
    const record = Object.fromEntries(
      COLUMNS.map((column) => [column, valueOf(table.headers, cells, column)]),
    );
    const parsed = rowSchema.safeParse(record);
    // +2: one for the header line, one because humans count from 1.
    const line = index + 2;

    if (!parsed.success) {
      rowErrors.push({ line, message: parsed.error.issues[0]?.message ?? "invalid row" });
      continue;
    }

    const cod = parseAmount(parsed.data.codAmount, currencyExponent);
    if (cod === null) {
      rowErrors.push({ line, message: "codAmount is not a valid amount" });
      continue;
    }

    const address = {
      rawInput: [parsed.data.address, parsed.data.city].filter(Boolean).join(", "),
      countryCode: "TN",
      ...(parsed.data.city === undefined ? {} : { city: parsed.data.city }),
    };

    items.push({
      idempotencyKey: randomUUID(),
      data: {
        idempotencyKey: randomUUID(),
        merchantId,
        recipientName: parsed.data.recipientName,
        recipientPhone: parsed.data.recipientPhone,
        // The merchant is the sender for an import; the API narrows the
        // merchant from the token anyway.
        senderName: parsed.data.recipientName,
        senderPhone: parsed.data.recipientPhone,
        origin: address,
        destination: address,
        currency: "TND",
        codAmountMinor: cod,
        source: "CSV",
        ...(parsed.data.reference === undefined ? {} : { externalReference: parsed.data.reference }),
        ...numeric("weightGrams", parsed.data.weightGrams),
        ...numeric("parcelCount", parsed.data.parcelCount),
      },
    });
  }

  if (rowErrors.length > 0) {
    return { ...INITIAL_IMPORT_STATE, error: "rowErrors", failed: rowErrors.length, rowErrors };
  }

  try {
    const result = await apiFetch<BulkResult>("/v1/shipments/bulk", {
      method: "POST",
      idempotencyKey: randomUUID(),
      body: { items },
    });
    return {
      error: result.failed > 0 ? "partial" : null,
      fieldErrors: {},
      succeeded: result.succeeded,
      failed: result.failed,
      rowErrors: result.results
        .filter((row) => !row.success)
        .map((row) => ({ line: row.index + 2, message: row.error ?? "rejected" })),
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ...INITIAL_IMPORT_STATE, error: error.code, fieldErrors: error.fieldErrors };
    }
    throw error;
  }
}

/** Without these there is nothing to deliver, or nobody to deliver it to. */
const REQUIRED_COLUMNS = ["recipientName", "recipientPhone", "address"] as const;

function valueOf(
  headers: readonly string[],
  cells: readonly string[],
  column: string,
): string | undefined {
  const index = headers.indexOf(column);
  if (index === -1) {
    return undefined;
  }
  const value = cells[index]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Spread-friendly optional integer. */
function numeric(key: string, value: string | undefined): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? { [key]: parsed } : {};
}

/**
 * "12,500" or "12.500" → 12500 millimes.
 *
 * Scaled by the currency's OWN exponent. TND has three decimals, so a hardcoded
 * ×100 would under-charge every COD parcel by a factor of ten.
 */
function parseAmount(input: string | undefined, exponent: number): string | null {
  if (input === undefined) {
    return "0";
  }
  const match = /^(\d+)(?:[.,](\d+))?$/u.exec(input.replace(/\s/gu, ""));
  if (match === null) {
    return null;
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(exponent, "0").slice(0, exponent);
  return `${whole}${fraction}`.replace(/^0+(?=\d)/u, "");
}
