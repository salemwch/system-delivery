import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AUTO_DISPATCH_CONFIDENCE_FLOOR } from "../domain/geocoding.js";
import type { GeocodeQuery, GeocodeResult, GeocodingProvider } from "../domain/geocoding.js";

/**
 * Tries geocoders in order and keeps the best answer.
 *
 * The shape the Tunisian market needs: a self-hosted Nominatim handles the
 * addresses OpenStreetMap knows — at no per-request cost and without a customer's
 * home address leaving the deployment — and anything it cannot place with
 * confidence falls through to a commercial provider that is better at informal
 * addressing ("près de la mosquée, Ariana"). Most lookups never reach the paid
 * link, so the bill tracks the hard addresses rather than the volume.
 *
 * ⚠️ Falls through on LOW CONFIDENCE, not merely on null. A geocoder that returns
 * a governorate centroid for a street address has "succeeded" and produced a
 * coordinate that will send a driver to the middle of a city. Below
 * {@link AUTO_DISPATCH_CONFIDENCE_FLOOR} the answer is kept only if nothing
 * better turns up — the caller still receives the best available result, and its
 * confidence is what blocks auto-dispatch (docs/06 §4.4).
 *
 * Ordered by cost, cheapest first, and the order is the composition root's to
 * decide — this class never knows which provider is which.
 */
@Injectable()
export class ChainedGeocodingProvider implements GeocodingProvider {
  constructor(
    private readonly providers: readonly GeocodingProvider[],
    private readonly logger: PinoLogger,
  ) {}

  async geocode(query: GeocodeQuery): Promise<GeocodeResult | null> {
    let best: GeocodeResult | null = null;

    for (const provider of this.providers) {
      // Sequential on purpose. Running them in parallel would send every address
      // to the paid provider — and to a third party — even when the free one
      // answers, which defeats both reasons the chain exists.
      const result = await provider.geocode(query);

      if (result !== null && (best === null || result.confidence > best.confidence)) {
        best = result;
      }
      if (best !== null && best.confidence >= AUTO_DISPATCH_CONFIDENCE_FLOOR) {
        return best;
      }
    }

    if (best !== null && best.confidence < AUTO_DISPATCH_CONFIDENCE_FLOOR) {
      // Worth a log line: a tenant whose addresses systematically land here has a
      // data-quality problem, and it shows up as drivers "getting lost" long
      // before anyone suspects geocoding.
      this.logger.info(
        { confidence: best.confidence, source: best.source, floor: AUTO_DISPATCH_CONFIDENCE_FLOOR },
        "no geocoder cleared the auto-dispatch confidence floor",
      );
    }
    return best;
  }
}
