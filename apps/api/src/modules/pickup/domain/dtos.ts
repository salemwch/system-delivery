import { z } from "zod";

/**
 * Validated input contracts for the pickup module (docs/02-domain-model.md §3.18).
 *
 * Strict schemas — unknown keys are rejected, not silently stripped.
 */

const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/u, "must be an E.164 phone number, e.g. +21620123456");

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

/**
 * How the shipments attached to a pickup were chosen.
 *
 * EXPLICIT       — the merchant named the shipment ids.
 * MERCHANT_READY — the system selected every pickup-eligible shipment for the
 *                  merchant at request time.
 */
export const SELECTION_MODES = ["EXPLICIT", "MERCHANT_READY"] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

/**
 * Why a pickup yielded fewer parcels than expected — mandatory when it yielded
 * none at all (docs/02-domain-model.md §3.18 rule 5: the trip still cost money
 * and must stay reportable).
 */
export const OUTCOME_REASONS = [
  "MERCHANT_NOT_READY",
  "NO_PARCELS_AVAILABLE",
  "MERCHANT_CANCELLED",
  "ADDRESS_ISSUE",
  "DRIVER_FAILED",
] as const;
export type OutcomeReason = (typeof OUTCOME_REASONS)[number];

export const createPickupRequestSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
  merchantId: z.uuid(),
  pickupAddressId: z.uuid(),
  contactName: nonEmpty("contactName").max(200),
  contactPhone: e164,
  requestedWindowFrom: z.coerce.date(),
  requestedWindowTo: z.coerce.date(),
  shipmentIds: z.array(z.uuid()).min(1).max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CreatePickupRequestInput = z.infer<typeof createPickupRequestSchema>;

export const acceptPickupRequestSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
});
export type AcceptPickupRequestInput = z.infer<typeof acceptPickupRequestSchema>;

export const assignPickupRequestSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
  driverId: z.uuid(),
  routeStopId: z.uuid().optional(),
});
export type AssignPickupRequestInput = z.infer<typeof assignPickupRequestSchema>;

/**
 * Taking a collection run for ONESELF (`pickup:claim`).
 *
 * The absence of `driverId` is the entire point. `assign` names whoever should
 * go, and therefore lets its holder route work to any driver in the tenant;
 * `claim` can only ever name the caller. A COMMERCIAL can pick up their own
 * portfolio's parcels without also gaining the ability to dispatch the fleet —
 * which is what makes this safe to hand to a field salesperson at a courier
 * with hundreds of drivers.
 */
export const claimPickupRequestSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
});

export const collectPickupRequestSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
  outcomeReason: z.enum(OUTCOME_REASONS).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type CollectPickupRequestInput = z.infer<typeof collectPickupRequestSchema>;

export const completePickupRequestSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
});
export type CompletePickupRequestInput = z.infer<typeof completePickupRequestSchema>;

export const cancelPickupRequestSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
  reason: nonEmpty("reason").max(500),
});
export type CancelPickupRequestInput = z.infer<typeof cancelPickupRequestSchema>;

export const scanPickupSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
  trackingNumber: z.string().trim().min(1).max(100),
  scannedAt: z.coerce.date().optional(),
});
export type ScanPickupInput = z.infer<typeof scanPickupSchema>;

/**
 * One queued offline scan. `scannedAt` is REQUIRED here (unlike the online
 * single-scan schema): the device time is the only truthful record of when the
 * parcel was physically handled, and it may be hours before the sync lands.
 */
const scanItemSchema = z.strictObject({
  idempotencyKey: nonEmpty("idempotencyKey").max(200),
  trackingNumber: z.string().trim().min(1).max(100),
  scannedAt: z.coerce.date(),
});

export const batchScanPickupSchema = z.strictObject({
  scans: z.array(scanItemSchema).min(1).max(200),
});
export type BatchScanPickupInput = z.infer<typeof batchScanPickupSchema>;
