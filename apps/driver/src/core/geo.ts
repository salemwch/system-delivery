const R = 6_371_000;
const RAD = Math.PI / 180;
const CITY_SPEED_MS = 8.3; // ~30 km/h average city delivery speed

export function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export function etaMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / CITY_SPEED_MS / 60));
}
