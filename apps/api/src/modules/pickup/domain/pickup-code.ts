/**
 * Pickup-request code formatting: `PR-YYYYMMDD-NNN`, unique per tenant.
 *
 * Pure. The numeric suffix is a per-tenant, per-day ordinal computed by the
 * service. A unique-constraint retry resolves the race between two dispatchers
 * creating the day's Nth pickup request at the same instant.
 */

export function formatPickupCode(date: Date, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`pickup ordinal must be a positive integer, got ${ordinal}`);
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `PR-${y}${m}${d}-${String(ordinal).padStart(3, "0")}`;
}
