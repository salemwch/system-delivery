import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { sequenceStops } from "../domain/sequencer.js";
import type {
  OptimizationOutput,
  OptimizationProvider,
  OptimizationRequest,
} from "../application/optimization.provider.js";
import { OsrmClient } from "./osrm.client.js";

/**
 * The road-network binding of {@link OptimizationProvider} (ADR-003, scope §4.3
 * #3.4).
 *
 * Runs the SAME nearest-neighbour + 2-opt sequencer as the heuristic provider,
 * over an OSRM distance/duration matrix instead of great-circle distances. One
 * algorithm, two cost sources — a second copy of the sequencer for road costs is
 * how the two silently diverge, and the road one is the copy nobody re-reads
 * because it only runs in production.
 *
 * ⚠️ IT ALWAYS RETURNS A ROUTE. Domain §3.9 rule 8: a dispatcher must be able to
 * publish a route, and a routing engine being down is not a reason they cannot
 * dispatch the day's work. Every OSRM failure — timeout, non-2xx, unroutable
 * coordinate, open breaker — degrades to the deterministic fallback and reports
 * `usedFallback: true`. That flag is the monitored signal, so a silent permanent
 * degradation is visible rather than merely survivable.
 */
@Injectable()
export class OsrmOptimizationProvider implements OptimizationProvider {
  constructor(
    private readonly osrm: OsrmClient,
    private readonly logger: PinoLogger,
  ) {}

  async optimize(request: OptimizationRequest): Promise<OptimizationOutput> {
    const startedAt = process.hrtime.bigint();
    const start = request.start;
    const startOption = start === undefined ? {} : { start };

    // Fewer than two points has no ordering to optimise and no matrix to fetch —
    // going to OSRM for it would spend a round-trip to learn nothing.
    if (request.points.length >= 2 && this.osrm.available) {
      try {
        const cost = await this.osrm.matrix(
          request.points.map((p) => p.location),
          start,
        );
        const result = sequenceStops(request.points, { ...startOption, cost });
        return {
          order: result.order,
          distanceM: result.distanceM,
          durationS: result.durationS,
          solver: "OSRM_NN_2OPT",
          usedFallback: false,
          solveDurationMs: elapsedMsSince(startedAt),
        };
      } catch (error) {
        // Logged, not rethrown. `OsrmClient` has already recorded the failure
        // against its breaker and logged the cause; this line is about the
        // consequence a dispatcher would otherwise never see.
        this.logger.warn(
          {
            err: error instanceof Error ? error : new Error(String(error)),
            pointCount: request.points.length,
          },
          "OSRM optimisation failed; falling back to great-circle sequencing",
        );
      }
    }

    const result = sequenceStops(request.points, startOption);
    return {
      order: result.order,
      distanceM: result.distanceM,
      durationS: result.durationS,
      solver: "HAVERSINE_NN_2OPT",
      usedFallback: true,
      solveDurationMs: elapsedMsSince(startedAt),
    };
  }
}

function elapsedMsSince(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
