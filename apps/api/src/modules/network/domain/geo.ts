/**
 * Distance on the sphere, in metres.
 *
 * Duplicated (not imported from another module) because the layering forbids
 * reaching into another module's internals, and this is a few lines of pure
 * maths. Over the sub-kilometre distances a geofence covers, the haversine
 * formula agrees with PostGIS geodesic distance to well within a phone GPS fix.
 */

const EARTH_RADIUS_METRES = 6_371_008.8;

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export function haversineMetres(a: LatLng, b: LatLng): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}
