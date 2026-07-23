/**
 * Distance on the sphere, in metres (docs/06-database-design.md §4.6).
 *
 * Used to compute a POD's distance from the shipment's destination on write —
 * the input to the fraud distance rule (>150 m; event-storming P8). Over the
 * sub-kilometre distances that matter for "was the parcel actually delivered
 * where it should have been", the haversine formula agrees with PostGIS geodesic
 * distance to well within the tolerance of a phone GPS fix, so we compute it in
 * process rather than round-tripping to the database for a scalar.
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
