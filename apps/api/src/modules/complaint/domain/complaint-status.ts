/**
 * The complaint lifecycle (docs/02-domain-model.md §3.20).
 *
 * ```
 * OPEN → INVESTIGATING → RESOLVED | REJECTED
 *                     ↘ ESCALATED → RESOLVED | REJECTED
 * ```
 */

export const COMPLAINT_TYPES = [
  "DAMAGED",
  "LOST",
  "LATE",
  "WRONG_ITEM",
  "DRIVER_CONDUCT",
  /**
   * The one that touches money. Resolving it may post a REVERSING ledger
   * transaction — the mechanism that answers hotspot H8 (what happens to
   * collected COD when a delivery is later disputed).
   */
  "COD_DISPUTE",
  "OTHER",
] as const;
export type ComplaintType = (typeof COMPLAINT_TYPES)[number];

export const COMPLAINT_STATUSES = [
  "OPEN",
  "INVESTIGATING",
  "ESCALATED",
  "RESOLVED",
  "REJECTED",
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number];

/** Who raised it. A RECIPIENT has no account, so their id is absent. */
export const COMPLAINT_RAISERS = ["MERCHANT", "RECIPIENT", "STAFF"] as const;
export type ComplaintRaiser = (typeof COMPLAINT_RAISERS)[number];

/** Terminal states. Neither accepts a further transition (rule 7 — never deleted, only closed). */
export const TERMINAL_COMPLAINT_STATUSES: ReadonlySet<ComplaintStatus> = new Set<ComplaintStatus>([
  "RESOLVED",
  "REJECTED",
]);

/**
 * The permitted transitions, exactly as the domain lifecycle draws them.
 *
 * A table rather than a chain of `if`s: the legal moves are then a fact that can
 * be read, tested and exhausted, instead of behaviour spread across a method.
 */
const TRANSITIONS: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  OPEN: ["INVESTIGATING", "ESCALATED", "RESOLVED", "REJECTED"],
  INVESTIGATING: ["ESCALATED", "RESOLVED", "REJECTED"],
  ESCALATED: ["RESOLVED", "REJECTED"],
  // Terminal. Reopening would rewrite a closed outcome; the correct move is a
  // new complaint that references this one.
  RESOLVED: [],
  REJECTED: [],
};

export function canComplaintTransition(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

const TYPE_SET: ReadonlySet<string> = new Set<string>(COMPLAINT_TYPES);
const STATUS_SET: ReadonlySet<string> = new Set<string>(COMPLAINT_STATUSES);
const SEVERITY_SET: ReadonlySet<string> = new Set<string>(COMPLAINT_SEVERITIES);

/**
 * Narrows the DB-constrained `status` text column to the literal union.
 *
 * Throws rather than returning a default: a status the build does not recognise
 * means the database and the code disagree about the lifecycle, and guessing
 * would silently mis-handle it.
 */
export function toComplaintStatus(value: string): ComplaintStatus {
  if (!STATUS_SET.has(value)) {
    throw new Error(`Unknown complaint status "${value}"`);
  }
  return value as ComplaintStatus;
}

export function toComplaintType(value: string): ComplaintType {
  if (!TYPE_SET.has(value)) {
    throw new Error(`Unknown complaint type "${value}"`);
  }
  return value as ComplaintType;
}

export function toComplaintSeverity(value: string): ComplaintSeverity {
  if (!SEVERITY_SET.has(value)) {
    throw new Error(`Unknown complaint severity "${value}"`);
  }
  return value as ComplaintSeverity;
}

/**
 * Default SLA hours per type, used when a tenant has configured none.
 *
 * Ordered by how fast the evidence disappears rather than by how loudly the
 * complainant is shouting: damage must be photographed before the parcel is
 * opened further, a COD dispute holds someone's cash, and a late parcel is
 * annoying but self-documenting.
 */
export const DEFAULT_COMPLAINT_SLA_HOURS: Readonly<Record<ComplaintType, number>> = {
  DAMAGED: 24,
  LOST: 48,
  LATE: 48,
  WRONG_ITEM: 24,
  DRIVER_CONDUCT: 24,
  COD_DISPUTE: 24,
  OTHER: 72,
};
