import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTO_DISPATCH_CONFIDENCE_FLOOR } from "../src/modules/directory/domain/geocoding.js";
import type {
  GeocodeQuery,
  GeocodeResult,
  GeocodingProvider,
} from "../src/modules/directory/domain/geocoding.js";
import { ChainedGeocodingProvider } from "../src/modules/directory/infrastructure/chained-geocoding.provider.js";
import { NominatimGeocodingProvider } from "../src/modules/directory/infrastructure/nominatim-geocoding.provider.js";

/**
 * Geocoding (docs/04-context-map.md §3.3, docs/06 §4.4).
 *
 * Address quality is called out as a primary MENA risk, and the geocoder is the
 * component that decides whether a parcel can be auto-dispatched at all. Two
 * properties carry that weight:
 *
 *  1. **A wrong coordinate is worse than no coordinate.** No pin blocks
 *     auto-dispatch and asks a human; a confident-looking pin in the wrong
 *     governorate sends a driver on a two-hour round trip.
 *  2. **A geocoder outage must never stop a shipment being created.** It
 *     degrades to "unlocated", exactly as the manual provider always did.
 */
describe("geocoding", () => {
  function silentLogger() {
    return {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as never;
  }

  function config(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      NOMINATIM_URL: "http://nominatim.test:8080",
      OTEL_SERVICE_NAME: "core-api",
      ...overrides,
    };
    return { get: (key: string) => values[key] } as never;
  }

  function nominatim(overrides: Record<string, unknown> = {}): NominatimGeocodingProvider {
    return new NominatimGeocodingProvider(config(overrides), silentLogger());
  }

  const tunisAddress: GeocodeQuery = {
    rawInput: "12 Rue de Rome, Tunis",
    line1: "12 Rue de Rome",
    city: "Tunis",
    countryCode: "TN",
  };

  /**
   * One Nominatim place, in the REAL `jsonv2` shape.
   *
   * ⚠️ `category`, not `class`. jsonv2 renames the field, and a stub written from
   * the same wrong assumption as the code proves nothing — which is exactly what
   * happened here until this was checked against a live instance.
   */
  function place(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify([
      {
        lat: "36.8008",
        lon: "10.1817",
        category: "building",
        type: "yes",
        addresstype: "building",
        address: { house_number: "12", road: "Rue de Rome", city: "Tunis" },
        ...overrides,
      },
    ]);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── The Nominatim adapter ──────────────────────────────────────────────────

  describe("Nominatim provider", () => {
    it("returns coordinates for a match", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(place())));

      const result = await nominatim().geocode(tunisAddress);

      expect(result?.location).toEqual({ lat: 36.8008, lng: 10.1817 });
      expect(result?.source).toBe("nominatim");
    });

    it("CONSTRAINS the search to the shipment's country", async () => {
      let requested = "";
      vi.stubGlobal("fetch", (url: string) => {
        requested = url;
        return Promise.resolve(new Response(place()));
      });

      await nominatim().geocode(tunisAddress);

      // ⚠️ Without this, "Ariana" matches a town in Iran and returns a perfectly
      // plausible-looking coordinate. Nothing downstream would question it.
      expect(requested).toContain("countrycodes=tn");
    });

    it("uses a STRUCTURED query when structure is available", async () => {
      let requested = "";
      vi.stubGlobal("fetch", (url: string) => {
        requested = url;
        return Promise.resolve(new Response(place()));
      });

      await nominatim().geocode(tunisAddress);

      // Nominatim forbids mixing `q` with structured fields and silently ignores
      // the structure if both are sent, so it must be one or the other.
      expect(requested).toContain("street=");
      expect(requested).toContain("city=Tunis");
      expect(requested).not.toContain("q=");
    });

    it("falls back to free text when there is no structure to send", async () => {
      let requested = "";
      vi.stubGlobal("fetch", (url: string) => {
        requested = url;
        return Promise.resolve(new Response(place()));
      });

      await nominatim().geocode({ rawInput: "près de la mosquée, Ariana", countryCode: "TN" });

      expect(requested).toContain("q=");
      expect(requested).not.toContain("street=");
    });

    it("scores a building above a governorate boundary", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(place({ category: "building" }))));
      const building = await nominatim().geocode(tunisAddress);

      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(place({ category: "boundary", address: {} }))),
      );
      const boundary = await nominatim().geocode(tunisAddress);

      // ⚠️ Granularity, NOT Nominatim's `importance` — that is a prominence score,
      // so a famous city ranks high on a vague query, which is the wrong signal.
      // A boundary match is a whole governorate; it must not clear the floor.
      expect(building?.confidence).toBeGreaterThanOrEqual(AUTO_DISPATCH_CONFIDENCE_FLOOR);
      expect(boundary?.confidence).toBeLessThan(AUTO_DISPATCH_CONFIDENCE_FLOOR);
    });

    it("scores a match with a house number above one without", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(place({ category: "highway", address: { road: "Rue de Rome" } })),
        ),
      );
      const street = await nominatim().geocode(tunisAddress);

      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(place({ category: "highway", address: { house_number: "12" } })),
        ),
      );
      const doorway = await nominatim().geocode(tunisAddress);

      expect(doorway?.confidence).toBeGreaterThan(street?.confidence ?? 0);
    });

    /**
     * ⚠️ THE BUG THIS FILE ALMOST SHIPPED.
     *
     * `format=json` returns `class`; `format=jsonv2` renames it to `category`.
     * The provider read `class` only, so against a REAL Nominatim every result
     * scored the unknown-class confidence (0.4), landed below the auto-dispatch
     * floor, and every address in the system would have been flagged
     * `requiresReview` — auto-dispatch silently off, platform-wide, with nothing
     * in the logs.
     *
     * The unit tests all passed, because the stubs were written from the same
     * wrong assumption as the code. Only querying a live instance found it.
     */
    it("reads the category under EITHER field name", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(place({ category: "building" }))));
      const jsonv2 = await nominatim().geocode(tunisAddress);

      vi.stubGlobal("fetch", () =>
        // `format=json` shape, with `category` absent entirely.
        Promise.resolve(
          new Response(
            JSON.stringify([{ lat: "36.8008", lon: "10.1817", class: "building", address: {} }]),
          ),
        ),
      );
      const json = await nominatim().geocode(tunisAddress);

      expect(jsonv2?.confidence).toBeGreaterThanOrEqual(AUTO_DISPATCH_CONFIDENCE_FLOOR);
      expect(json?.confidence).toBeGreaterThanOrEqual(AUTO_DISPATCH_CONFIDENCE_FLOOR);
    });

    it("returns null for no match rather than inventing one", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("[]")));

      expect(await nominatim().geocode(tunisAddress)).toBeNull();
    });

    it("DISCARDS an out-of-range coordinate", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(place({ lat: "999", lon: "10.18" }))),
      );

      // A bad pin sends a driver somewhere real and wrong, which is strictly
      // worse than no pin at all.
      expect(await nominatim().geocode(tunisAddress)).toBeNull();
    });

    it("survives a non-JSON body", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>502</html>")));

      expect(await nominatim().geocode(tunisAddress)).toBeNull();
    });

    it("NEVER throws at the caller — a geocoder outage must not block a shipment", async () => {
      vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));

      // Creating a shipment is the merchant's core action. It degrades to an
      // unlocated address (confidence 0 → auto-dispatch blocked), never a 500.
      await expect(nominatim().geocode(tunisAddress)).resolves.toBeNull();
    });

    it("opens the breaker and then stops calling out", async () => {
      let calls = 0;
      vi.stubGlobal("fetch", () => {
        calls += 1;
        return Promise.resolve(new Response("down", { status: 503 }));
      });
      const provider = nominatim();

      for (let i = 0; i < 3; i += 1) {
        expect(await provider.geocode(tunisAddress)).toBeNull();
      }
      const before = calls;
      expect(await provider.geocode(tunisAddress)).toBeNull();

      // A bulk CSV import against a dead geocoder would otherwise spend the full
      // timeout per row.
      expect(calls).toBe(before);
    });

    it("identifies itself, as Nominatim's usage policy requires", async () => {
      let headers: Record<string, string> = {};
      vi.stubGlobal("fetch", (_url: string, init: { headers: Record<string, string> }) => {
        headers = init.headers;
        return Promise.resolve(new Response(place()));
      });

      await nominatim().geocode(tunisAddress);

      expect(headers["user-agent"]).toContain("core-api");
    });

    it("trims a trailing slash on the configured URL", async () => {
      let requested = "";
      vi.stubGlobal("fetch", (url: string) => {
        requested = url;
        return Promise.resolve(new Response(place()));
      });

      await nominatim({ NOMINATIM_URL: "http://nominatim.test:8080/" }).geocode(tunisAddress);

      expect(requested).not.toContain("//search");
    });
  });

  // ── The chain, which is where the cost and privacy argument lives ──────────

  describe("chained provider", () => {
    function fake(result: GeocodeResult | null, calls: { n: number }): GeocodingProvider {
      return {
        geocode: () => {
          calls.n += 1;
          return Promise.resolve(result);
        },
      };
    }

    const strong: GeocodeResult = {
      location: { lat: 36.8, lng: 10.18 },
      confidence: 0.95,
      source: "nominatim",
    };
    const weak: GeocodeResult = {
      location: { lat: 34, lng: 9 },
      confidence: 0.3,
      source: "nominatim",
    };
    const commercial: GeocodeResult = {
      location: { lat: 36.81, lng: 10.19 },
      confidence: 0.9,
      source: "google",
    };

    it("does NOT call the paid provider when the free one is confident", async () => {
      const first = { n: 0 };
      const second = { n: 0 };
      const chain = new ChainedGeocodingProvider(
        [fake(strong, first), fake(commercial, second)],
        silentLogger(),
      );

      const result = await chain.geocode(tunisAddress);

      expect(result?.source).toBe("nominatim");
      // The whole cost and privacy argument for the chain: most addresses never
      // reach the paid link, and never leave the deployment.
      expect(second.n).toBe(0);
    });

    it("falls through on LOW CONFIDENCE, not only on null", async () => {
      const first = { n: 0 };
      const second = { n: 0 };
      const chain = new ChainedGeocodingProvider(
        [fake(weak, first), fake(commercial, second)],
        silentLogger(),
      );

      const result = await chain.geocode(tunisAddress);

      // ⚠️ A geocoder returning a governorate centroid has "succeeded" and
      // produced a coordinate that sends a driver to the middle of a city.
      expect(second.n).toBe(1);
      expect(result?.source).toBe("google");
    });

    it("falls through on null", async () => {
      const second = { n: 0 };
      const chain = new ChainedGeocodingProvider(
        [fake(null, { n: 0 }), fake(commercial, second)],
        silentLogger(),
      );

      expect((await chain.geocode(tunisAddress))?.source).toBe("google");
      expect(second.n).toBe(1);
    });

    it("keeps the BEST answer when nothing clears the floor", async () => {
      const worse: GeocodeResult = { ...weak, confidence: 0.1 };
      const chain = new ChainedGeocodingProvider(
        [fake(worse, { n: 0 }), fake(weak, { n: 0 })],
        silentLogger(),
      );

      const result = await chain.geocode(tunisAddress);

      // Still returned, still below the floor — so the caller stores it and
      // `requiresReview` blocks auto-dispatch. Discarding it would throw away the
      // only hint a human has.
      expect(result?.confidence).toBe(weak.confidence);
      expect(result?.confidence).toBeLessThan(AUTO_DISPATCH_CONFIDENCE_FLOOR);
    });

    it("returns null when every provider fails", async () => {
      const chain = new ChainedGeocodingProvider(
        [fake(null, { n: 0 }), fake(null, { n: 0 })],
        silentLogger(),
      );

      expect(await chain.geocode(tunisAddress)).toBeNull();
    });

    it("works as a chain of one — the shape until a vendor is chosen", async () => {
      const chain = new ChainedGeocodingProvider([fake(strong, { n: 0 })], silentLogger());

      expect((await chain.geocode(tunisAddress))?.source).toBe("nominatim");
    });
  });
});
