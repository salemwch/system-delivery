import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../../shared/config/index.js";
import type { GeocodeQuery, GeocodeResult, GeocodingProvider } from "../domain/geocoding.js";

/**
 * Geocoding against a self-hosted Nominatim (OpenStreetMap).
 *
 * Self-hosted by default rather than a commercial API, for three reasons that all
 * matter in this market:
 *
 *  1. **A customer's home address never leaves the deployment.** Every geocode is
 *     personal data about someone who never agreed to a US provider's terms; the
 *     posture INPDP expects is that it stays put.
 *  2. **No per-request cost**, so bulk CSV import of ten thousand shipments is not
 *     a bill.
 *  3. **It runs on the extract already prepared for OSRM** — the same
 *     `tunisia-latest.osm.pbf`, so there is one dataset to keep current.
 *
 * The trade is coverage: OSM is thin on informal Tunisian addressing ("près de
 * la mosquée, Ariana"), which is exactly what a commercial provider is better at.
 * That is why this is one link in {@link ChainedGeocodingProvider} rather than the
 * whole answer — anything it cannot place with confidence falls through.
 *
 * ⚠️ NEVER point this at `nominatim.openstreetmap.org`. The public instance
 * permits ~1 request/second and forbids bulk use; a courier importing a CSV would
 * be banned within a minute, and it would also mean shipping customer addresses
 * to a third party. `NOMINATIM_URL` is expected to be your own.
 *
 * API: https://nominatim.org/release-docs/latest/api/Search/
 */

/** An address lookup blocks a shipment being created; it must not hang. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Consecutive failures before the breaker opens. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

/**
 * Nominatim's `importance` is a PageRank-ish prominence score, not a match
 * confidence — a famous city scores high on a vague query, which is precisely the
 * wrong signal. Confidence is derived from the granularity of what came back
 * instead: a building or house number is a real match, a whole governorate is not.
 */
const CONFIDENCE_BY_CLASS: Readonly<Record<string, number>> = {
  building: 0.95,
  house: 0.95,
  place: 0.8,
  highway: 0.75,
  amenity: 0.7,
  shop: 0.7,
  landuse: 0.5,
  boundary: 0.3,
};

/** Anything not in the table above: locatable, but not trusted for auto-dispatch. */
const UNKNOWN_CLASS_CONFIDENCE = 0.4;

/**
 * A house number in the response is the strongest single signal that the match is
 * the actual doorway rather than the street or the neighbourhood.
 */
const HOUSE_NUMBER_BONUS = 0.05;

interface NominatimPlace {
  readonly lat: string;
  readonly lon: string;
  /**
   * ⚠️ THE SAME FIELD UNDER TWO NAMES, and getting it wrong is silent.
   *
   * `format=json` returns `class`; `format=jsonv2` — which this provider requests,
   * because it also gives `addresstype` — renames it to `category`. Reading only
   * `class` therefore yields `undefined` for every real response, every address
   * scores the unknown-class confidence, and every address in the system is
   * flagged `requiresReview` and blocked from auto-dispatch. Nothing errors; the
   * platform just quietly stops auto-dispatching anything.
   *
   * Found by querying a real Nominatim instance. Unit tests could not catch it —
   * the stubs were written from the same wrong assumption as the code.
   */
  readonly class?: string;
  readonly category?: string;
  readonly type?: string;
  readonly address?: Readonly<Record<string, string>>;
}

