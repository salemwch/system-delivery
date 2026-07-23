import { haversineMetres } from "./geo.js";
import type { LatLng } from "./geo.js";

/**
 * Pure, in-memory geofence evaluation (docs/04-context-map.md §3.4).
 *
 * `GeofenceService.evaluate()` is called by the `tracking` context on every
 * telemetry batch, so this must be pure and fast — no I/O, no allocation beyond
 * the result. Geofences are preloaded per tenant; this file only decides, given
 * a point and a prior in/out state, which boundaries were crossed.
 *
 * A geofence is a circle: the crossing test is one haversine comparison, which
 * is exact enough at the metres scale a delivery geofence covers and orders of
 * magnitude cheaper than a database round-trip per GPS point.
 */

export interface CircleGeofence {
  readonly id: string;
  readonly centre: LatLng;
  readonly radiusM: number;
}

export type GeofenceTransition = "ENTER" | "EXIT" | "NONE";

export interface GeofenceEvaluation {
  readonly geofenceId: string;
  /** True when the point lies within the geofence radius now. */
  readonly inside: boolean;
  /** ENTER/EXIT when `inside` differs from the prior state; otherwise NONE. */
  readonly transition: GeofenceTransition;
}

/** Whether a point lies within a circular geofence. */
export function isInside(point: LatLng, geofence: CircleGeofence): boolean {
  return haversineMetres(point, geofence.centre) <= geofence.radiusM;
}

/**
 * Evaluates a point against candidate geofences, diffing against the set the
 * subject was previously inside to produce ENTER/EXIT transitions.
 *
 * `previouslyInside` is the caller's memory (per subject, e.g. a driver): the
 * network module holds no per-subject state, which is what keeps this pure and
 * lets the caller decide its own retention and batching.
 */
export function evaluateGeofences(
  point: LatLng,
  candidates: readonly CircleGeofence[],
  previouslyInside: ReadonlySet<string>,
): GeofenceEvaluation[] {
  return candidates.map((geofence) => {
    const inside = isInside(point, geofence);
    const was = previouslyInside.has(geofence.id);
    const transition: GeofenceTransition =
      inside && !was ? "ENTER" : !inside && was ? "EXIT" : "NONE";
    return { geofenceId: geofence.id, inside, transition };
  });
}
