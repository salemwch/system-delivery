import { z } from "zod";

/**
 * Validated input contracts for the dispatch module (docs/05-api-contracts.md §4).
 *
 * Strict object schemas; unknown keys rejected. The authenticated actor is never
 * taken from the body — it arrives in the command context, exactly as in the
 * shipment module dispatch composes.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "must be an ISO date, YYYY-MM-DD");

export const createRouteSchema = z.strictObject({
  plannedDate: isoDate,
  driverId: z.uuid().optional(),
  vehicleId: z.uuid().optional(),
  startHubId: z.uuid().optional(),
  endHubId: z.uuid().optional(),
  plannedStartAt: z.coerce.date().optional(),
});
export type CreateRouteInput = z.infer<typeof createRouteSchema>;

export const addStopsSchema = z.strictObject({
  /** Shipment legs to plan onto this route. Legs sharing a target merge into one stop. */
  legIds: z.array(z.uuid()).min(1, "at least one legId is required"),
});
export type AddStopsInput = z.infer<typeof addStopsSchema>;

export const removeStopsSchema = z.strictObject({
  stopIds: z.array(z.uuid()).min(1, "at least one stopId is required"),
});
export type RemoveStopsInput = z.infer<typeof removeStopsSchema>;

export const cancelRouteSchema = z.strictObject({
  reason: nonEmpty("reason").max(500),
});
export type CancelRouteInput = z.infer<typeof cancelRouteSchema>;

export const listRoutesSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z
    .enum(["DRAFT", "OPTIMIZING", "PUBLISHED", "IN_PROGRESS", "COMPLETED", "CANCELLED"])
    .optional(),
  driverId: z.uuid().optional(),
  plannedDate: isoDate.optional(),
});
export type ListRoutesInput = z.infer<typeof listRoutesSchema>;

export const suggestDriversSchema = z.strictObject({
  legId: z.uuid(),
  at: z.coerce.date().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type SuggestDriversInput = z.infer<typeof suggestDriversSchema>;
