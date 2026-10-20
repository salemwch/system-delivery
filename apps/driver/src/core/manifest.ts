import { z } from "zod";

import { isZero, sumByCurrency } from "./money";
import type { Money } from "./money";

/**
 * The driver's day as the server sends it (`POST /v1/drivers/me/sync`,
 * `routeUpdates[].manifest`), and the read models the screens draw from it.
 *
 * The manifest is the server's truth; what the device did since the last sync
 * (queued deliveries, failures) is laid over it as `Pending`, so a parcel
 * delivered offline reads as delivered at once, marked "waiting to send".
 */
const moneySchema = z.object({
  amountMinor: z.string().regex(/^-?\d+$/u),
  currency: z.string().length(3),
  currencyExponent: z.number().int().min(0).max(4),
});

const manifestShipmentSchema = z
  .object({
    shipmentId: z.uuid(),
    trackingNumber: z.string(),
    recipientName: z.string(),
    recipientPhone: z.string(),
    parcelCount: z.number().int(),
    status: z.string(),
    cod: moneySchema,
  })
  .loose();
export type ManifestShipment = z.infer<typeof manifestShipmentSchema>;

const manifestStopSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    type: z.string(),
    status: z.string(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    plannedArrivalAt: z.string().nullable(),
    addressId: z.uuid().nullable(),
    address: z
      .object({
        line1: z.string().nullable(),
        city: z.string().nullable(),
        accessNotes: z.string().nullable(),
      })
      .nullable(),
    shipments: z.array(manifestShipmentSchema),
  })
  .loose();
export type ManifestStop = z.infer<typeof manifestStopSchema>;

export const manifestSchema = z
  .object({
    routeId: z.uuid(),
    code: z.string(),
    status: z.string(),
    plannedDate: z.string(),
    driverId: z.uuid().nullable(),
    vehicleId: z.uuid().nullable(),
    startHubId: z.uuid().nullable(),
    summary: z
      .object({
        stopsTotal: z.number().int(),
        stopsCompleted: z.number().int(),
        codExpected: z.array(moneySchema),
      })
      .loose(),
    stops: z.array(manifestStopSchema),
  })
  .loose();
export type Manifest = z.infer<typeof manifestSchema>;

/** An outcome the device recorded and has not yet seen the server confirm. */
export interface Pending {
  readonly shipmentId: string;
  readonly outcome: "DELIVERED" | "FAILED" | "RETURN_COMPLETED";
}

/** A parcel the driver no longer has to act on. */
const SETTLED = new Set(["DELIVERED", "ATTEMPT_FAILED", "RETURN_PENDING", "RETURNED", "CANCELLED"]);
const OPEN_STOP = new Set(["PENDING", "ARRIVED"]);

export type ParcelState = "TODO" | "DELIVERED" | "FAILED" | "RETURNED" | "OTHER";

export interface ParcelView {
  readonly shipment: ManifestShipment;
  readonly state: ParcelState;
  /** Recorded on the device, not yet confirmed by the server. */
  readonly unsent: boolean;
}

function parcelView(shipment: ManifestShipment, pending: readonly Pending[]): ParcelView {
  const local = pending.find((p) => p.shipmentId === shipment.shipmentId);
  if (local !== undefined && !SETTLED.has(shipment.status)) {
    return {
      shipment,
      state:
        local.outcome === "DELIVERED"
          ? "DELIVERED"
          : local.outcome === "FAILED"
            ? "FAILED"
            : "RETURNED",
      unsent: true,
    };
  }
  return { shipment, state: stateOf(shipment.status), unsent: false };
}

function stateOf(status: string): ParcelState {
  if (status === "DELIVERED") return "DELIVERED";
  if (status === "ATTEMPT_FAILED" || status === "RETURN_PENDING") return "FAILED";
  if (status === "RETURNED") return "RETURNED";
  if (SETTLED.has(status)) return "OTHER";
  return "TODO";
}

export interface StopView {
  readonly routeId: string;
  readonly stop: ManifestStop;
  readonly parcels: readonly ParcelView[];
  /** True while at least one parcel still needs the driver. */
  readonly open: boolean;
  readonly cod: readonly Money[];
}

export function stopView(
  routeId: string,
  stop: ManifestStop,
  pending: readonly Pending[],
): StopView {
  const parcels = stop.shipments.map((s) => parcelView(s, pending));
  // A delivery stop is done when every parcel has an outcome, even before the
  // server settles it; a pickup, hub or break stop follows its own status.
  const open =
    stop.type === "DELIVERY"
      ? OPEN_STOP.has(stop.status) && parcels.some((p) => p.state === "TODO")
      : OPEN_STOP.has(stop.status);
  return {
    routeId,
    stop,
    parcels,
    open,
    // Only cash still to collect; a zero is not shown as "0,000 DT".
    cod: sumByCurrency(parcels.filter((p) => p.state === "TODO").map((p) => p.shipment.cod)).filter(
      (money) => !isZero(money),
    ),
  };
}

