/**
 * The geocoding seam (docs/04-context-map.md §3.3).
 *
 * `AddressService` depends only on this port, so the provider — Mapbox at MVP
 * intent, Google or a self-hosted geocoder later — can be swapped without
 * touching any other module. Isolating it here is the whole reason the address
 * pipeline is its own concern.
 */

/** WGS84 coordinates. Longitude first is the PostGIS/GeoJSON convention. */
export interface Coordinates {
  readonly lat: number;
  readonly lng: number;
}

/** The normalised address a provider is asked to locate. */
export interface GeocodeQuery {
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly countryCode: string;
  /** The unparsed original, for providers that geocode free text. */
  readonly rawInput: string;
}

/** A provider that could not confidently locate an input returns `null`. */
export interface GeocodeResult {
  readonly location: Coordinates;
  /** 0–1. The provider's own confidence in the match. */
  readonly confidence: number;
  readonly source: "mapbox" | "google";
}

export interface GeocodingProvider {
  geocode(query: GeocodeQuery): Promise<GeocodeResult | null>;
}

/** DI token for the active {@link GeocodingProvider}. */
export const GEOCODING_PROVIDER = Symbol("GEOCODING_PROVIDER");

/**
 * The hard floor below which an address is flagged `requiresReview` and blocked
 * from auto-dispatch (docs/06-database-design.md §4.4, Blueprint risk D2).
 *
 * A constant at MVP. It becomes a per-tenant `TenantFeature`-driven threshold
 * when tenants tune their own risk appetite — the resolver already returns the
 * confidence, so that change is additive.
 */
export const AUTO_DISPATCH_CONFIDENCE_FLOOR = 0.7;

/** Confidence assigned to a human-placed map pin — a person is authoritative. */
export const MANUAL_PIN_CONFIDENCE = 1;

/** Confidence for a driver's on-the-ground correction — the strongest signal. */
export const DRIVER_CORRECTION_CONFIDENCE = 1;
