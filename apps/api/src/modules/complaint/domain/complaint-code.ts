/**
 * Complaint code formatting: `RC-YYYYMMDD-NNN`, unique per tenant.
 *
 * `RC` for *réclamation* — the word the business actually uses, and what a
 * Tunisian merchant will say on the phone.
 *
 * Pure, so the format is unit-testable without a database. Not hub-aware, unlike
 * a manifest code: a complaint is not a physical document handed between
 * locations, it is a case reference read aloud, so shorter is better.
 */

export function formatComplaintCode(date: Date, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`complaint ordinal must be a positive integer, got ${String(ordinal)}`);
  }

  const stamp = [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");

  // Three digits covers a thousand complaints a day per tenant. Past that the
  // number simply grows rather than wrapping — a wrapped ordinal would collide
  // with the morning's cases and, worse, would look valid.
  return `RC-${stamp}-${String(ordinal).padStart(3, "0")}`;
}
