import { Module } from "@nestjs/common";

import { DirectoryModule } from "../directory/index.js";
import { PlatformModule } from "../platform/index.js";
import { ShipmentController } from "./api/shipment.controller.js";
import { TrackingController } from "./api/tracking.controller.js";
import { BulkShipmentService } from "./application/bulk-shipment.service.js";
import { PickupScanEventHandler } from "./application/pickup-scan-event.handler.js";
import { LabelService } from "./application/label.service.js";
import { ShipmentEventService } from "./application/shipment-event.service.js";
import { ShipmentStatsService } from "./application/shipment-stats.service.js";
import { ShipmentService } from "./application/shipment.service.js";
import { ShipmentTraceabilityService } from "./application/traceability.service.js";
import { TrackingService } from "./application/tracking.service.js";

/**
 * Shipment context (docs/04-context-map.md §3.5) — Layer 2, the core aggregate.
 *
 * Composes `directory` (resolve addresses, find-or-create recipients, validate
 * merchants) and `platform` (the transactional outbox). The custody ledger and
 * the status projection are written only through ShipmentEventService — the
 * single sanctioned writer of `shipments.status`.
 *
 * {@link PickupScanEventHandler} lives here rather than in `pickup` because only
 * this module may write the custody ledger; the worker composition root wires it
 * to the `pickup-scan` consumer group.
 */
@Module({
  imports: [PlatformModule, DirectoryModule],
  controllers: [ShipmentController, TrackingController],
  providers: [
    ShipmentService,
    ShipmentEventService,
    ShipmentStatsService,
    BulkShipmentService,
    TrackingService,
    ShipmentTraceabilityService,
    LabelService,
    PickupScanEventHandler,
  ],
  exports: [ShipmentService, ShipmentEventService, TrackingService, PickupScanEventHandler],
})
export class ShipmentModule {}
