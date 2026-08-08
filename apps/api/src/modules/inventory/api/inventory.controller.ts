import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { InventoryService } from "../application/inventory.service.js";
import type { StockRow } from "../application/inventory.service.js";
import {
  MOVEMENT_REASONS,
  createItemSchema,
  recordMovementSchema,
  transferSchema,
  updateItemSchema,
} from "../domain/dtos.js";
import type { InventoryItem, InventoryMovement } from "../domain/schema.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  hubId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  reason: z.enum(MOVEMENT_REASONS).optional(),
});

const stockQuerySchema = z.object({
  hubId: z.string().min(1).optional(),
  lowOnly: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface ItemResponse {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly unit: string;
  readonly reorderLevel: number | null;
  readonly active: boolean;
}

interface MovementResponse {
  readonly id: string;
  readonly itemId: string;
  readonly hubId: string;
  readonly direction: string;
  readonly quantity: number;
  readonly reason: string;
  readonly counterpartHubId: string | null;
  readonly note: string | null;
  readonly recordedByUserId: string;
  readonly occurredAt: string;
}

interface StockResponse {
  readonly hubId: string;
  readonly itemId: string;
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly reorderLevel: number | null;
  readonly low: boolean;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Gestion de stock.
 *
 * Reading is `inventory:read`, moving stock is `inventory:manage`. A hub
 * operator holds both — they are the person on the shelf — while a merchant
 * holds neither: what a courier keeps in its store room is not their business.
 */
@Controller("v1/inventory")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // ── Items ──────────────────────────────────────────────────────────────────
  //
  // Declared before the movement routes so "items" is never taken for an id.

  @Post("items")
  @RequirePermissions("inventory:manage")
  @HttpCode(HttpStatus.CREATED)
  async createItem(
    @Body(zodBody(createItemSchema)) body: z.infer<typeof createItemSchema>,
  ): Promise<ItemResponse> {
    return toItem(await this.inventory.createItem(body));
  }

  @Get("items")
  @RequirePermissions("inventory:read")
  async listItems(
    @Query("activeOnly") activeOnly?: string,
  ): Promise<{ readonly data: readonly ItemResponse[] }> {
    return { data: (await this.inventory.listItems(activeOnly === "true")).map(toItem) };
  }

  @Patch("items/:id")
  @RequirePermissions("inventory:manage")
  async updateItem(
    @Param("id") id: string,
    @Body(zodBody(updateItemSchema)) body: z.infer<typeof updateItemSchema>,
  ): Promise<ItemResponse> {
    return toItem(await this.inventory.updateItem(id, body));
  }

  // ── Stock ──────────────────────────────────────────────────────────────────

  /** What is on the shelves. Derived from the movements, never a counter. */
  @Get("stock")
  @RequirePermissions("inventory:read")
  async stock(@Query() query: unknown): Promise<{ readonly data: readonly StockResponse[] }> {
    const parsed = stockQuerySchema.parse(query);
    const rows = await this.inventory.stock({
      ...(parsed.hubId === undefined ? {} : { hubId: parsed.hubId }),
      ...(parsed.lowOnly === undefined ? {} : { lowOnly: parsed.lowOnly }),
    });
    return { data: rows.map(toStock) };
  }

  /** How many shelves need reordering, for the badge. */
  @Get("stock/low-count")
  @RequirePermissions("inventory:read")
  async lowCount(): Promise<{ readonly low: number }> {
    return { low: await this.inventory.lowStockCount() };
  }

  // ── Movements ──────────────────────────────────────────────────────────────

  @Post("movements")
  @RequirePermissions("inventory:manage")
  @HttpCode(HttpStatus.CREATED)
  async record(
    @Body(zodBody(recordMovementSchema)) body: z.infer<typeof recordMovementSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MovementResponse> {
    return toMovement(await this.inventory.record(body, principal.userId));
  }

  /** Both legs, or neither — stock must never vanish in transit. */
  @Post("transfers")
  @RequirePermissions("inventory:manage")
  @HttpCode(HttpStatus.CREATED)
  async transfer(
    @Body(zodBody(transferSchema)) body: z.infer<typeof transferSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly data: readonly MovementResponse[] }> {
    return { data: (await this.inventory.transfer(body, principal.userId)).map(toMovement) };
  }

  @Get("movements")
  @RequirePermissions("inventory:read")
  async listMovements(@Query() query: unknown): Promise<PageResponse<MovementResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.inventory.listMovements({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.hubId === undefined ? {} : { hubId: parsed.hubId }),
      ...(parsed.itemId === undefined ? {} : { itemId: parsed.itemId }),
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    });
    return {
      data: page.items.map(toMovement),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }
}

function toItem(item: InventoryItem): ItemResponse {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    nameAr: item.nameAr,
    unit: item.unit,
    reorderLevel: item.reorderLevel,
    active: item.active,
  };
}

function toMovement(movement: InventoryMovement): MovementResponse {
  return {
    id: movement.id,
    itemId: movement.itemId,
    hubId: movement.hubId,
    direction: movement.direction,
    quantity: movement.quantity,
    reason: movement.reason,
    counterpartHubId: movement.counterpartHubId,
    note: movement.note,
    recordedByUserId: movement.recordedByUserId,
    occurredAt: movement.occurredAt.toISOString(),
  };
}

function toStock(row: StockRow): StockResponse {
  return {
    hubId: row.hubId,
    itemId: row.itemId,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    quantity: row.quantity,
    reorderLevel: row.reorderLevel,
    low: row.low,
  };
}
