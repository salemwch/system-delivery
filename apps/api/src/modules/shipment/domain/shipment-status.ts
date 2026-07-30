/**
 * The shipment state machine (docs/02-domain-model.md §5.1).
 *
 * Pure data and pure functions — no I/O, no framework. `shipments.status` is a
 * PROJECTION of the immutable `shipment_events` log; this module is the single
 * definition of which transitions are legal, which event drives which status,
 * and which transitions require an override. The rejections matter more than the
 * permissions: a `DELIVERED → OUT_FOR_DELIVERY` from a late offline event must be
 * rejected, never applied.
 */

export const SHIPMENT_STATUSES = [
  "CREATED",
  "ASSIGNED",
  "PICKED_UP",
  "AT_HUB",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "ATTEMPT_FAILED",
  "RETURN_PENDING",
  "RETURNED",
  "CANCELLED",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set<string>(SHIPMENT_STATUSES);

/** Narrows the DB-constrained `status` text column to the literal union. */
export function toShipmentStatus(value: string): ShipmentStatus {
  if (!STATUS_SET.has(value)) {
    throw new Error(`Unknown shipment status "${value}"`);
  }
  // Membership was just proven; there is no representable alternative to this cast.
  return value as ShipmentStatus;
}

/** Terminal states accept no further lifecycle events (rule 11). */
export const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set<ShipmentStatus>([
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
]);

/** Statuses in which the courier physically holds the parcel (drives cancel authority). */
const IN_CUSTODY_STATUSES: ReadonlySet<ShipmentStatus> = new Set<ShipmentStatus>([
  "PICKED_UP",
  "AT_HUB",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "ATTEMPT_FAILED",
]);

/** The custody ledger event facts (short form, as stored in shipment_events). */
export const SHIPMENT_EVENT_TYPES = [
  "created",
  "assigned",
  "picked_up",
  "arrived_at_hub",
  "loaded",
  "departed",
  "out_for_delivery",
  "arrived_at_stop",
  "delivery_attempted",
  "delivered",
  "delivery_failed",
  "return_initiated",
  "returned",
  "cancelled",
] as const;
export type ShipmentEventType = (typeof SHIPMENT_EVENT_TYPES)[number];

export type ActorType = "DRIVER" | "DISPATCHER" | "HUB_OPERATOR" | "SYSTEM" | "API_CLIENT";
export type CustodyType = "MERCHANT" | "DRIVER" | "HUB";

/** COD lifecycle (docs/02-domain-model.md §5.2). */
/**
 * `NOT_APPLICABLE` means there never was a COD (I6 ties it to a zero amount).
 * `CANCELLED` means there was one and it will never be collected — the parcel
 * came back or was cancelled. The two are not interchangeable: only the second
 * keeps the amount, and only the first can hold a zero one.
 */
export type CodStatus =
  "NOT_APPLICABLE" | "PENDING" | "COLLECTED" | "REMITTED" | "SETTLED" | "CANCELLED";

/** The actor that produced an event — from the authenticated context, never the body. */
export interface EventActor {
  readonly actorType: ActorType;
  readonly actorId?: string;
}

/**
 * Maps a ledger event fact to the wire event name published to the outbox
 * (docs/03-event-storming.md §4). Most are `shipment.<fact>`; the two attempt
 * facts belong to the `delivery` aggregate so the Fraud/Analytics contexts can
 * subscribe to attempts uniformly without parsing the delivery payload.
 */
const OUTBOX_EVENT_NAME: Readonly<Record<ShipmentEventType, string>> = {
  created: "shipment.created",
  assigned: "shipment.assigned",
  picked_up: "shipment.picked_up",
  arrived_at_hub: "shipment.arrived_at_hub",
  loaded: "shipment.loaded",
  departed: "shipment.departed",
  out_for_delivery: "shipment.out_for_delivery",
  arrived_at_stop: "shipment.arrived_at_stop",
  delivery_attempted: "delivery.attempted",
  delivered: "shipment.delivered",
  delivery_failed: "delivery.failed",
  return_initiated: "shipment.return_initiated",
  returned: "shipment.returned",
  cancelled: "shipment.cancelled",
};

export function outboxEventName(eventType: ShipmentEventType): string {
  return OUTBOX_EVENT_NAME[eventType];
}

/**
 * The status an event drives the shipment to, or `null` when the event is an
 * annotation that records a fact without advancing the lifecycle (a manifest
 * load, a geofence arrival, an attempt that is itself followed by a more
 * specific delivered/failed event). `created` is the genesis fact and never
 * transitions — the row is inserted as CREATED.
 */
const EVENT_TARGET_STATUS: Readonly<Record<ShipmentEventType, ShipmentStatus | null>> = {
  created: null,
  assigned: "ASSIGNED",
  picked_up: "PICKED_UP",
  arrived_at_hub: "AT_HUB",
  loaded: null,
  departed: "IN_TRANSIT",
  out_for_delivery: "OUT_FOR_DELIVERY",
  arrived_at_stop: null,
  delivery_attempted: null,
  delivered: "DELIVERED",
  delivery_failed: "ATTEMPT_FAILED",
  return_initiated: "RETURN_PENDING",
  returned: "RETURNED",
  cancelled: "CANCELLED",
};

export function targetStatusFor(eventType: ShipmentEventType): ShipmentStatus | null {
  return EVENT_TARGET_STATUS[eventType];
}

/** The source statuses in which an annotation (no-transition) event is valid. */
const ANNOTATION_SOURCES: Readonly<Record<string, ReadonlySet<ShipmentStatus>>> = {
  loaded: new Set<ShipmentStatus>(["AT_HUB"]),
  arrived_at_stop: new Set<ShipmentStatus>(["OUT_FOR_DELIVERY"]),
  delivery_attempted: new Set<ShipmentStatus>(["OUT_FOR_DELIVERY"]),
};

type TransitionMode = "ALLOW" | "OVERRIDE";

/**
 * The transition matrix from docs/02-domain-model.md §5.1. A missing cell is a
 * hard rejection; `OVERRIDE` cells (⚠️) are the in-custody cancellations that
 * require OWNER authority, a reason, and an audit trail.
 */
const TRANSITIONS: Readonly<
  Record<ShipmentStatus, Partial<Record<ShipmentStatus, TransitionMode>>>
> = {
  CREATED: { ASSIGNED: "ALLOW", CANCELLED: "ALLOW" },
  ASSIGNED: { ASSIGNED: "ALLOW", PICKED_UP: "ALLOW", CANCELLED: "ALLOW" },
  PICKED_UP: { AT_HUB: "ALLOW", OUT_FOR_DELIVERY: "ALLOW", CANCELLED: "OVERRIDE" },
  AT_HUB: {
    IN_TRANSIT: "ALLOW",
    OUT_FOR_DELIVERY: "ALLOW",
    RETURN_PENDING: "ALLOW",
    CANCELLED: "OVERRIDE",
  },
  IN_TRANSIT: { AT_HUB: "ALLOW", CANCELLED: "OVERRIDE" },
  OUT_FOR_DELIVERY: {
    AT_HUB: "ALLOW",
    DELIVERED: "ALLOW",
    ATTEMPT_FAILED: "ALLOW",
    CANCELLED: "OVERRIDE",
  },
  ATTEMPT_FAILED: {
    AT_HUB: "ALLOW",
    OUT_FOR_DELIVERY: "ALLOW",
    RETURN_PENDING: "ALLOW",
    CANCELLED: "OVERRIDE",
  },
  RETURN_PENDING: { AT_HUB: "ALLOW", IN_TRANSIT: "ALLOW", RETURNED: "ALLOW" },
  DELIVERED: {},
  RETURNED: {},
  CANCELLED: {},
};

export type TransitionCheck =
  | { readonly kind: "allowed" }
  | { readonly kind: "requires_override" }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Evaluates whether an event may be applied to a shipment in `from`. Returns a
 * discriminated result rather than throwing, so the caller decides how to surface
 * each case (a hard rejection vs. an override-gated one).
 */
export function checkTransition(
  from: ShipmentStatus,
  eventType: ShipmentEventType,
): TransitionCheck {
  if (eventType === "created") {
    // Genesis is handled by the insert, not by a transition. Reaching here means
    // a second `created` for an existing shipment.
    return { kind: "rejected", reason: "a shipment already exists for this created event" };
  }

  if (TERMINAL_STATUSES.has(from)) {
    return {
      kind: "rejected",
      reason: `shipment is ${from}; terminal states accept no further lifecycle events`,
    };
  }

  const target = targetStatusFor(eventType);
  if (target === null) {
    const sources = ANNOTATION_SOURCES[eventType];
    if (sources !== undefined && !sources.has(from)) {
      return {
        kind: "rejected",
        reason: `${eventType} is not valid while the shipment is ${from}`,
      };
    }
    return { kind: "allowed" };
  }

  const mode = TRANSITIONS[from][target];
  if (mode === undefined) {
    return {
      kind: "rejected",
      reason: `${from} → ${target} is not a permitted transition`,
    };
  }
  return mode === "OVERRIDE" ? { kind: "requires_override" } : { kind: "allowed" };
}

export function isInCustody(status: ShipmentStatus): boolean {
  return IN_CUSTODY_STATUSES.has(status);
}

/**
 * The custody holder after an event, or `undefined` to leave custody unchanged.
 * A terminal delivery/return/cancel releases custody (the parcel leaves the
 * system, or returns to sender-side handling tracked elsewhere).
 */
export function custodyAfter(
  eventType: ShipmentEventType,
  context: { readonly driverId?: string | null; readonly hubId?: string | null },
): { type: CustodyType | null; id: string | null } | undefined {
  switch (eventType) {
    case "picked_up":
    case "out_for_delivery":
      return { type: "DRIVER", id: context.driverId ?? null };
    case "arrived_at_hub":
    case "returned":
      return { type: "HUB", id: context.hubId ?? null };
    case "delivered":
    case "cancelled":
      return { type: null, id: null };
    default:
      return undefined;
  }
}
