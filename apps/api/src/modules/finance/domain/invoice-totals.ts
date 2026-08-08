/**
 * Invoice arithmetic.
 *
 * Pure and separate from the service so it can be tested exhaustively without a
 * database — this is the code that decides what a customer is charged, and the
 * failure mode is not an exception but a wrong number nobody notices until an
 * audit.
 *
 * Everything is `bigint` minor units. No floats appear anywhere: TND has three
 * decimals, and `0.1 + 0.2` is the reason financial code does not use them.
 */

/** One line before tax. */
export interface InvoiceLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: bigint;
}

/** A line with its computed total. Reachable through {@link InvoiceTotals}. */
interface InvoiceLineTotals extends InvoiceLineInput {
  readonly position: number;
  readonly lineTotalMinor: bigint;
}

export interface InvoiceTotals {
  readonly lines: readonly InvoiceLineTotals[];
  /** Total before tax — the "HT" figure. */
  readonly subtotalMinor: bigint;
  readonly vatRateBp: number;
  readonly vatAmountMinor: bigint;
  readonly stampDutyMinor: bigint;
  /** What the customer owes — the "TTC" figure. */
  readonly totalMinor: bigint;
}

/** Basis points per whole unit: 10 000 bp = 100%. */
const BASIS_POINTS = 10_000n;

/**
 * Computes every figure on an invoice.
 *
 * ⚠️ VAT IS CALCULATED ON THE SUBTOTAL, NOT PER LINE, and then rounded once.
 * Rounding each line and summing gives a different answer — by up to one minor
 * unit per line — and on a 40-line invoice that is a visible discrepancy
 * against the customer's own calculation. One rounding, at the end.
 *
 * ⚠️ THE STAMP DUTY IS NOT TAXED. The timbre fiscal is a fixed duty added after
 * VAT, not part of the taxable base — charging VAT on it would overcharge every
 * invoice by the rate times the duty.
 */
export function computeInvoiceTotals(
  lines: readonly InvoiceLineInput[],
  vatRateBp: number,
  stampDutyMinor: bigint,
): InvoiceTotals {
  const withTotals = lines.map((line, index) => ({
    ...line,
    // Positions are 1-based: they are printed on the document, and a customer
    // querying "line 0" is a conversation nobody wants to have.
    position: index + 1,
    lineTotalMinor: BigInt(line.quantity) * line.unitPriceMinor,
  }));

  const subtotalMinor = withTotals.reduce((sum, line) => sum + line.lineTotalMinor, 0n);
  const vatAmountMinor = roundHalfUp(subtotalMinor * BigInt(vatRateBp), BASIS_POINTS);

  return {
    lines: withTotals,
    subtotalMinor,
    vatRateBp,
    vatAmountMinor,
    stampDutyMinor,
    totalMinor: subtotalMinor + vatAmountMinor + stampDutyMinor,
  };
}

/**
 * Integer division rounding half away from zero.
 *
 * BigInt division truncates toward zero, so `19n / 10n` is 1 — a systematic
 * under-charge on every invoice whose VAT has a fractional part. Half-up is the
 * convention tax authorities expect and the one a customer's own spreadsheet
 * will produce.
 *
 * Both arguments are non-negative here (amounts are stored unsigned and the
 * rate is 0–10000), but the sign is handled anyway rather than assumed: a
 * helper that is only correct for its current caller is a trap for the next.
 */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

/**
 * Formats a document number: `FA-2026-00001`.
 *
 * Five digits because a courier issuing more than 99 999 invoices in one year
 * has a bigger problem than formatting — and the width is padded so the numbers
 * sort lexically, which is how they appear in every export and file listing.
 */
export function formatDocumentNumber(prefix: string, year: number, sequence: number): string {
  return `${prefix}-${String(year)}-${String(sequence).padStart(5, "0")}`;
}

/** `FA` for a facture, `AV` for an avoir — the abbreviations used in Tunisia. */
export const NUMBER_PREFIX: Readonly<Record<"INVOICE" | "CREDIT_NOTE", string>> = {
  INVOICE: "FA",
  CREDIT_NOTE: "AV",
};
