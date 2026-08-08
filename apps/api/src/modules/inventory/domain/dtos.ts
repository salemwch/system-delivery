import { z } from "zod";

/**
 * Validated input contracts for gestion de stock.
 *
 * ⚠️ Quantities are ALWAYS POSITIVE. The direction carries the sign, exactly as
 * in the ledger — signed quantities plus a direction column produce
 * double-negative bugs that stay invisible until a stocktake.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

export const ITEM_UNITS = ["UNIT", "ROLL", "BOX", "METRE", "LITRE"] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

export const MOVEMENT_REASONS = [
  "RECEIPT",
  "CONSUMPTION",
  "TRANSFER",
  "STOCKTAKE",
  "DAMAGE",
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

export const createItemSchema = z.strictObject({
  sku: nonEmpty("sku").max(50),
  name: nonEmpty("name").max(200),
  nameAr: nonEmpty("nameAr").max(200).optional(),
  unit: z.enum(ITEM_UNITS).optional(),
  reorderLevel: z.number().int().min(0).max(1_000_000).optional(),
});
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = z
  .strictObject({
    name: nonEmpty("name").max(200).optional(),
    nameAr: nonEmpty("nameAr").max(200).nullable().optional(),
    unit: z.enum(ITEM_UNITS).optional(),
    reorderLevel: z.number().int().min(0).max(1_000_000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

/**
 * Stock arriving or leaving one hub.
 *
 * TRANSFER is deliberately NOT accepted here — it moves stock between two hubs
 * and must write both sides in one transaction, so it has its own command. A
 * caller that could post one leg alone would make stock vanish in transit.
 */
export const recordMovementSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  itemId: z.uuid(),
  hubId: z.uuid(),
  direction: z.enum(["IN", "OUT"]),
  quantity: z.number().int().positive().max(1_000_000),
  reason: z.enum(["RECEIPT", "CONSUMPTION", "STOCKTAKE", "DAMAGE"]),
  note: nonEmpty("note").max(500).optional(),
  occurredAt: z.coerce.date().optional(),
});
export type RecordMovementInput = z.infer<typeof recordMovementSchema>;

/** Moving stock between two hubs. Writes both legs, or neither. */
export const transferSchema = z
  .strictObject({
    idempotencyKey: z.uuid(),
    itemId: z.uuid(),
    fromHubId: z.uuid(),
    toHubId: z.uuid(),
    quantity: z.number().int().positive().max(1_000_000),
    note: nonEmpty("note").max(500).optional(),
  })
  .refine((value) => value.fromHubId !== value.toHubId, {
    message: "a transfer needs two different hubs",
    path: ["toHubId"],
  });
export type TransferInput = z.infer<typeof transferSchema>;

export const listMovementsSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  hubId: z.uuid().optional(),
  itemId: z.uuid().optional(),
  reason: z.enum(MOVEMENT_REASONS).optional(),
});
export type ListMovementsInput = z.infer<typeof listMovementsSchema>;

export const stockQuerySchema = z.strictObject({
  hubId: z.uuid().optional(),
  /** Only what has fallen to or below its reorder level. */
  lowOnly: z.boolean().optional(),
});
export type StockQueryInput = z.infer<typeof stockQuerySchema>;
