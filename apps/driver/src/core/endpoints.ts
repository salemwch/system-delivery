import { z } from "zod";

import { ApiError, sessionResponseSchema } from "./api";
import type { ApiClient } from "./api";
import type { QueuedBatch, UploadOutcome, Uploader } from "./telemetry";

/**
 * The server calls the app makes, each with the schema its answer must match
 * (docs/05). A response that does not match is refused (ApiClient), never
 * half-used.
 */

const tenantSchema = z.object({ id: z.uuid(), name: z.string() }).loose();
const otpRequestSchema = z
  .object({ sent: z.literal(true), retryAfterSeconds: z.number().optional() })
  .loose();

const shiftSchema = z
  .object({
    id: z.uuid(),
    driverId: z.uuid(),
    vehicleId: z.uuid(),
    status: z.string(),
    startedAt: z.string(),
  })
  .loose();
export type ShiftView = z.infer<typeof shiftSchema>;
const currentShiftSchema = z.object({ driverId: z.uuid(), shift: shiftSchema.nullable() });
export type CurrentShift = z.infer<typeof currentShiftSchema>;

const ingestSchema = z.object({ accepted: z.number(), rejected: z.number() }).loose();

export function tenantBySlug(api: ApiClient, slug: string) {
  return api.publicRequest("GET", `/v1/tenants/by-slug/${encodeURIComponent(slug)}`, tenantSchema);
}

export function requestCode(api: ApiClient, tenantId: string, phone: string) {
  return api.publicRequest("POST", "/v1/auth/driver/otp/request", otpRequestSchema, {
    tenantId,
    phone,
  });
}

export function verifyCode(
  api: ApiClient,
  tenantId: string,
  phone: string,
  code: string,
  deviceId: string,
) {
  return api.publicRequest("POST", "/v1/auth/driver/otp/verify", sessionResponseSchema, {
    tenantId,
    phone,
    code,
    deviceId,
  });
}

export function currentShift(api: ApiClient): Promise<CurrentShift> {
  return api.request("GET", "/v1/shifts/current", currentShiftSchema);
}

export function startShift(
  api: ApiClient,
  driverId: string,
  vehicleId: string,
): Promise<ShiftView> {
  return api.request("POST", "/v1/shifts", shiftSchema, { driverId, vehicleId });
}

export function endShift(api: ApiClient, shiftId: string): Promise<ShiftView> {
  return api.request("POST", `/v1/shifts/${encodeURIComponent(shiftId)}/end`, shiftSchema, {});
}

/** Uploads one telemetry batch and classifies the answer (telemetry.ts). */
export function telemetryUploader(api: ApiClient): Uploader {
  return async (batch: QueuedBatch): Promise<UploadOutcome> => {
    try {
      const result = await api.request(
        "POST",
        "/v1/telemetry",
        ingestSchema,
        { shiftId: batch.shiftId, batchId: batch.batchId, positions: batch.positions },
        // A 1,000-point batch on a weak 3G link: generous, still bounded.
        { timeoutMs: 30_000 },
      );
      return { kind: "ACCEPTED", accepted: result.accepted, rejected: result.rejected };
    } catch (error) {
      if (!(error instanceof ApiError)) {
        return { kind: "TRANSIENT", reason: "UNEXPECTED" };
      }
      if (error.code === "TELEMETRY_OUTSIDE_SHIFT") {
        return { kind: "OUTSIDE_SHIFT" };
      }
      if (error.status === 401) {
        return { kind: "UNAUTHENTICATED" };
      }
      if (error.transient) {
        return {
          kind: "TRANSIENT",
          reason: error.code,
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        };
      }
      return { kind: "INVALID", status: error.status };
    }
  };
}
