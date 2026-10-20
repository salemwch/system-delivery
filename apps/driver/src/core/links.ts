/**
 * Links the stop screen hands to other apps: the dialler, WhatsApp (how most
 * Tunisian recipients answer a courier) and the driver's navigation app.
 * Universal https links, never a package-specific scheme: they open the app
 * when it is installed and the browser when it is not, and need no
 * package-visibility declaration on Android 11+.
 */

export function telUrl(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/gu, "")}`;
}

/** wa.me wants the international number with no `+` and no spaces. */
export function whatsappUrl(phone: string): string | null {
  const digits = phone.replace(/\D/gu, "");
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
}

export interface Place {
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly label: string | null;
}

const hasPoint = (p: Place): p is Place & { latitude: number; longitude: number } =>
  p.latitude !== null && p.longitude !== null;

/** Turn-by-turn in Google Maps: to the pin when there is one, else to the address text. */
export function mapsUrl(place: Place): string | null {
  if (hasPoint(place)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${String(place.latitude)},${String(place.longitude)}&travelmode=driving`;
  }
  return place.label === null || place.label.trim() === ""
    ? null
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place.label)}&travelmode=driving`;
}

export function wazeUrl(place: Place): string | null {
  if (hasPoint(place)) {
    return `https://waze.com/ul?ll=${String(place.latitude)},${String(place.longitude)}&navigate=yes`;
  }
  return place.label === null || place.label.trim() === ""
    ? null
    : `https://waze.com/ul?q=${encodeURIComponent(place.label)}&navigate=yes`;
}
