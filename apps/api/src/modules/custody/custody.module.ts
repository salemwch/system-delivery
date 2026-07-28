import { Module } from "@nestjs/common";

import { NetworkModule } from "../network/index.js";
import { PlatformModule } from "../platform/index.js";
import { ShipmentModule } from "../shipment/index.js";
import { HubInboundController, ManifestController } from "./api/manifest.controller.js";
import { HubScanService } from "./application/hub-scan.service.js";
import { ManifestService } from "./application/manifest.service.js";

/**
 * Custody context (docs/04-context-map.md §3.8) — Layer 2.
 *
 * Bulk custody transfer between holders: manifests, sealing, scanning,
 * discrepancy detection. Small module, but isolating it keeps `shipment` from
 * absorbing hub-operations logic.
 *
 * One of the two sanctioned same-layer dependencies on `shipment` (the other is
 * `dispatch`), so it records custody events by calling ShipmentService directly.
 * `shipment` remains the only writer of `shipment_events`.
 */
@Module({
  imports: [PlatformModule, NetworkModule, ShipmentModule],
  controllers: [ManifestController, HubInboundController],
  providers: [ManifestService, HubScanService],
  exports: [ManifestService, HubScanService],
})
export class CustodyModule {}
