import { z } from "zod";

import { MANIFEST_TYPES } from "./manifest-status.js";

/**
 * Validated input contracts for the custody module (docs/02-domain-model.md §3.11).
 *
 * Strict schemas — unknown keys are rejected, not silently stripped.
 *
 * The scan-item shape duplicates the pickup module's rather than importing it.
 * That is deliberate and matches the note in `shipment/domain/dtos.ts`: each
 * module owns its own input contract, and `custody` may not depend on `pickup`
 * (docs/04-context-map.md §3.8). The wire shape stays identical so the driver
 * app speaks one scanning vocabulary; the schemas are simply not shared.
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);
const idempotencyKey = nonEmpty("idempotencyKey").max(200);
const trackingNumber = z.string().trim().min(1).max(100);

export const openManifestSchema = z.strictObject({
  idempotencyKey,
  type: z.enum(MANIFEST_TYPES),
  fromHubId: z.uuid().optional(),
  toHubId: z.uuid().optional(),
  fromDriverId: z.uuid().optional(),
  toDriverId: z.uuid().optional(),
  vehicleId: z.uuid().optional(),
});
export type OpenManifestInput = z.infer<typeof openManifestSchema>;

export const addManifestItemSchema = z.strictObject({
  idempotencyKey,
  shipmentId: z.uuid(),
});
export type AddManifestItemInput = z.infer<typeof addManifestItemSchema>;

export const sealManifestSchema = z.strictObject({
  idempotencyKey,
});
export type SealManifestInput = z.infer<typeof sealManifestSchema>;

export const dispatchManifestSchema = z.strictObject({
  idempotencyKey,
  vehicleId: z.uuid().optional(),
  driverId: z.uuid().optional(),
});
export type DispatchManifestInput = z.infer<typeof dispatchManifestSchema>;

/** Online single scan — the operator is connected, so `scannedAt` may be omitted. */
export const receiveScanSchema = z.strictObject({
  idempotencyKey,
  trackingNumber,
  scannedAt: z.coerce.date().optional(),
});
export type ReceiveScanInput = z.infer<typeof receiveScanSchema>;

/**
 * One queued offline scan. `scannedAt` is REQUIRED here: the device clock is the
 * only truthful record of when the parcel was physically handled, and the sync
 * may land hours later.
 */
const scanItemSchema = z.strictObject({
  idempotencyKey,
  trackingNumber,
  scannedAt: z.coerce.date(),
});

export const receiveScanBatchSchema = z.strictObject({
  scans: z.array(scanItemSchema).min(1).max(200),
});
export type ReceiveScanBatchInput = z.infer<typeof receiveScanBatchSchema>;

export const finaliseReceiptSchema = z.strictObject({
  idempotencyKey,
});
export type FinaliseReceiptInput = z.infer<typeof finaliseReceiptSchema>;

export const resolveDiscrepancySchema = z.strictObject({
  idempotencyKey,
  trackingNumber,
  reason: nonEmpty("reason").max(1000),
});
export type ResolveDiscrepancyInput = z.infer<typeof resolveDiscrepancySchema>;

/** Hub inbound scan — a driver handing parcels in without a manifest. */
export const hubInboundScanSchema = z.strictObject({
  idempotencyKey,
  trackingNumber,
  scannedAt: z.coerce.date().optional(),
});
export type HubInboundScanInput = z.infer<typeof hubInboundScanSchema>;

export const hubInboundScanBatchSchema = z.strictObject({
  scans: z.array(scanItemSchema).min(1).max(200),
});
export type HubInboundScanBatchInput = z.infer<typeof hubInboundScanBatchSchema>;

export const listManifestsSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(["OPEN", "SEALED", "IN_TRANSIT", "RECEIVED", "RECONCILED"]).optional(),
  type: z.enum(MANIFEST_TYPES).optional(),
  fromHubId: z.uuid().optional(),
  toHubId: z.uuid().optional(),
});
export type ListManifestsInput = z.infer<typeof listManifestsSchema>;
