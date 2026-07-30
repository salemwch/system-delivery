import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../../shared/config/index.js";
import type { LatLng } from "../domain/geo.js";
import type { TravelCost } from "../domain/sequencer.js";

/**
 * A thin client for the OSRM Table service (road-network distance/duration
 * matrices) — the Anti-Corruption Layer for the only external routing engine the
 * MVP uses (ADR-003, docs/04-context-map.md §5).
 *
 * ⚠️ ONE `/table` CALL PER OPTIMISATION, never one `/route` call per pair.
 * Sequencing 25 stops touches ~650 pairs across the 2-opt passes; at one HTTP
 * round-trip each that is minutes of latency and an OSRM instance saturated by a
 * single dispatcher. The matrix is fetched once and every subsequent lookup is an
 * array index.
 *
 * Deliberately NOT vendor-neutral in the way the SMS provider is: OSRM is the
 * named MVP engine (technology-decisions.md, "Routing: OSRM behind adapter") and
 * a Google/Mapbox binding would be a second implementation of `TravelCost`,
 * not a reshaped body here.
 *
 * OSRM Table API: https://project-osrm.org/docs/v5.24.0/api/#table-service
 */

/**
 * A route planned for a dispatcher rarely blocks a driver, but it always blocks a
 * page. Ten seconds is generous for a local matrix and still bounded.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Consecutive failures before the breaker opens. */
const BREAKER_THRESHOLD = 3;

/** How long the breaker stays open before letting one request through to probe. */
const BREAKER_COOLDOWN_MS = 30_000;

/**
 * The compose service runs `--max-table-size 8000`, so the real ceiling is far
 * above this. The cap here is about the SEQUENCER: 2-opt is O(n²) per pass, and a
 * route with hundreds of stops is a data error (an unfiltered leg query), not a
 * driver's day. Refusing early gives a clear failure instead of a slow one.
 */
const MAX_MATRIX_POINTS = 200;

@Injectable()
export class OsrmClient {
  private readonly baseUrl: string;

  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    // Trailing slash trimmed once here: `${base}//table/...` is a 404 on OSRM and
    // an infuriating one to diagnose from a config value.
    this.baseUrl = config.get("OSRM_URL").replace(/\/+$/u, "");
  }

  /** True when a call would fail fast — lets the caller skip straight to fallback. */
  get available(): boolean {
    return !this.breakerIsOpen();
  }

  /**
   * Fetches the full square matrix for `start` (when present) followed by `stops`.
   *
   * Throws on timeout, a non-2xx, a malformed body, or an open breaker. The caller
   * is expected to fall back to great-circle distances — a dispatcher must always
   * get a route (domain §3.9 rule 8), so this never being available is a
   * degradation, not an outage.
   */
  async matrix(stops: readonly LatLng[], start?: LatLng): Promise<TravelCost> {
    const points = start === undefined ? [...stops] : [start, ...stops];
    // The offset that maps sequencer indices onto matrix rows: with a start
    // anchor, row 0 IS the start (sequencer index -1), so every stop shifts by
    // one. Getting this wrong silently returns another stop's costs.
    const offset = start === undefined ? 0 : 1;

    if (points.length < 2) {
      throw new Error("OSRM matrix needs at least two points");
    }
    if (points.length > MAX_MATRIX_POINTS) {
      throw new Error(
        `OSRM matrix refused: ${String(points.length)} points exceeds the ${String(MAX_MATRIX_POINTS)} cap`,
      );
    }
    if (this.breakerIsOpen()) {
      throw new Error("OSRM circuit breaker is open");
    }

    // OSRM takes lon,lat — the opposite of every UI and of `LatLng`. Swapping
    // these does not error; it silently routes in the Indian Ocean.
    const coordinates = points.map((p) => `${String(p.lng)},${String(p.lat)}`).join(";");
    const url = `${this.baseUrl}/table/v1/driving/${coordinates}?annotations=duration,distance`;

    // `AbortSignal.timeout` aborts the socket. A manual race leaves the request
    // running and the connection held, which is how a slow OSRM exhausts sockets.
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { method: "GET", signal });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`OSRM returned ${String(response.status)}: ${detail}`);
      }

      const table = parseTable(await response.text(), points.length);
      this.recordSuccess();
      return matrixOf(table, offset);
    } catch (error) {
      this.recordFailure();
      // The coordinates are a driver's route and a customer's address — the
      // count is what is actionable for an operator, the payload is not.
      this.logger.warn(
        {
          err: error instanceof Error ? error : new Error(String(error)),
          pointCount: points.length,
          consecutiveFailures: this.consecutiveFailures,
        },
        "OSRM matrix request failed; caller will fall back",
      );
      throw error;
    }
  }

  private breakerIsOpen(): boolean {
    if (this.openedAt === null) {
      return false;
    }
    if (Date.now() - this.openedAt >= BREAKER_COOLDOWN_MS) {
      // Half-open: this one probes. Success closes, failure re-opens.
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
        "OSRM circuit breaker opened; routes will use the haversine fallback",
      );
    }
  }
}

interface OsrmTable {
  readonly distances: readonly (readonly (number | null)[])[];
  readonly durations: readonly (readonly (number | null)[])[];
}

/**
 * Validates the response into a square table of the expected size.
 *
 * Strict about the SHAPE because a short row is worse than an error: the
 * sequencer would read `undefined`, coerce to `NaN`, and every comparison against
 * `NaN` is false — so 2-opt accepts nothing, the tour silently stays at its
 * nearest-neighbour construction, and the route looks plausible.
 */
function parseTable(raw: string, expected: number): OsrmTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OSRM returned a non-JSON body");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("OSRM returned a non-object body");
  }
  const body: Record<string, unknown> = { ...parsed };

  if (body["code"] !== "Ok") {
    // OSRM signals `NoSegment` (a coordinate with no road nearby) and `NoTable`
    // in the body with HTTP 200, so the status alone proves nothing.
    throw new Error(`OSRM code ${typeof body["code"] === "string" ? body["code"] : "missing"}`);
  }

  return {
    distances: squareOf(body["distances"], expected, "distances"),
    durations: squareOf(body["durations"], expected, "durations"),
  };
}

function squareOf(value: unknown, expected: number, field: string): (number | null)[][] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`OSRM ${field} is not a ${String(expected)}-row matrix`);
  }
  return value.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== expected) {
      throw new Error(`OSRM ${field} row is not ${String(expected)} wide`);
    }
    return row.map((cell: unknown) =>
      typeof cell === "number" && Number.isFinite(cell) ? cell : null,
    );
  });
}

/**
 * Wraps the table in index arithmetic the sequencer understands.
 *
 * An unroutable pair (`null` — OSRM found no path, typically an island or a
 * coordinate off the network) becomes `Infinity`. That makes the pair maximally
 * unattractive without poisoning the arithmetic: `NaN` would make every
 * comparison false and quietly disable 2-opt, and `0` would make the impossible
 * leg look free and actively attract the tour to it.
 */
function matrixOf(table: OsrmTable, offset: number): TravelCost {
  const at = (grid: readonly (readonly (number | null)[])[], from: number, to: number): number => {
    const row = grid[from + offset];
    const cell = row?.[to + offset];
    return cell === null || cell === undefined ? Number.POSITIVE_INFINITY : cell;
  };
  return {
    distanceM: (from, to) => at(table.distances, from, to),
    durationS: (from, to) => at(table.durations, from, to),
  };
}
