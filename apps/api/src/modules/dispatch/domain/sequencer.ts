import { haversineMetres } from "./geo.js";
import type { LatLng } from "./geo.js";

/**
 * The deterministic stop sequencer — nearest-neighbour construction followed by
 * 2-opt local improvement (ADR-003, domain §3.9 rule 8).
 *
 * Pure and always-available: it is the fallback that runs when the OSRM
 * road-network matrix is unavailable, and it computes an open-path travel order
 * over great-circle distances. A dispatcher never sees an indefinite spinner —
 * this returns in bounded time for MVP route sizes (tens of stops).
 *
 * Determinism matters: the same input always yields the same order, so a
 * re-optimisation that changes nothing does not reshuffle the driver's day. That
 * is why nearest-neighbour seeds from a fixed anchor (the start hub, or the first
 * point) and 2-opt only accepts a strictly-improving move.
 */

export interface SequenceablePoint {
  readonly id: string;
  readonly location: LatLng;
}

export interface SequenceOptions {
  /** Where the driver begins (the start hub). Anchors the open path. */
  readonly start?: LatLng;
  /** Average travel speed for the duration estimate. Default 30 km/h (urban). */
  readonly averageSpeedMps?: number;
}

export interface SequenceResult {
  /** Point ids in visiting order. */
  readonly order: string[];
  readonly distanceM: number;
  readonly durationS: number;
}

/** ~30 km/h — a defensible Tunis-urban default until OSRM supplies real durations. */
const DEFAULT_SPEED_MPS = 8.333;
const MAX_TWO_OPT_PASSES = 60;
const IMPROVEMENT_EPSILON_M = 0.5;

export function sequenceStops(
  points: readonly SequenceablePoint[],
  options: SequenceOptions = {},
): SequenceResult {
  const speed = options.averageSpeedMps ?? DEFAULT_SPEED_MPS;
  const start = options.start;
  const n = points.length;

  if (n === 0) {
    return { order: [], distanceM: 0, durationS: 0 };
  }

  const coords = points.map((p) => p.location);

  const coordAt = (idx: number): LatLng => {
    if (idx < 0) {
      if (start === undefined) {
        throw new Error("start coordinate referenced but none was provided");
      }
      return start;
    }
    const c = coords[idx];
    if (c === undefined) {
      throw new Error(`coordinate index ${idx} out of range`);
    }
    return c;
  };

  /** Edge length; a leading edge from a non-existent start is free (open path). */
  const edge = (fromIdx: number, toIdx: number): number => {
    if (fromIdx < 0 && start === undefined) {
      return 0;
    }
    return haversineMetres(coordAt(fromIdx), coordAt(toIdx));
  };

  // ── Nearest-neighbour construction, seeded from a fixed anchor. ──────────────
  const visited = new Array<boolean>(n).fill(false);
  const tour: number[] = [];
  let current = seedIndex(coords, start);
  visited[current] = true;
  tour.push(current);
  for (let step = 1; step < n; step++) {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      if (visited[j] === true) {
        continue;
      }
      const d = haversineMetres(coordAt(current), coordAt(j));
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    if (best < 0) {
      break; // unreachable: the loop bound guarantees an unvisited node remains
    }
    visited[best] = true;
    tour.push(best);
    current = best;
  }

  // ── 2-opt improvement over the open path. ───────────────────────────────────
  for (let pass = 0; pass < MAX_TWO_OPT_PASSES; pass++) {
    let improvedAny = false;
    for (let i = 0; i < tour.length - 1; i++) {
      for (let j = i + 1; j < tour.length; j++) {
        const prev = i === 0 ? -1 : indexAt(tour, i - 1);
        const ti = indexAt(tour, i);
        const tj = indexAt(tour, j);
        const hasTrail = j < tour.length - 1;
        const nextIdx = hasTrail ? indexAt(tour, j + 1) : -1;

        const oldLead = edge(prev, ti);
        const newLead = edge(prev, tj);
        const oldTrail = hasTrail ? edge(tj, nextIdx) : 0;
        const newTrail = hasTrail ? edge(ti, nextIdx) : 0;
        const delta = newLead + newTrail - (oldLead + oldTrail);

        if (delta < -IMPROVEMENT_EPSILON_M) {
          reverseInPlace(tour, i, j);
          improvedAny = true;
        }
      }
    }
    if (!improvedAny) {
      break;
    }
  }

  // ── Total travel distance of the anchored open path. ────────────────────────
  let distanceM = 0;
  for (let k = 0; k < tour.length; k++) {
    const from = k === 0 ? -1 : indexAt(tour, k - 1);
    distanceM += edge(from, indexAt(tour, k));
  }

  const order = tour.map((idx) => pointAt(points, idx).id);
  const rounded = Math.round(distanceM);
  return { order, distanceM: rounded, durationS: Math.round(rounded / speed) };
}

/** The nearest point to the anchor, or index 0 when there is no anchor. */
function seedIndex(coords: readonly LatLng[], start: LatLng | undefined): number {
  if (start === undefined) {
    return 0;
  }
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (c === undefined) {
      continue;
    }
    const d = haversineMetres(start, c);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function reverseInPlace(arr: number[], i: number, j: number): void {
  let lo = i;
  let hi = j;
  while (lo < hi) {
    const a = arr[lo];
    const b = arr[hi];
    if (a === undefined || b === undefined) {
      return;
    }
    arr[lo] = b;
    arr[hi] = a;
    lo++;
    hi--;
  }
}

function indexAt(tour: readonly number[], position: number): number {
  const v = tour[position];
  if (v === undefined) {
    throw new Error(`tour position ${position} out of range`);
  }
  return v;
}

function pointAt(points: readonly SequenceablePoint[], idx: number): SequenceablePoint {
  const p = points[idx];
  if (p === undefined) {
    throw new Error(`point index ${idx} out of range`);
  }
  return p;
}
