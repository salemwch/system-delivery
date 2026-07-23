import { Injectable } from "@nestjs/common";

import type { LatLng } from "../domain/geo.js";
import { sequenceStops } from "../domain/sequencer.js";
import type { SequenceablePoint } from "../domain/sequencer.js";

/**
 * The optimisation port (ADR-003, Anti-Corruption Layer per context-map §5).
 *
 * Dispatch depends on this interface, never on a concrete solver. At MVP the only
 * binding is {@link HeuristicOptimizationProvider} — the deterministic
 * nearest-neighbour + 2-opt fallback over great-circle distances. When the
 * Maghreb OSRM extract is loaded, an `OsrmOptimizationProvider` implements the
 * same port (real road-network matrix, `usedFallback: false`) and is swapped in
 * at the module composition root — no call site in dispatch changes.
 */

export const OPTIMIZATION_PROVIDER = Symbol("OPTIMIZATION_PROVIDER");

export type SolverName = "OSRM_NN_2OPT" | "HAVERSINE_NN_2OPT";

export interface OptimizationRequest {
  readonly points: readonly SequenceablePoint[];
  /** The driver's start location (the start hub), anchoring the open path. */
  readonly start?: LatLng;
}

export interface OptimizationOutput {
  /** Point ids in the optimised visiting order. */
  readonly order: string[];
  readonly distanceM: number;
  readonly durationS: number;
  readonly solver: SolverName;
  /** True when the deterministic fallback ran instead of the road-network solver. */
  readonly usedFallback: boolean;
  readonly solveDurationMs: number;
}

export interface OptimizationProvider {
  optimize(request: OptimizationRequest): Promise<OptimizationOutput>;
}

/**
 * The always-available deterministic fallback. Pure computation over haversine
 * distances — no external service, so it cannot time out or be unavailable, which
 * is exactly why it is the fallback a dispatcher can always fall back to
 * (domain §3.9 rule 8).
 */
@Injectable()
export class HeuristicOptimizationProvider implements OptimizationProvider {
  optimize(request: OptimizationRequest): Promise<OptimizationOutput> {
    // Pure and synchronous, but the port is async so an OSRM implementation (a
    // real network call) can satisfy the same signature — hence Promise.resolve.
    const startedAt = process.hrtime.bigint();
    const result = sequenceStops(request.points, {
      ...(request.start === undefined ? {} : { start: request.start }),
    });
    const solveDurationMs = Number((process.hrtime.bigint() - startedAt) / 1_000n);
    return Promise.resolve({
      order: result.order,
      distanceM: result.distanceM,
      durationS: result.durationS,
      solver: "HAVERSINE_NN_2OPT",
      // This provider IS the fallback: every run it serves is, by definition, a
      // fallback run. The monitored rate is 100% until OSRM is wired — honest,
      // and it makes the eventual cut-over visible in the metric.
      usedFallback: true,
      solveDurationMs,
    });
  }
}
