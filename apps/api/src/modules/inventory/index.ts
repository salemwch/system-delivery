/**
 * Inventory context public API — gestion de stock.
 *
 * The consumables a hub needs to operate. NOT parcels: a parcel's location is
 * the custody chain, and a second answer would disagree with the first.
 */
export { InventoryModule } from "./inventory.module.js";
export { InventoryService } from "./application/inventory.service.js";
export type { StockRow, MovementPage } from "./application/inventory.service.js";

export { inventoryItems, inventoryMovements, inventoryLevels } from "./domain/schema.js";
export type {
  InventoryItem,
  NewInventoryItem,
  InventoryMovement,
  NewInventoryMovement,
} from "./domain/schema.js";

export { ITEM_UNITS, MOVEMENT_REASONS } from "./domain/dtos.js";
export type {
  ItemUnit,
  MovementReason,
  CreateItemInput,
  UpdateItemInput,
  RecordMovementInput,
  TransferInput,
  ListMovementsInput,
  StockQueryInput,
} from "./domain/dtos.js";
