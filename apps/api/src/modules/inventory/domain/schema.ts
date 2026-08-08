import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Inventory schema — gestion de stock (migration `0041_inventory.sql`).
 *
 * ⚠️ Consumables a hub uses to operate — label rolls, tape, bags. NOT parcels: a
 * parcel's location is the custody chain, and a second answer to "where is it?"
 * would immediately disagree with the first.
 */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    nameAr: text("name_ar"),
    /** UNIT | ROLL | BOX | METRE | LITRE — a shelf label, never a conversion. */
    unit: text("unit").notNull().default("UNIT"),
    /** Below this the hub is running out. NULL = never warn. */
    reorderLevel: integer("reorder_level"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("inventory_items_sku_uq").on(table.tenantId, table.sku)],
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    itemId: uuid("item_id").notNull(),
    hubId: uuid("hub_id").notNull(),
    /** IN | OUT. Quantity is always positive; this carries the sign. */
    direction: text("direction").notNull(),
    quantity: integer("quantity").notNull(),
    /** RECEIPT | CONSUMPTION | TRANSFER | STOCKTAKE | DAMAGE. */
    reason: text("reason").notNull(),
    /** The other end of a transfer, set on BOTH rows of the pair. */
    counterpartHubId: uuid("counterpart_hub_id"),
    note: text("note"),
    recordedByUserId: uuid("recorded_by_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_movements_idempotency_uq").on(table.tenantId, table.idempotencyKey),
    index("inventory_movements_stock_idx").on(
      table.tenantId,
      table.hubId,
      table.itemId,
      table.occurredAt,
    ),
  ],
);

/**
 * Stock on hand = SUM(movements).
 *
 * A VIEW, so there is exactly one answer to "how many are there" and it is
 * always the sum of what actually happened. `.existing()` because the migration
 * owns the definition — Drizzle must not try to create it.
 */
export const inventoryLevels = pgView("inventory_levels", {
  tenantId: uuid("tenant_id").notNull(),
  hubId: uuid("hub_id").notNull(),
  itemId: uuid("item_id").notNull(),
  quantity: integer("quantity").notNull(),
}).existing();

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type NewInventoryItem = typeof inventoryItems.$inferInsert;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type NewInventoryMovement = typeof inventoryMovements.$inferInsert;