/** Every stop of the day in route order: the running route first, then the next one. */
export function dayStops(manifests: readonly Manifest[], pending: readonly Pending[]): StopView[] {
  return orderRoutes(manifests).flatMap((m) =>
    [...m.stops]
      .sort((a, b) => a.sequence - b.sequence)
      .map((stop) => stopView(m.routeId, stop, pending)),
  );
}

/** The first open stop of the running route (or of the next route to start). */
export function nextStop(
  manifests: readonly Manifest[],
  pending: readonly Pending[],
): StopView | null {
  return dayStops(manifests, pending).find((s) => s.open) ?? null;
}

export interface DayProgress {
  readonly done: number;
  readonly total: number;
  readonly delivered: number;
  readonly failed: number;
}

/** Parcels, not stops: a stop with three parcels is three doorsteps of work. */
export function dayProgress(
  manifests: readonly Manifest[],
  pending: readonly Pending[],
): DayProgress {
  const parcels = uniqueParcels(manifests, pending);
  return {
    total: parcels.length,
    done: parcels.filter((p) => p.state !== "TODO").length,
    delivered: parcels.filter((p) => p.state === "DELIVERED").length,
    failed: parcels.filter((p) => p.state === "FAILED").length,
  };
}

/**
 * The cash the driver is carrying from today's routes: COD of every parcel
 * delivered (server-confirmed or still queued), per currency.
 */
export function cashCollected(
  manifests: readonly Manifest[],
  pending: readonly Pending[],
): Money[] {
  return sumByCurrency(
    uniqueParcels(manifests, pending)
      .filter((p) => p.state === "DELIVERED")
      .map((p) => p.shipment.cod),
  );
}

export function collectedParcels(
  manifests: readonly Manifest[],
  pending: readonly Pending[],
): ParcelView[] {
  return uniqueParcels(manifests, pending).filter(
    (p) => p.state === "DELIVERED" && !/^0+$/u.test(p.shipment.cod.amountMinor),
  );
}

/** Where a scanned tracking number is on today's routes, if anywhere. */
export function findParcel(
  manifests: readonly Manifest[],
  trackingNumber: string,
): { readonly routeId: string; readonly stopId: string; readonly shipmentId: string } | null {
  const wanted = trackingNumber.trim().toUpperCase();
  for (const m of manifests) {
    for (const stop of m.stops) {
      const hit = stop.shipments.find((s) => s.trackingNumber.toUpperCase() === wanted);
      if (hit !== undefined) {
        return { routeId: m.routeId, stopId: stop.id, shipmentId: hit.shipmentId };
      }
    }
  }
  return null;
}

/** The route the driver is on (IN_PROGRESS), else the next one to start (PUBLISHED). */
export function currentRoute(manifests: readonly Manifest[]): Manifest | null {
  return (
    orderRoutes(manifests).find((m) => m.status === "IN_PROGRESS" || m.status === "PUBLISHED") ??
    null
  );
}

/** A route may be completed once none of its stops is still open. */
export function canComplete(manifest: Manifest, pending: readonly Pending[]): boolean {
  return (
    manifest.status === "IN_PROGRESS" &&
    manifest.stops.every((stop) => !stopView(manifest.routeId, stop, pending).open)
  );
}

const ROUTE_ORDER: Readonly<Record<string, number>> = { IN_PROGRESS: 0, PUBLISHED: 1 };

function orderRoutes(manifests: readonly Manifest[]): Manifest[] {
  return [...manifests].sort(
    (a, b) =>
      (ROUTE_ORDER[a.status] ?? 2) - (ROUTE_ORDER[b.status] ?? 2) ||
      a.plannedDate.localeCompare(b.plannedDate) ||
      a.code.localeCompare(b.code),
  );
}

function uniqueParcels(manifests: readonly Manifest[], pending: readonly Pending[]): ParcelView[] {
  const seen = new Map<string, ParcelView>();
  for (const m of manifests) {
    for (const stop of m.stops) {
      if (stop.type !== "DELIVERY") continue;
      for (const shipment of stop.shipments) {
        if (!seen.has(shipment.shipmentId)) {
          seen.set(shipment.shipmentId, parcelView(shipment, pending));
        }
      }
    }
  }
  return [...seen.values()];
}

/** A parcel on today's routes by id, wherever its stop is. */
export function findShipment(
  manifests: readonly Manifest[],
  shipmentId: string | undefined,
): ManifestShipment | null {
  for (const m of manifests) {
    for (const stop of m.stops) {
      const hit = stop.shipments.find((s) => s.shipmentId === shipmentId);
      if (hit !== undefined) return hit;
    }
  }
  return null;
}
