import { Module } from "@nestjs/common";

import { InventoryController } from "./api/inventory.controller.js";
import { InventoryService } from "./application/inventory.service.js";

/**
 * Inventory context — gestion de stock.
 *
 * Layer 3, importing nothing above layer 0. Stock lives AT a hub, but this
 * module never reads the network context: the link is a composite foreign key in
 * migration 0041, so the database proves the hub exists and belongs to the same
 * tenant without inventory knowing what a hub is.
 */
@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
