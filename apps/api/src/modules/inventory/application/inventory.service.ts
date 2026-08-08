import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  createItemSchema,
  listMovementsSchema,
  recordMovementSchema,
  stockQuerySchema,
  transferSchema,
  updateItemSchema,
} from "../domain/dtos.js";
import { inventoryItems, inventoryLevels, inventoryMovements } from "../domain/schema.js";
import type { InventoryItem, InventoryMovement } from "../domain/schema.js";

/** One item's stock at one hub, with enough context to act on it. */
export interface StockRow {
  readonly hubId: string;
  readonly itemId: string;
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  readonly quantity: number;
  readonly reorderLevel: number | null;
  /** True when the shelf has fallen to or below the reorder point. */
  readonly low: boolean;
}

export interface MovementPage {
  readonly items: readonly InventoryMovement[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Gestion de stock — the consumables a hub needs to operate.
 *
 * ⚠️ NOT PARCELS. A parcel's location is the custody chain; a second answer
 * would immediately disagree with the first. This is label rolls, tape, bags —
 * the things a courier runs out of on a Saturday, after which it cannot
 * dispatch.
 *
 * The movement log is the truth and the level is `SUM(movements)`, read from a
 * view. There is no counter column to drift, which means there is never a
 * question about whether the shelf or the number is wrong.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly database: DatabaseService) {}

  // ── Items ──────────────────────────────────────────────────────────────────

