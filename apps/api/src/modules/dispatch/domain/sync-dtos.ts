import { z } from "zod";

/**
 * The driver app's offline sync (docs/05 §5 `POST /v1/drivers/me/sync`,
 * docs/08 §8.1: "per-item results, never all-or-nothing").
 *
 * The ENVELOPE is strict and validated up front: it is the app talking. Each
 * queued ITEM is validated on its own while the batch is processed, so one
 * malformed item becomes one rejected result, not a 400 that blocks the other
 * ninety-nine.
 */

/** A batch the server answers in a few seconds even when every item is a delivery. */
const MAX_SYNC_ITEMS = 100;
/** A driver holds one or two routes a day; this bounds the version map. */
const MAX_KNOWN_ROUTES = 20;

const SYNC_ITEM_TYPES = ["DELIVERED", "FAILED", "RETURN_COMPLETED", "ADDRESS_CORRECTED"] as const;
export type SyncItemType = (typeof SYNC_ITEM_TYPES)[number];

export const driverSyncSchema = z.strictObject({
  /** Which handset: logged with the batch, so "my phone says it synced" is answerable. */
  deviceId: z.string().trim().min(1).max(128),
  /**
   * The manifest version the app holds for each route. A route whose current
   * version differs (or is missing here) comes back in full.
   */
  knownRouteVersions: z
    .record(z.uuid(), z.string().regex(/^[0-9a-f]{64}$/u))
    .refine((map) => Object.keys(map).length <= MAX_KNOWN_ROUTES, {
      message: `at most ${String(MAX_KNOWN_ROUTES)} routes`,
    })
    .optional(),
  pendingEvents: z.array(z.unknown()).max(MAX_SYNC_ITEMS).default([]),
});

/**
 * One queued action. `payload` is the body of the command it replays, minus
 * the idempotency key, which the envelope owns: the key that made the action
 * safe to retry offline is the key the command runs under.
 */
export const syncItemSchema = z
  .strictObject({
    idempotencyKey: z.string().trim().min(1).max(200),
    type: z.enum(SYNC_ITEM_TYPES),
    shipmentId: z.uuid().optional(),
    addressId: z.uuid().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((item, ctx) => {
    const needsAddress = item.type === "ADDRESS_CORRECTED";
    if (needsAddress ? item.addressId === undefined : item.shipmentId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [needsAddress ? "addressId" : "shipmentId"],
        message: "required for this type",
      });
    }
    if ((needsAddress ? item.shipmentId : item.addressId) !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [needsAddress ? "shipmentId" : "addressId"],
        message: "not allowed for this type",
      });
    }
    if ("idempotencyKey" in item.payload) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "idempotencyKey"],
        message: "the item's idempotencyKey is the command's; do not repeat it",
      });
    }
    // Device time is what SLA and plan-vs-actual are measured against
    // (docs/01 §4.7 item 7.5). A queued action without it would be recorded
    // at sync time: every offline delivery would look late.
    if (typeof item.payload["occurredAt"] !== "string") {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "occurredAt"],
        message: "required: when the action happened on the device",
      });
    }
  });
export type SyncItem = z.infer<typeof syncItemSchema>;