@Injectable()
export class NominatimGeocodingProvider implements GeocodingProvider {
  private readonly baseUrl: string;
  private readonly userAgent: string;

  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.baseUrl = config.get("NOMINATIM_URL").replace(/\/+$/u, "");
    // Nominatim's usage policy requires an identifying User-Agent. Self-hosted it
    // is courtesy; it costs nothing and makes your own access logs readable.
    this.userAgent = `${config.get("OTEL_SERVICE_NAME")}/geocoder`;
  }

  async geocode(query: GeocodeQuery): Promise<GeocodeResult | null> {
    if (this.breakerIsOpen()) {
      // Returning null rather than throwing: the caller stores the address with
      // zero confidence and blocks auto-dispatch, which is the same safe outcome
      // as "could not place it". A geocoder outage must not stop a merchant
      // creating a shipment.
      return null;
    }

    const url = `${this.baseUrl}/search?${this.paramsFor(query).toString()}`;
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": this.userAgent },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Nominatim returned ${String(response.status)}`);
      }

      const place = firstPlace(await response.text());
      this.recordSuccess();
      return place === null ? null : toResult(place);
    } catch (error) {
      this.recordFailure();
      // ⚠️ The QUERY is never logged: `rawInput` is a customer's home address.
      // The error and the failure count are what an operator can act on.
      this.logger.warn(
        {
          err: error instanceof Error ? error : new Error(String(error)),
          consecutiveFailures: this.consecutiveFailures,
        },
        "Nominatim geocode failed; address will be stored unlocated",
      );
      return null;
    }
  }

  /**
   * A STRUCTURED query when the caller gave us structure, free-text otherwise.
   *
   * Nominatim's structured mode is markedly more accurate — but it forbids mixing
   * `q` with the structured fields, and sending both makes it ignore the
   * structure silently. Hence one or the other, never both.
   */
  private paramsFor(query: GeocodeQuery): URLSearchParams {
    const params = new URLSearchParams({
      format: "jsonv2",
      addressdetails: "1",
      limit: "1",
      // Constrained to the shipment's own country. Without it "Ariana" matches a
      // town in Iran, and the coordinate looks perfectly plausible on a form.
      countrycodes: query.countryCode.toLowerCase(),
    });

    const street = [query.line1, query.line2].filter(isPresent).join(" ");
    const hasStructure = isPresent(street) || isPresent(query.city);

    if (hasStructure) {
      if (isPresent(street)) {
        params.set("street", street);
      }
      if (isPresent(query.city)) {
        params.set("city", query.city);
      }
      if (isPresent(query.region)) {
        params.set("state", query.region);
      }
      if (isPresent(query.postalCode)) {
        params.set("postalcode", query.postalCode);
      }
    } else {
      params.set("q", query.rawInput);
    }
    return params;
  }

  private breakerIsOpen(): boolean {
    if (this.openedAt === null) {
      return false;
    }
    if (Date.now() - this.openedAt >= BREAKER_COOLDOWN_MS) {
      this.openedAt = null;
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD && this.openedAt === null) {
      this.openedAt = Date.now();
      this.logger.warn(
        { threshold: BREAKER_THRESHOLD, cooldownMs: BREAKER_COOLDOWN_MS },
        "Nominatim circuit breaker opened; addresses will be stored unlocated",
      );
    }
  }
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/** The first usable place from a response, or null. */
function firstPlace(raw: string): NominatimPlace | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  const candidate: unknown = parsed[0];
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const place = candidate as Partial<NominatimPlace>;
  return typeof place.lat === "string" && typeof place.lon === "string"
    ? (place as NominatimPlace)
    : null;
}

function toResult(place: NominatimPlace): GeocodeResult | null {
  const lat = Number.parseFloat(place.lat);
  const lng = Number.parseFloat(place.lon);
  // A non-finite or out-of-range coordinate is discarded rather than stored: a
  // bad pin sends a driver somewhere real and wrong, which is worse than no pin.
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }

  // `category` (jsonv2) or `class` (json) — see the note on NominatimPlace.
  const category = place.category ?? place.class ?? "";
  const base = CONFIDENCE_BY_CLASS[category] ?? UNKNOWN_CLASS_CONFIDENCE;
  const bonus = isPresent(place.address?.["house_number"]) ? HOUSE_NUMBER_BONUS : 0;

  return {
    location: { lat, lng },
    confidence: Math.min(1, base + bonus),
    source: "nominatim",
  };
}
