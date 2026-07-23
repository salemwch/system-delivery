/**
 * The route + route-stop state machines (docs/02-domain-model.md §3.9–3.10).
 *
 * Pure data and pure functions — no I/O, no framework. Like the shipment state
 * machine, the rejections matter more than the permissions: publishing a route
 * that is already IN_PROGRESS, or optimising one that is not a DRAFT, must be
 * rejected, never silently applied.
 */

export const ROUTE_STATUSES = [
  "DRAFT",
  "OPTIMIZING",
  "PUBLISHED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

const ROUTE_STATUS_SET: ReadonlySet<string> = new Set<string>(ROUTE_STATUSES);

export function toRouteStatus(value: string): RouteStatus {
  if (!ROUTE_STATUS_SET.has(value)) {
    throw new Error(`Unknown route status "${value}"`);
  }
  // Membership was just proven; there is no representable alternative to this cast.
  return value as RouteStatus;
}

/** Terminal route states accept no further transitions. */
export const TERMINAL_ROUTE_STATUSES: ReadonlySet<RouteStatus> = new Set<RouteStatus>([
  "COMPLETED",
  "CANCELLED",
]);

/**
 * The route lifecycle from docs/02-domain-model.md §3.9:
 *
 *   DRAFT ↔ OPTIMIZING          (optimise, then apply the result)
 *   DRAFT → PUBLISHED → IN_PROGRESS → COMPLETED
 *   any non-terminal → CANCELLED
 *
 * A missing cell is a hard rejection.
 */
const ROUTE_TRANSITIONS: Readonly<Record<RouteStatus, ReadonlySet<RouteStatus>>> = {
  DRAFT: new Set<RouteStatus>(["OPTIMIZING", "PUBLISHED", "CANCELLED"]),
  OPTIMIZING: new Set<RouteStatus>(["DRAFT", "CANCELLED"]),
  PUBLISHED: new Set<RouteStatus>(["IN_PROGRESS", "CANCELLED"]),
  IN_PROGRESS: new Set<RouteStatus>(["COMPLETED", "CANCELLED"]),
  COMPLETED: new Set<RouteStatus>(),
  CANCELLED: new Set<RouteStatus>(),
};

export function canRouteTransition(from: RouteStatus, to: RouteStatus): boolean {
  return ROUTE_TRANSITIONS[from].has(to);
}

// ── Route stops ────────────────────────────────────────────────────────────────

export const ROUTE_STOP_TYPES = ["PICKUP", "DELIVERY", "HUB_LOAD", "HUB_UNLOAD", "BREAK"] as const;
export type RouteStopType = (typeof ROUTE_STOP_TYPES)[number];

export const ROUTE_STOP_STATUSES = [
  "PENDING",
  "ARRIVED",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
] as const;
export type RouteStopStatus = (typeof ROUTE_STOP_STATUSES)[number];

/** A stop in one of these states is done — the route can complete over it. */
export const TERMINAL_STOP_STATUSES: ReadonlySet<RouteStopStatus> = new Set<RouteStopStatus>([
  "COMPLETED",
  "FAILED",
  "SKIPPED",
]);
