import { Module } from "@nestjs/common";

import { DirectoryModule } from "../directory/index.js";
import { FleetModule } from "../fleet/index.js";
import { NetworkModule } from "../network/index.js";
import { PlatformModule } from "../platform/index.js";
import { ShipmentModule } from "../shipment/index.js";
import { AssignmentService } from "./application/assignment.service.js";
import {
  HeuristicOptimizationProvider,
  OPTIMIZATION_PROVIDER,
} from "./application/optimization.provider.js";
import { RouteService } from "./application/route.service.js";

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
 * The optimiser is bound through the {@link OPTIMIZATION_PROVIDER} port. At MVP
 * the only binding is the deterministic haversine fallback; the OSRM provider
 * (ADR-003) slots in here when the Maghreb extract is loaded — no call site
 * changes. Exposes services rather than controllers at MVP, per contract 05.
 */
@Module({
  imports: [PlatformModule, DirectoryModule, NetworkModule, FleetModule, ShipmentModule],
  providers: [
    RouteService,
    AssignmentService,
    { provide: OPTIMIZATION_PROVIDER, useClass: HeuristicOptimizationProvider },
  ],
  exports: [RouteService, AssignmentService],
})
export class DispatchModule {}
