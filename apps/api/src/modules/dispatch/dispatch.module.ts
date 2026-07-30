import { Module } from "@nestjs/common";

import { AppConfigService } from "../../shared/config/index.js";
import { DirectoryModule } from "../directory/index.js";
import { FleetModule } from "../fleet/index.js";
import { NetworkModule } from "../network/index.js";
import { PlatformModule } from "../platform/index.js";
import { ShipmentModule } from "../shipment/index.js";
import { RouteController } from "./api/route.controller.js";
import { AssignmentService } from "./application/assignment.service.js";
import {
  HeuristicOptimizationProvider,
  OPTIMIZATION_PROVIDER,
} from "./application/optimization.provider.js";
import type { OptimizationProvider } from "./application/optimization.provider.js";
import { RouteService } from "./application/route.service.js";
import { OsrmOptimizationProvider } from "./infrastructure/osrm-optimization.provider.js";
import { OsrmClient } from "./infrastructure/osrm.client.js";

/**
 * Dispatch context (docs/04-context-map.md §3.7) — Layer 2.
 *
 * Planning work: routes, stops, sequencing, assignment. Composes `fleet`
 * (capacity/skills), `network` (hubs), `directory` (address coordinates), and
 * `platform` (outbox + the ROUTE_OPTIMIZATION_ENABLED flag). It is the single
 * sanctioned same-layer caller of `shipment` (context-map §2.1) — assignment and
 * out-for-delivery transitions go through ShipmentService, guarded by the shipment
 * state machine; dispatch never writes shipment state itself.
 *
 * The optimiser is bound through the {@link OPTIMIZATION_PROVIDER} port, selected
 * by `ROUTING_OPTIMIZER` (ADR-003). Both bindings run the same sequencer; the
 * OSRM one supplies a road-network cost matrix and falls back per request when
 * OSRM is unreachable. No call site in dispatch knows which is bound.
 */
@Module({
  imports: [PlatformModule, DirectoryModule, NetworkModule, FleetModule, ShipmentModule],
  controllers: [RouteController],
  providers: [
    RouteService,
    AssignmentService,
    OsrmClient,
    HeuristicOptimizationProvider,
    OsrmOptimizationProvider,
    {
      provide: OPTIMIZATION_PROVIDER,
      // Resolved at boot, not per request: which optimiser is in play is a
      // deployment fact, and re-reading config per route would let it change
      // mid-day with no record of which solver produced which route. The row
      // records the solver name either way (`routes.solver`).
      useFactory: (
        config: AppConfigService,
        heuristic: HeuristicOptimizationProvider,
        osrm: OsrmOptimizationProvider,
      ): OptimizationProvider => (config.get("ROUTING_OPTIMIZER") === "osrm" ? osrm : heuristic),
      inject: [AppConfigService, HeuristicOptimizationProvider, OsrmOptimizationProvider],
    },
  ],
  exports: [RouteService, AssignmentService],
})
export class DispatchModule {}
