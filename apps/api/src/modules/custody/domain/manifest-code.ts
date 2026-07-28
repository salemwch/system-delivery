/**
 * Manifest code formatting: `MF-<HUBCODE>-YYYYMMDD-NNN`, unique per tenant.
 *
 * Pure. Hub-aware on purpose — a manifest is a physical document read off a
 * loading dock, so `MF-TUN01-20260728-003` tells an operator where it came from
 * without a lookup, where a bare `MF-20260728-003` tells them nothing.
 *
 * The second consequence matters more: the ordinal is per hub per day rather
 * than per tenant per day. Two hubs sealing at the same instant allocate from
 * different sequences, so they never collide and the unique-violation retry
 * loop in the service stays cold.
 */

/**
 * Hub codes are operator-entered (`TUN-01`, `sfax 2`). Normalise to uppercase
 * alphanumerics so the manifest code stays a single scannable token — a stray
 * space or dash would break the segment structure.
 */
export function normaliseHubCode(hubCode: string): string {
  const normalised = hubCode.replace(/[^a-zA-Z0-9]/gu, "").toUpperCase();
  if (normalised.length === 0) {
    throw new Error(`hub code "${hubCode}" has no alphanumeric characters`);
  }
  return normalised;
}

export function formatManifestCode(hubCode: string, date: Date, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`manifest ordinal must be a positive integer, got ${ordinal}`);
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `MF-${normaliseHubCode(hubCode)}-${y}${m}${d}-${String(ordinal).padStart(3, "0")}`;
}
