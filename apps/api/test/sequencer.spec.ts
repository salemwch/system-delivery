import { describe, expect, it } from "vitest";

import { sequenceStops } from "../src/modules/dispatch/domain/sequencer.js";
import type { SequenceablePoint } from "../src/modules/dispatch/domain/sequencer.js";
import { haversineMetres } from "../src/modules/dispatch/domain/geo.js";

/**
 * The deterministic fallback sequencer (ADR-003). Pure — no database — so it
 * proves the nearest-neighbour + 2-opt logic in isolation: it never worsens a
 * tour, it is deterministic (a re-run reshuffles nothing), and it handles the
 * empty / single-stop boundaries.
 */
describe("sequenceStops", () => {
  function point(id: string, lat: number, lng: number): SequenceablePoint {
    return { id, location: { lat, lng } };
  }

  it("returns nothing for no stops", () => {
    const result = sequenceStops([]);
    expect(result.order).toEqual([]);
    expect(result.distanceM).toBe(0);
    expect(result.durationS).toBe(0);
  });

  it("handles a single stop, measuring from the start anchor", () => {
    const only = point("a", 36.81, 10.18);
    const result = sequenceStops([only], { start: { lat: 36.8, lng: 10.18 } });
    expect(result.order).toEqual(["a"]);
    expect(result.distanceM).toBeGreaterThan(0);
  });

  it("orders collinear stops monotonically from the anchor", () => {
    // Four points along a meridian, given scrambled. Anchored just below them,
    // the only sensible visit order is south-to-north.
    const scrambled = [
      point("p2", 36.82, 10.18),
      point("p0", 36.8, 10.18),
      point("p3", 36.83, 10.18),
      point("p1", 36.81, 10.18),
    ];
    const result = sequenceStops(scrambled, { start: { lat: 36.79, lng: 10.18 } });
    expect(result.order).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("never produces a tour longer than the given order", () => {
    // A deliberately crossed input order over a square.
    const crossed = [
      point("a", 36.8, 10.18),
      point("b", 36.81, 10.19),
      point("c", 36.8, 10.19),
      point("d", 36.81, 10.18),
    ];
    const start = { lat: 36.8, lng: 10.18 };
    const givenOrderDistance = pathLength(crossed, start);
    const result = sequenceStops(crossed, { start });
    expect(result.distanceM).toBeLessThanOrEqual(Math.round(givenOrderDistance) + 1);
  });

  it("is deterministic — the same input yields the same order", () => {
    const points = [
      point("a", 36.8, 10.2),
      point("b", 36.85, 10.15),
      point("c", 36.82, 10.25),
      point("d", 36.79, 10.18),
      point("e", 36.9, 10.3),
    ];
    const first = sequenceStops(points, { start: { lat: 36.8, lng: 10.18 } });
    const second = sequenceStops(points, { start: { lat: 36.8, lng: 10.18 } });
    expect(second.order).toEqual(first.order);
    expect(second.distanceM).toBe(first.distanceM);
  });
});

/** Total travel over the points in the given order, anchored at start. */
function pathLength(
  points: readonly SequenceablePoint[],
  start: { lat: number; lng: number },
): number {
  let total = 0;
  let prev = start;
  for (const p of points) {
    total += haversineMetres(prev, p.location);
    prev = p.location;
  }
  return total;
}
