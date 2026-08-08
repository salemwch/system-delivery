/**
 * Decimal amounts as typed by a human → integer minor units.
 *
 * ⚠️ THE WHOLE POINT IS THAT NO FLOAT IS EVER INVOLVED. The obvious
 * implementation is `Math.round(Number(amount) * 10 ** exponent)`, and it is
 * wrong in a way that only shows up on specific values:
 *
 *   4.005 × 1000 = 4004.999999999999  →  4004 millimes, not 4005
 *   1.005 × 100  =  100.49999999999999 →  100 centimes, not 101
 *
 * These land on a tax document. Splitting the string and padding the fraction is
 * exact for every input the schema admits, at every exponent.
 *
 * Lives here rather than in `invoice-actions.ts` because that file is
 * `"use server"` — it may only export async Server Actions, so a helper defined
 * there is unreachable from a test. A conversion this consequential has to be
 * testable.
 */
export function toMinorUnits(amount: string, exponent: number): string {
  // A comma is what a French or Arabic keyboard produces; the caller's schema
  // admits it, so it is normalised here rather than rejected.
  const [whole = "0", fractionRaw = ""] = amount.replace(",", ".").split(".");
  // Truncates beyond the currency's precision rather than rounding: the schema
  // limits the input, and silently rounding a figure the operator typed is
  // worse than the validation error they should have seen.
  const fraction = fractionRaw.slice(0, exponent).padEnd(exponent, "0");
  // Leading zeroes stripped, but never the last digit — "0.500" at exponent 3
  // is "0500", which must become "500" and not "".
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "");
  return digits === "" ? "0" : digits;
}
