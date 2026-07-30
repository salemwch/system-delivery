import { afterEach, describe, expect, it, vi } from "vitest";

import { OsrmOptimizationProvider } from "../src/modules/dispatch/infrastructure/osrm-optimization.provider.js";
import { OsrmClient } from "../src/modules/dispatch/infrastructure/osrm.client.js";
import { sequenceStops } from "../src/modules/dispatch/domain/sequencer.js";
import type { SequenceablePoint } from "../src/modules/dispatch/domain/sequencer.js";

/**
 * OSRM routing binding (docs/01-mvp-scope.md §4.3 #3.4, ADR-003).
 *
 * Two properties matter more than the happy path, and both are here:
 *
 *  1. **It always returns a route.** Domain §3.9 rule 8 — a routing engine being
 *     down must not stop a dispatcher publishing the day's work. Every failure
 *     mode degrades to the deterministic sequencer.
 *  2. **A degradation is visible.** `usedFallback` is the monitored signal, so a
 *     permanently-broken OSRM shows up as a metric rather than as routes that are
 *     quietly 20% longer than they need to be.
 */
describe("OSRM routing", () => {
  const url = "http://osrm.test:5000";

  function config(overrides: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = { OSRM_URL: url, ...overrides };
    return { get: (key: string) => values[key] } as never;
  }

  function silentLogger() {
    return {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    } as never;
  }

  function clientOf(overrides: Record<string, unknown> = {}): OsrmClient {
    return new OsrmClient(config(overrides), silentLogger());
  }

  /** Tunis → Ariana → Sfax. Deliberately not in geographic order. */
  const points: SequenceablePoint[] = [
    { id: "sfax", location: { lat: 34.74, lng: 10.76 } },
    { id: "ariana", location: { lat: 36.8625, lng: 10.1956 } },
    { id: "tunis", location: { lat: 36.8065, lng: 10.1815 } },
  ];
  const startHub = { lat: 36.8, lng: 10.18 };

  /**
   * A square matrix built from a cost function, in the row order OSRM returns:
   * the start anchor first when present, then the stops in input order.
   */
  function tableFor(order: readonly { lat: number; lng: number }[]): string {
    const cell = (
      a: { lat: number; lng: number },
      b: { lat: number; lng: number },
      factor: number,
    ): number => (Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * factor;
    return JSON.stringify({
      code: "Ok",
      distances: order.map((a) => order.map((b) => cell(a, b, 100_000))),
      durations: order.map((a) => order.map((b) => cell(a, b, 5_000))),
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── The client ─────────────────────────────────────────────────────────────

  describe("client", () => {
    it("asks for ONE table, not a call per pair", async () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", (requested: string) => {
        calls.push(requested);
        return Promise.resolve(
          new Response(tableFor([startHub, ...points.map((p) => p.location)])),
        );
      });

      await clientOf().matrix(
        points.map((p) => p.location),
        startHub,
      );

      // ⚠️ Sequencing 3 stops touches a dozen pairs; 25 stops touches hundreds.
      // One round-trip per pair is minutes of latency and an OSRM instance
      // saturated by a single dispatcher.
      expect(calls).toHaveLength(1);
    });

    it("sends coordinates as lon,lat — the opposite of every UI", async () => {
      let requested = "";
      vi.stubGlobal("fetch", (url_: string) => {
        requested = url_;
        return Promise.resolve(new Response(tableFor(points.map((p) => p.location))));
      });

      await clientOf().matrix(points.map((p) => p.location));

      // Swapping these does not error — it silently routes in the Indian Ocean,
      // returns plausible numbers, and nobody notices until a driver does.
      expect(requested).toContain("10.76,34.74");
      expect(requested).not.toContain("34.74,10.76");
    });

    it("requests both annotations — a distance-only table has no durations", async () => {
      let requested = "";
      vi.stubGlobal("fetch", (url_: string) => {
        requested = url_;
        return Promise.resolve(new Response(tableFor(points.map((p) => p.location))));
      });

      await clientOf().matrix(points.map((p) => p.location));

      expect(requested).toContain("annotations=duration,distance");
    });

    it("trims a trailing slash on the configured base URL", async () => {
      let requested = "";
      vi.stubGlobal("fetch", (url_: string) => {
        requested = url_;
        return Promise.resolve(new Response(tableFor(points.map((p) => p.location))));
      });

      await clientOf({ OSRM_URL: `${url}/` }).matrix(points.map((p) => p.location));

      // `${base}//table/...` is a 404 on OSRM, and an infuriating one to trace
      // back to a trailing slash in an env file.
      expect(requested).not.toContain("//table");
    });

    it("maps the start anchor to sequencer index -1", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(tableFor([startHub, ...points.map((p) => p.location)]))),
      );

      const matrix = await clientOf().matrix(
        points.map((p) => p.location),
        startHub,
      );

      // Row 0 IS the start when one is supplied, so every stop shifts by one.
      // Getting this off by one silently returns another stop's costs.
      const expected = (Math.abs(startHub.lat - 34.74) + Math.abs(startHub.lng - 10.76)) * 100_000;
      expect(matrix.distanceM(-1, 0)).toBeCloseTo(expected, 5);
      expect(matrix.distanceM(0, 0)).toBe(0);
    });

    it("rejects a body whose code is not Ok, even on HTTP 200", async () => {
      // OSRM signals NoSegment (a coordinate with no road nearby) in the BODY
      // with status 200, so the status alone proves nothing.
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(JSON.stringify({ code: "NoSegment" }), { status: 200 })),
      );

      await expect(clientOf().matrix(points.map((p) => p.location))).rejects.toThrow(/NoSegment/u);
    });

    it("rejects a matrix that is not square at the expected size", async () => {
      // ⚠️ A short row is worse than an error: the sequencer would read
      // undefined, coerce to NaN, and every comparison against NaN is false — so
      // 2-opt accepts nothing and the route silently stays at its construction.
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "Ok", distances: [[0, 1]], durations: [[0, 1]] }), {
            status: 200,
          }),
        ),
      );

      await expect(clientOf().matrix(points.map((p) => p.location))).rejects.toThrow(/3-row/u);
    });

    it("rejects a non-JSON body", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 200 })),
      );

      await expect(clientOf().matrix(points.map((p) => p.location))).rejects.toThrow(/non-JSON/u);
    });

    it("rejects a non-2xx", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 503 })));

      await expect(clientOf().matrix(points.map((p) => p.location))).rejects.toThrow(/503/u);
    });

    it("turns an unroutable pair into Infinity, not zero", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: "Ok",
              distances: [
                [0, null],
                [null, 0],
              ],
              durations: [
                [0, null],
                [null, 0],
              ],
            }),
          ),
        ),
      );

      const matrix = await clientOf().matrix([
        { lat: 36.8, lng: 10.18 },
        { lat: 37.5, lng: 9.0 },
      ]);

      // ⚠️ Zero would make an impossible leg look FREE and actively attract the
      // tour to it; NaN would make every comparison false and quietly disable
      // 2-opt. Infinity makes it maximally unattractive and leaves the
      // arithmetic sound.
      expect(matrix.distanceM(0, 1)).toBe(Number.POSITIVE_INFINITY);
    });

    it("refuses a single point rather than spending a round-trip", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await expect(clientOf().matrix([{ lat: 36.8, lng: 10.18 }])).rejects.toThrow(/two points/u);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses an implausibly large matrix before calling out", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const many = Array.from({ length: 201 }, (_, i) => ({ lat: 36 + i / 1000, lng: 10 }));

      // 2-opt is O(n²) per pass. Hundreds of stops on one route is a data error
      // (an unfiltered leg query), and a clear failure beats a slow one.
      await expect(clientOf().matrix(many)).rejects.toThrow(/exceeds/u);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("opens the breaker after repeated failures and then fails fast", async () => {
      let calls = 0;
      vi.stubGlobal("fetch", () => {
        calls += 1;
        return Promise.resolve(new Response("down", { status: 503 }));
      });
      const client = clientOf();

      for (let i = 0; i < 3; i += 1) {
        await expect(client.matrix(points.map((p) => p.location))).rejects.toThrow();
      }
      expect(client.available).toBe(false);

      const callsBefore = calls;
      await expect(client.matrix(points.map((p) => p.location))).rejects.toThrow(/breaker/u);
      // The point of the breaker: no socket is opened at all, so an OSRM outage
      // does not become a request-latency outage.
      expect(calls).toBe(callsBefore);
    });

    it("closes the breaker again once a request succeeds", async () => {
      let fail = true;
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          fail
            ? new Response("down", { status: 503 })
            : new Response(tableFor(points.map((p) => p.location))),
        ),
      );
      const client = clientOf();

      await expect(client.matrix(points.map((p) => p.location))).rejects.toThrow();
      fail = false;
      await client.matrix(points.map((p) => p.location));

      expect(client.available).toBe(true);
    });
  });

  // ── The provider ───────────────────────────────────────────────────────────

  describe("provider", () => {
    it("sequences over the road matrix and reports the OSRM solver", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(tableFor([startHub, ...points.map((p) => p.location)]))),
      );
      const provider = new OsrmOptimizationProvider(clientOf(), silentLogger());

      const result = await provider.optimize({ points, start: startHub });

      expect(result.solver).toBe("OSRM_NN_2OPT");
      expect(result.usedFallback).toBe(false);
      expect(result.order).toHaveLength(3);
      // Nearest first from the hub: Tunis and Ariana before Sfax, 270 km away.
      expect(result.order[2]).toBe("sfax");
    });

    it("sums the matrix durations rather than dividing distance by a flat speed", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(new Response(tableFor([startHub, ...points.map((p) => p.location)]))),
      );
      const provider = new OsrmOptimizationProvider(clientOf(), silentLogger());

      const result = await provider.optimize({ points, start: startHub });

      // ⚠️ The ratio must NOT be the fallback's flat 8.333 m/s. A flat speed over
      // real road distance looks precise and still cannot tell a motorway from a
      // medina alley — which is the entire reason for calling OSRM.
      const stub = tableFor([startHub, ...points.map((p) => p.location)]);
      expect(stub).toContain("durations");
      expect(result.durationS).toBeGreaterThan(0);
      expect(result.distanceM / result.durationS).toBeCloseTo(20, 0);
    });

    // ── The property that matters most ───────────────────────────────────────

    it("STILL RETURNS A ROUTE when OSRM is unreachable", async () => {
      vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
      const provider = new OsrmOptimizationProvider(clientOf(), silentLogger());

      const result = await provider.optimize({ points, start: startHub });

      // Domain §3.9 rule 8. A routing engine being down is not a reason a
      // dispatcher cannot send out the day's work.
      expect(result.order).toHaveLength(3);
      expect(result.solver).toBe("HAVERSINE_NN_2OPT");
      expect(result.usedFallback).toBe(true);
    });

    it("returns a route when OSRM answers with garbage", async () => {
      vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));
      const provider = new OsrmOptimizationProvider(clientOf(), silentLogger());

      const result = await provider.optimize({ points });

      expect(result.order).toHaveLength(3);
      expect(result.usedFallback).toBe(true);
    });

    it("skips OSRM entirely while the breaker is open", async () => {
      let calls = 0;
      vi.stubGlobal("fetch", () => {
        calls += 1;
        return Promise.resolve(new Response("down", { status: 503 }));
      });
      const client = clientOf();
      const provider = new OsrmOptimizationProvider(client, silentLogger());

      for (let i = 0; i < 4; i += 1) {
        const result = await provider.optimize({ points, start: startHub });
        expect(result.usedFallback).toBe(true);
      }

      // Three attempts open the breaker; the fourth route is planned with no
      // network call at all — the dispatcher does not pay the timeout.
      expect(calls).toBe(3);
    });

    it("does not call OSRM for a single stop — there is nothing to order", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const provider = new OsrmOptimizationProvider(clientOf(), silentLogger());

      const result = await provider.optimize({ points: [points[0]!], start: startHub });

      expect(result.order).toEqual(["sfax"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("handles an empty request without reaching for a matrix", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const provider = new OsrmOptimizationProvider(clientOf(), silentLogger());

      const result = await provider.optimize({ points: [] });

      expect(result.order).toEqual([]);
      expect(result.distanceM).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ── The shared sequencer ───────────────────────────────────────────────────

  describe("sequencer with an injected cost", () => {
    /**
     * ⚠️ The reason the cost function is injected rather than the sequencer
     * duplicated. Construction and improvement must consult the SAME costs:
     * great-circle construction plus road-network 2-opt yields a tour optimal for
     * neither, and the bug is invisible because both halves work.
     */
    it("orders by the injected cost, not by great-circle distance", () => {
      // A cost that inverts geography: what is nearest by air is furthest by
      // "road". Only a sequencer that consults the injected cost everywhere can
      // produce the inverted order.
      // Sfax is 270 km away and is `points[0]`, so making index 0 the cheapest
      // from the anchor inverts geography outright.
      const cost = {
        distanceM: (from: number, to: number) => (from < 0 ? 100 + to * 100 : 10),
        durationS: () => 60,
      };

      const byAir = sequenceStops(points, { start: startHub });
      const byRoad = sequenceStops(points, { start: startHub, cost });

      expect(byAir.order[0]).toBe("tunis");
      expect(byRoad.order[0]).toBe("sfax");
    });

    it("sums injected durations instead of dividing by the default speed", () => {
      const cost = { distanceM: () => 1000, durationS: () => 120 };

      const result = sequenceStops(points, { start: startHub, cost });

      // Three legs from the anchor at 120s each.
      expect(result.durationS).toBe(360);
      expect(result.distanceM).toBe(3000);
    });

    it("is unchanged when no cost is injected", () => {
      const withoutCost = sequenceStops(points, { start: startHub });

      // The fallback must behave exactly as before this refactor: it is what runs
      // on every deployment that has not loaded an OSRM extract.
      expect(withoutCost.order).toHaveLength(3);
      expect(withoutCost.distanceM).toBeGreaterThan(0);
      expect(withoutCost.durationS).toBe(Math.round(withoutCost.distanceM / 8.333));
    });
  });
});
