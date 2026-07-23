/**
 * Route code formatting: `R-YYYYMMDD-NNN`, unique per tenant (domain §3.9).
 *
 * Pure. The numeric suffix is a per-tenant, per-day ordinal computed by the
 * service under the tenant's routes; a unique-constraint retry resolves the race
 * between two dispatchers creating the day's Nth route at the same instant.
 */

/** `2026-07-23` → `20260723`. Accepts the ISO date the DTO already validated. */
export function compactDate(plannedDate: string): string {
  const digits = plannedDate.replace(/-/g, "");
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`plannedDate must be an ISO date (YYYY-MM-DD), got "${plannedDate}"`);
  }
  return digits;
}

export function formatRouteCode(plannedDate: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`route ordinal must be a positive integer, got ${ordinal}`);
  }
  return `R-${compactDate(plannedDate)}-${String(ordinal).padStart(3, "0")}`;
}
