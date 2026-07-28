import { Module } from "@nestjs/common";

import { PlatformModule } from "../platform/index.js";
import { PickupController } from "./api/pickup.controller.js";
import { PickupService } from "./application/pickup.service.js";

/**
 * Pickup context (docs/02-domain-model.md §3.18, docs/01-mvp-scope.md §4.2 #2.11).
 *
 * How parcels enter the system: a Merchant asks the Tenant to collect. Sits
 * upstream of Shipment — a collected pickup becomes 0..n shipments. Depends on
 * Platform for the transactional outbox and on Directory for merchant validation
 * (via direct SQL — no cross-module import needed for the `merchants` table read,
 * as it's within the same tenant transaction scope via RLS).
 */
@Module({
  imports: [PlatformModule],
  controllers: [PickupController],
  providers: [PickupService],
  exports: [PickupService],
})
export class PickupModule {}
