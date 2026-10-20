import { z } from "zod";

import type { ApiClient } from "./api";
import { scanBatchResponseSchema, syncResponseSchema } from "./outbox";
import type { MediaItem, MediaSlot, OutboxPorts, ScanBatchResponse, SyncResponse } from "./outbox";

/**
 * The field-work calls (docs/05): the day's configuration, pickups, cash,
 * problems, POD media and the sync itself. Every answer is checked against
 * its schema before the app acts on it.
 */

const id = (value: string) => encodeURIComponent(value);

// ── Configuration ───────────────────────────────────────────────────────────

export const bootstrapSchema = z
  .object({
    features: z.record(z.string(), z.boolean()),
    failureReasons: z.array(
      z
        .object({
          code: z.string(),
          labels: z.record(z.string(), z.string()),
          allowsReattempt: z.boolean(),
        })
        .loose(),
    ),
    currency: z.object({ code: z.string(), exponent: z.number().int() }).loose(),
    timezone: z.string(),
  })
  .loose();
export type Bootstrap = z.infer<typeof bootstrapSchema>;

export function bootstrap(api: ApiClient): Promise<Bootstrap> {
  return api.request("GET", "/v1/config/bootstrap", bootstrapSchema);
}

// ── Routes ──────────────────────────────────────────────────────────────────

const routeStateSchema = z.object({ id: z.uuid(), status: z.string() }).loose();

/** Starting the route is what takes the loaded parcels out for delivery. */
export function startRoute(api: ApiClient, routeId: string) {
  return api.request("POST", `/v1/drivers/me/routes/${id(routeId)}/start`, routeStateSchema, {});
}

export function completeRoute(api: ApiClient, routeId: string) {
  return api.request("POST", `/v1/drivers/me/routes/${id(routeId)}/complete`, routeStateSchema, {});
}

// ── Shipment detail and the driver's record ─────────────────────────────────

const shipmentSchema = z
  .object({
    id: z.uuid(),
    trackingNumber: z.string(),
    status: z.string(),
    senderName: z.string(),
    recipientName: z.string(),
    recipientPhone: z.string(),
    recipientPhoneAlt: z.string().nullable(),
    destinationAddressId: z.uuid(),
    parcelCount: z.number().int(),
    weightGrams: z.number(),
    attemptCount: z.number().int(),
    maxAttempts: z.number().int(),
    codAmountMinor: z.string(),
    currency: z.string(),
    currencyExponent: z.number().int(),
  })
  .loose();
export type ShipmentDetail = z.infer<typeof shipmentSchema>;

export function shipment(api: ApiClient, shipmentId: string): Promise<ShipmentDetail> {
  return api.request("GET", `/v1/shipments/${id(shipmentId)}`, shipmentSchema);
}

const statsSchema = z
  .object({
    totalDeliveries: z.number(),
    totalFailures: z.number(),
    deliveryRate: z.number(),
    onTimeRate: z.number().nullable(),
    codCollectedMinor: z.string(),
    currency: z.string(),
    currencyExponent: z.number().int(),
  })
  .loose();
export type DriverStats = z.infer<typeof statsSchema>;

export function driverStats(api: ApiClient, driverId: string): Promise<DriverStats> {
  return api.request("GET", `/v1/shipments/driver/${id(driverId)}/stats`, statsSchema);
}

// ── Pickups ─────────────────────────────────────────────────────────────────

export const pickupSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    merchantName: z.string().nullable(),
    status: z.string(),
    pickupAddressId: z.uuid(),
    contactName: z.string(),
    contactPhone: z.string(),
    requestedWindowFrom: z.string(),
    requestedWindowTo: z.string(),
    estimatedParcelCount: z.number().int(),
    actualParcelCount: z.number().int().nullable(),
    selectionMode: z.string(),
    notes: z.string().nullable(),
    assignedRouteStopId: z.uuid().nullable(),
  })
  .loose();
export type Pickup = z.infer<typeof pickupSchema>;

const pickupPageSchema = z.object({ data: z.array(pickupSchema) }).loose();

/** The pickups assigned to this login (`assignedDriverId` holds the USER id, I27). */
export async function myPickups(api: ApiClient, userId: string): Promise<Pickup[]> {
  const page = await api.request(
    "GET",
    `/v1/pickups?driverId=${id(userId)}&limit=50`,
    pickupPageSchema,
  );
  return page.data;
}

export function pickup(api: ApiClient, pickupId: string): Promise<Pickup> {
  return api.request("GET", `/v1/pickups/${id(pickupId)}`, pickupSchema);
}

