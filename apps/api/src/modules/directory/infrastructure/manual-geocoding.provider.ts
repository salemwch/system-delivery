import { Injectable } from "@nestjs/common";

import type { GeocodeResult, GeocodingProvider } from "../domain/geocoding.js";

/**
 * The MVP geocoding provider: none.
 *
 * No automatic geocoder is wired at MVP — the Mapbox sender-ID-style external
 * integration is late-bound and must never block development, exactly like the
 * SMS provider (CLAUDE.md §4). So this always returns `null`, which makes
 * `AddressService` fall back to the human-placed map pin and otherwise store the
 * address with zero confidence — correctly blocking auto-dispatch instead of
 * fabricating a location.
 *
 * It is the documented, always-available fallback the platform requires for
 * every external-provider call. A `MapboxGeocodingProvider` will implement this
 * same port, config-gated on a token, and swap in with no change to any caller.
 */
@Injectable()
export class ManualGeocodingProvider implements GeocodingProvider {
  geocode(): Promise<GeocodeResult | null> {
    return Promise.resolve(null);
  }
}
