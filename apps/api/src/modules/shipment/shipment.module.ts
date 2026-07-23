import { Module } from "@nestjs/common";

import { DirectoryModule } from "../directory/index.js";
import { PlatformModule } from "../platform/index.js";
import { ShipmentEventService } from "./application/shipment-event.service.js";
import { ShipmentService } from "./application/shipment.service.js";

/**
 * Shipment context (docs/04-context-map.md §3.5) — Layer 2, the core aggregate.
 *
 * Composes `directory` (resolve addresses, find-or-create recipients, validate
 * merchants) and `platform` (the transactional outbox). The custody ledger and
 * the status projection are written only through ShipmentEventService — the
 * single sanctioned writer of `shipments.status`. Exposes services rather than
 * controllers at MVP, per the contract in docs/05.
 */
@Module({
  imports: [PlatformModule, DirectoryModule],
  providers: [ShipmentService, ShipmentEventService],
  exports: [ShipmentService, ShipmentEventService],
})
export class ShipmentModule {}
