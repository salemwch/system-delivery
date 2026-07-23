/**
 * Great-circle distance (docs/03 — deterministic substitutes, no ML/OSRM at MVP).
 *
 * Pure, no I/O. This is the fallback distance metric the heuristic sequencer uses
 * when the OSRM road-network matrix is unavailable (ADR-003). Repeated here rather
 * than imported from another module — the layering forbids cross-module internal
 * imports, and a three-line formula is not worth a shared package.
 */

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Haversine distance between two WGS-84 points, in metres. */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
