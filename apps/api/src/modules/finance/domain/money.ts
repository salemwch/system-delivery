import { BusinessRuleError } from "../../../shared/errors/index.js";

/**
 * Money is integer minor units + an ISO 4217 exponent read from the `currencies`
 * table — never floats, never a hardcoded ×100 (docs/01-mvp-scope.md §7.1). TND
 * has exponent 3: 12.500 TND is 12500 minor units, not 1250. A ×100 assumption is
 * a 1000× error on Tunisian money.
 *
 * These two functions are the exact, lossless round-trip between the stored
 * integer and its human decimal string. They are pure so they are trivially
 * property-testable — the P0 acceptance criterion for the ledger (§7.1, MVP6).
 */

/** Formats minor units as a plain decimal string, e.g. (12500, 3) → "12.500". */
export function formatMinorUnits(amountMinor: bigint, exponent: number): string {
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const sign = negative ? "-" : "";

  if (exponent === 0) {
    return `${sign}${abs.toString()}`;
  }
  const divisor = 10n ** BigInt(exponent);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exponent, "0");
  return `${sign}${whole.toString()}.${fraction}`;
}

/** Parses a decimal string into minor units, e.g. ("12.5", 3) → 12500n. */
export function parseMinorUnits(value: string, exponent: number): bigint {
  const match = /^\s*(-)?(\d+)(?:\.(\d+))?\s*$/.exec(value);
  if (match === null) {
    throw new BusinessRuleError("INVALID_AMOUNT", `Not a valid decimal amount: "${value}"`);
  }
  const sign = match[1];
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > exponent) {
    throw new BusinessRuleError(
      "INVALID_AMOUNT",
      `"${value}" has more than ${exponent} decimal place(s) for this currency`,
    );
  }
  const scaledFraction = fraction.padEnd(exponent, "0");
  const magnitude = BigInt(`${whole}${scaledFraction}`);
  return sign === "-" ? -magnitude : magnitude;
}