const scanSummarySchema = z.object({
  total: z.number().int(),
  scanned: z.number().int(),
  missing: z.number().int(),
});
const pickupManifestSchema = z
  .object({
    data: z.array(
      z
        .object({
          shipmentId: z.uuid(),
          trackingNumber: z.string(),
          scanStatus: z.string(),
          scannedAt: z.string().nullable(),
        })
        .loose(),
    ),
    summary: scanSummarySchema,
  })
  .loose();
export type PickupManifest = z.infer<typeof pickupManifestSchema>;

export function pickupParcels(api: ApiClient, pickupId: string): Promise<PickupManifest> {
  return api.request("GET", `/v1/pickups/${id(pickupId)}/shipments`, pickupManifestSchema);
}

// ── Cash and problems ───────────────────────────────────────────────────────

const remittanceSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    status: z.string(),
    expectedAmountMinor: z.string(),
    declaredAmountMinor: z.string(),
    currency: z.string(),
  })
  .loose();
export type Remittance = z.infer<typeof remittanceSchema>;

/**
 * Declares the cash handed over at the hub. ⚠️ The server takes no
 * idempotency key for this call, so it is NEVER retried automatically: a
 * lost answer is shown as such, and the driver checks with the hub before
 * declaring again (a second call would be a second remittance).
 */
export function submitRemittance(
  api: ApiClient,
  body: {
    readonly driverId: string;
    readonly hubId: string;
    readonly declaredAmountMinor: string;
    readonly currency: string;
    readonly shipmentIds: readonly string[];
    readonly notes?: string;
  },
): Promise<Remittance> {
  return api.request("POST", "/v1/finance/remittances", remittanceSchema, body);
}

export const PROBLEM_TYPES = ["DAMAGED", "WRONG_ITEM", "LOST", "OTHER"] as const;
export type ProblemType = (typeof PROBLEM_TYPES)[number];

const complaintSchema = z.object({ id: z.uuid(), code: z.string().optional() }).loose();

/** A problem reported from the street, about one parcel (raised by STAFF: the driver). */
export function reportProblem(
  api: ApiClient,
  body: {
    readonly idempotencyKey: string;
    readonly type: ProblemType;
    readonly description: string;
    readonly shipmentId: string;
  },
) {
  return api.request("POST", "/v1/complaints", complaintSchema, {
    ...body,
    raisedByType: "STAFF",
  });
}

// ── Sync, media and pickup replays (the outbox's ports) ────────────────────

const slotSchema = z
  .object({
    id: z.uuid(),
    objectKey: z.string(),
    uploadUrl: z.string().nullable(),
    requiredHeaders: z.record(z.string(), z.string()).nullable(),
  })
  .loose();
const anySchema = z.unknown();

export interface FileUploader {
  /** PUTs the local file to a presigned URL; throws ApiError on failure. */
  put(media: MediaItem, url: string, headers: Readonly<Record<string, string>>): Promise<void>;
  discard(media: MediaItem): Promise<void>;
}

export function outboxPorts(api: ApiClient, deviceId: string, files: FileUploader): OutboxPorts {
  return {
    async presign(media: MediaItem): Promise<MediaSlot> {
      const slot = await api.request("POST", "/v1/media/presign", slotSchema, {
        idempotencyKey: media.id,
        purpose: media.purpose,
        shipmentId: media.shipmentId,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
      });
      return {
        artifactId: slot.id,
        objectKey: slot.objectKey,
        uploadUrl: slot.uploadUrl,
        requiredHeaders: slot.requiredHeaders,
      };
    },
    upload: (media, url, headers) => files.put(media, url, headers),
    async completeMedia(artifactId: string): Promise<void> {
      await api.request("POST", `/v1/media/${id(artifactId)}/complete`, anySchema, {});
    },
    discardFile: (media) => files.discard(media),
    sync(body): Promise<SyncResponse> {
      return api.request(
        "POST",
        "/v1/drivers/me/sync",
        syncResponseSchema,
        { deviceId, ...body },
        // A hundred deliveries on a weak link: generous, still bounded.
        { timeoutMs: 45_000 },
      );
    },
    scanBatch(pickupId, scans): Promise<ScanBatchResponse> {
      return api.request(
        "POST",
        `/v1/pickups/${id(pickupId)}/scan/batch`,
        scanBatchResponseSchema,
        {
          scans,
        },
      );
    },
    async collectPickup(pickupId, body): Promise<void> {
      await api.request("POST", `/v1/pickups/${id(pickupId)}/collect`, anySchema, body);
    },
    async completePickup(pickupId, body): Promise<void> {
      await api.request("POST", `/v1/pickups/${id(pickupId)}/complete`, anySchema, body);
    },
  };
}
