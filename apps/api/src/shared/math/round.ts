/**
 * Rounds a RATIO (or any other non-monetary number) to a fixed number of
 * decimal places.
 *
 * NEVER use this for money. Money is integer minor units end-to-end and its
 * scale comes from `currencies.exponent` via CurrencyService — TND has 3
 * decimal places, not 2, and floating-point arithmetic on an amount is how COD
 * reconciliation silently drifts. This exists for the things that genuinely
 * ARE fractions: delivery rates, on-time rates, attempts per delivery.
 *
 * Naming the operation also keeps the intent legible: `roundTo(onTimeRate, 4)`
 * says what it is, where a bare `Math.round(x * 10000) / 10000` reads like
 * scale arithmetic and cannot be told apart from the money bug the lint rule
 * exists to catch.
 */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a non-negative integer, received ${decimals}`);
  }
  if (!Number.isFinite(value)) {
    // A NaN/Infinity ratio means an upstream division by zero slipped through.
    // Surfacing it beats persisting NaN into an API response.
    throw new RangeError(`value must be a finite number, received ${value}`);
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
