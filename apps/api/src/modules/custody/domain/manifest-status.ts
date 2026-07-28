/**
 * The manifest state machine (docs/02-domain-model.md §3.11).
 *
 * Pure data and pure functions — no I/O, no framework.
 *
 * OPEN → SEALED → IN_TRANSIT → RECEIVED → RECONCILED
 *
 * Strictly forward. There is no un-seal and no un-receive: a manifest is a
 * custody handover record, and rewinding one would mean the parcels were in two
 * places at once. A mistake is corrected by opening a NEW manifest (rule 1).
 */

export const MANIFEST_STATUSES = [
  "OPEN",
  "SEALED",
  "IN_TRANSIT",
  "RECEIVED",
  "RECONCILED",
] as const;
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set<string>(MANIFEST_STATUSES);

export function toManifestStatus(value: string): ManifestStatus {
  if (!STATUS_SET.has(value)) {
    throw new Error(`Unknown manifest status "${value}"`);
  }
  return value as ManifestStatus;
}

/** RECONCILED is the only end state — every other status still owes work. */
export const TERMINAL_MANIFEST_STATUSES: ReadonlySet<ManifestStatus> = new Set<ManifestStatus>([
  "RECONCILED",
]);

const MANIFEST_TRANSITIONS: Readonly<Record<ManifestStatus, ReadonlySet<ManifestStatus>>> = {
  OPEN: new Set<ManifestStatus>(["SEALED"]),
  SEALED: new Set<ManifestStatus>(["IN_TRANSIT", "RECEIVED"]),
  IN_TRANSIT: new Set<ManifestStatus>(["RECEIVED"]),
  RECEIVED: new Set<ManifestStatus>(["RECONCILED"]),
  RECONCILED: new Set<ManifestStatus>(),
};

export function canManifestTransition(from: ManifestStatus, to: ManifestStatus): boolean {
  return MANIFEST_TRANSITIONS[from].has(to);
}

/**
 * The four kinds of handover a manifest can record.
 *
 * The type fixes which endpoints are required — enforced by
 * `manifests_endpoints_chk` in migration 0017 as well as by the service, so an
 * incoherent handover is not representable in the database at all.
 */
export const MANIFEST_TYPES = ["LINEHAUL", "DISPATCH", "RETURN", "TRANSFER"] as const;
export type ManifestType = (typeof MANIFEST_TYPES)[number];

const TYPE_SET: ReadonlySet<string> = new Set<string>(MANIFEST_TYPES);

export function toManifestType(value: string): ManifestType {
  if (!TYPE_SET.has(value)) {
    throw new Error(`Unknown manifest type "${value}"`);
  }
  return value as ManifestType;
}

/**
 * Whether this handover starts at a hub.
 *
 * Decides whether sealing may emit `shipment.loaded`, which the shipment state
 * machine only accepts from `AT_HUB`. A RETURN manifest is sealed by a driver
 * in the field holding parcels that are OUT_FOR_DELIVERY or ATTEMPT_FAILED, so
 * emitting `loaded` for it would be an illegal transition — and would also
 * contradict rule 5, which puts the custody transfer at receipt.
 */
export function originatesAtHub(type: ManifestType): boolean {
  return type !== "RETURN";
}

/**
 * Whether this handover physically travels between two custody points, and so
 * passes through IN_TRANSIT via `shipment.departed`.
 *
 * DISPATCH is excluded: a hub handing parcels to a last-mile driver moves them
 * to OUT_FOR_DELIVERY, which `RouteService.start()` already owns. Marking them
 * IN_TRANSIT first would be a second, contradictory truth about the same parcel.
 */
export function travelsInTransit(type: ManifestType): boolean {
  return type === "LINEHAUL" || type === "TRANSFER";
}
