/**
 * The pickup-request state machine (docs/02-domain-model.md §3.18).
 *
 * Pure data and pure functions — no I/O, no framework. The lifecycle is strictly
 * ordered: REQUESTED → ACCEPTED → ASSIGNED → COLLECTED → COMPLETED. CANCELLED
 * branches from any pre-COLLECTED state but is forbidden after custody transfer
 * (invariant I21: "A PickupRequest cannot be CANCELLED after COLLECTED").
 */

export const PICKUP_STATUSES = [
  "REQUESTED",
  "ACCEPTED",
  "ASSIGNED",
  "COLLECTED",
  "COMPLETED",
  "CANCELLED",
] as const;
export type PickupStatus = (typeof PICKUP_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set<string>(PICKUP_STATUSES);

export function toPickupStatus(value: string): PickupStatus {
  if (!STATUS_SET.has(value)) {
    throw new Error(`Unknown pickup status "${value}"`);
  }
  return value as PickupStatus;
}

export const TERMINAL_PICKUP_STATUSES: ReadonlySet<PickupStatus> = new Set<PickupStatus>([
  "COMPLETED",
  "CANCELLED",
]);

/**
 * REQUESTED → ACCEPTED → ASSIGNED → COLLECTED → COMPLETED
 *      ↘           ↘          ↘
 *               CANCELLED (not after COLLECTED — I21)
 */
const PICKUP_TRANSITIONS: Readonly<Record<PickupStatus, ReadonlySet<PickupStatus>>> = {
  REQUESTED: new Set<PickupStatus>(["ACCEPTED", "CANCELLED"]),
  ACCEPTED: new Set<PickupStatus>(["ASSIGNED", "CANCELLED"]),
  ASSIGNED: new Set<PickupStatus>(["COLLECTED", "CANCELLED"]),
  COLLECTED: new Set<PickupStatus>(["COMPLETED"]),
  COMPLETED: new Set<PickupStatus>(),
  CANCELLED: new Set<PickupStatus>(),
};

export function canPickupTransition(from: PickupStatus, to: PickupStatus): boolean {
  return PICKUP_TRANSITIONS[from].has(to);
}