  async createItem(input: unknown): Promise<InventoryItem> {
    const dto = parseWithZod(createItemSchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const inserted = await tx
          .insert(inventoryItems)
          .values({
            tenantId,
            sku: dto.sku.toUpperCase(),
            name: dto.name,
            ...(dto.nameAr === undefined ? {} : { nameAr: dto.nameAr }),
            ...(dto.unit === undefined ? {} : { unit: dto.unit }),
            ...(dto.reorderLevel === undefined ? {} : { reorderLevel: dto.reorderLevel }),
          })
          .returning();
        return requireRow(inserted, "Inventory item insert returned no row");
      });
    } catch (error) {
      if (isUniqueViolation(error, "inventory_items_sku_uq")) {
        throw new ConflictError("ITEM_SKU_TAKEN", `SKU "${dto.sku}" is already in use.`);
      }
      throw error;
    }
  }

  async updateItem(id: string, input: unknown): Promise<InventoryItem> {
    const dto = parseWithZod(updateItemSchema, input);

    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(inventoryItems)
        .set({
          updatedAt: sql`now()`,
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.nameAr === undefined ? {} : { nameAr: dto.nameAr }),
          ...(dto.unit === undefined ? {} : { unit: dto.unit }),
          ...(dto.reorderLevel === undefined ? {} : { reorderLevel: dto.reorderLevel }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
        })
        .where(eq(inventoryItems.id, id))
        .returning();
      return requireRow(updated, "Inventory item");
    });
  }

  async listItems(activeOnly = false): Promise<readonly InventoryItem[]> {
    return this.database.withTenant((tx) =>
      tx
        .select()
        .from(inventoryItems)
        .where(activeOnly ? eq(inventoryItems.active, true) : undefined)
        .orderBy(asc(inventoryItems.sku)),
    );
  }

  // ── Movements ──────────────────────────────────────────────────────────────

  /**
   * Records stock arriving at or leaving one hub.
   *
   * ⚠️ AN `OUT` MOVEMENT IS REFUSED IF IT WOULD DRIVE THE SHELF NEGATIVE. Not
   * because negative stock breaks anything technically, but because it is always
   * a data-entry error — you cannot consume tape you do not have — and letting it
   * through means the real error (a missed receipt) is never found.
   *
   * STOCKTAKE is the exception: a count that comes up short IS the correction,
   * and refusing it would leave the book permanently wrong.
   */
  async record(input: unknown, actorUserId: string): Promise<InventoryMovement> {
    const dto = parseWithZod(recordMovementSchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();

        if (dto.direction === "OUT" && dto.reason !== "STOCKTAKE") {
          await this.assertSufficient(tx, dto.hubId, dto.itemId, dto.quantity);
        }

        const inserted = await tx
          .insert(inventoryMovements)
          .values({
            tenantId,
            itemId: dto.itemId,
            hubId: dto.hubId,
            direction: dto.direction,
            quantity: dto.quantity,
            reason: dto.reason,
            recordedByUserId: actorUserId,
            idempotencyKey: dto.idempotencyKey,
            ...(dto.note === undefined ? {} : { note: dto.note }),
            ...(dto.occurredAt === undefined ? {} : { occurredAt: dto.occurredAt }),
          })
          .returning();

        return requireRow(inserted, "Movement insert returned no row");
      });
    } catch (error) {
      // A storeman on a bad connection taps "receive" twice; the shelf must not
      // gain stock that never arrived. Returning the original is the honest
      // answer — the caller's intent was satisfied.
      if (isUniqueViolation(error, "inventory_movements_idempotency_uq")) {
        const existing = await this.findByIdempotencyKey(dto.idempotencyKey);
        if (existing !== null) {
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Moves stock between two hubs.
   *
   * ⚠️ BOTH LEGS IN ONE TRANSACTION, or neither. A caller that could post the
   * OUT alone would make stock vanish in transit — visible as one hub short and
   * nothing anywhere to explain it.
   *
   * The two rows share nothing but their reason and their counterpart pointers;
   * they carry DIFFERENT idempotency keys because the unique index is per row,
   * and the caller's key seeds both deterministically so a retry still collides.
   */
  async transfer(input: unknown, actorUserId: string): Promise<readonly InventoryMovement[]> {
    const dto = parseWithZod(transferSchema, input);

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        await this.assertSufficient(tx, dto.fromHubId, dto.itemId, dto.quantity);

        const common = {
          tenantId,
          itemId: dto.itemId,
          quantity: dto.quantity,
          reason: "TRANSFER" as const,
          recordedByUserId: actorUserId,
          ...(dto.note === undefined ? {} : { note: dto.note }),
        };

        return tx
          .insert(inventoryMovements)
          .values([
            {
              ...common,
              hubId: dto.fromHubId,
              counterpartHubId: dto.toHubId,
              direction: "OUT",
              idempotencyKey: `${dto.idempotencyKey}:out`,
            },
            {
              ...common,
              hubId: dto.toHubId,
              counterpartHubId: dto.fromHubId,
              direction: "IN",
              idempotencyKey: `${dto.idempotencyKey}:in`,
            },
          ])
          .returning();
      });
    } catch (error) {
      if (isUniqueViolation(error, "inventory_movements_idempotency_uq")) {
        const out = await this.findByIdempotencyKey(`${dto.idempotencyKey}:out`);
        const incoming = await this.findByIdempotencyKey(`${dto.idempotencyKey}:in`);
        if (out !== null && incoming !== null) {
          return [out, incoming];
        }
      }
      throw error;
    }
  }

  async listMovements(input: unknown = {}): Promise<MovementPage> {
    const dto = parseWithZod(listMovementsSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;

    return this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        ...(dto.hubId === undefined ? [] : [eq(inventoryMovements.hubId, dto.hubId)]),
        ...(dto.itemId === undefined ? [] : [eq(inventoryMovements.itemId, dto.itemId)]),
        ...(dto.reason === undefined ? [] : [eq(inventoryMovements.reason, dto.reason)]),
        ...(dto.cursor === undefined ? [] : [lt(inventoryMovements.id, dto.cursor)]),
      ];

      const rows = await tx
        .select()
        .from(inventoryMovements)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(inventoryMovements.id))
        .limit(limit + 1);

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /**
   * What is on the shelves, joined to the item so the answer is readable.
   *
   * Only items with movements appear: a SKU nobody has ever received has no
   * stock row, which is correct — its level is not "zero", it is "never stocked
   * here", and inventing a zero would put every SKU on every hub's screen.
   */
  async stock(input: unknown = {}): Promise<readonly StockRow[]> {
    const dto = parseWithZod(stockQuerySchema, input);

    return this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        ...(dto.hubId === undefined ? [] : [eq(inventoryLevels.hubId, dto.hubId)]),
        // ⚠️ `lte` against a NULL reorder level yields NULL, which filters the
        // row out — exactly right, since NULL means "never warn". The
        // `isNotNull` is therefore redundant for correctness and present for
        // the reader and the planner.
        ...(dto.lowOnly === true
          ? [
              isNotNull(inventoryItems.reorderLevel),
              lte(inventoryLevels.quantity, inventoryItems.reorderLevel),
            ]
          : []),
      ];

      const rows = await tx
        .select({
          hubId: inventoryLevels.hubId,
          itemId: inventoryLevels.itemId,
          sku: inventoryItems.sku,
          name: inventoryItems.name,
          unit: inventoryItems.unit,
          quantity: inventoryLevels.quantity,
          reorderLevel: inventoryItems.reorderLevel,
        })
        .from(inventoryLevels)
        .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLevels.itemId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(inventoryItems.sku));

      return rows.map((row) => ({
        ...row,
        low: row.reorderLevel !== null && row.quantity <= row.reorderLevel,
      }));
    });
  }

  /** How many shelves are at or below their reorder point, for the badge. */
  async lowStockCount(): Promise<number> {
    return (await this.stock({ lowOnly: true })).length;
  }

  /**
   * Refuses a movement that would drive the shelf negative.
   *
   * Reading the level and then inserting is a read-modify-write, and two
   * concurrent consumptions could both pass. That is accepted deliberately: the
   * outcome is a shelf slightly negative, which the next stocktake corrects,
   * whereas locking every movement of an item would serialise the busiest hub's
   * label-roll consumption for no real gain. The check exists to catch the
   * TYPO — 500 instead of 50 — not to be a concurrency barrier.
   */
  private async assertSufficient(
    tx: TenantTransaction,
    hubId: string,
    itemId: string,
    quantity: number,
  ): Promise<void> {
    const rows = await tx
      .select({ quantity: inventoryLevels.quantity })
      .from(inventoryLevels)
      .where(and(eq(inventoryLevels.hubId, hubId), eq(inventoryLevels.itemId, itemId)))
      .limit(1);

    const onHand = rows[0]?.quantity ?? 0;
    if (onHand < quantity) {
      throw new BusinessRuleError(
        "INSUFFICIENT_STOCK",
        `Only ${String(onHand)} on hand at this hub; cannot remove ${String(quantity)}.`,
      );
    }
  }

  private async findByIdempotencyKey(key: string): Promise<InventoryMovement | null> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.idempotencyKey, key))
        .limit(1);
      return rows[0] ?? null;
    });
  }
}

function requireRow<T>(rows: readonly T[], message: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new NotFoundError(message);
  }
  return row;
}
