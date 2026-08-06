import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { PickupService } from "../application/pickup.service.js";
import type { BatchScanResult, ScanSummary } from "../application/pickup.service.js";
import {
  acceptPickupRequestSchema,
  assignPickupRequestSchema,
  batchScanPickupSchema,
  cancelPickupRequestSchema,
  claimPickupRequestSchema,
  collectPickupRequestSchema,
  completePickupRequestSchema,
  createPickupRequestSchema,
  scanPickupSchema,
} from "../domain/dtos.js";
import type { PickupRequest } from "../domain/schema.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  merchantId: z.string().min(1).optional(),
  driverId: z.string().min(1).optional(),
});

const windowQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  status: z.string().min(1).optional(),
});

interface PickupResponse {
  readonly id: string;
  readonly code: string;
  readonly merchantId: string;
  readonly status: string;
  readonly pickupAddressId: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly requestedWindowFrom: string;
  readonly requestedWindowTo: string;
  readonly estimatedParcelCount: number;
  readonly actualParcelCount: number | null;
  readonly countVariance: number | null;
  readonly selectionMode: string;
  readonly outcomeReason: string | null;
  readonly requestedAt: string;
  readonly requestedByUserId: string;
  readonly acceptedAt: string | null;
  readonly acceptedByUserId: string | null;
  readonly assignedDriverId: string | null;
  readonly assignedRouteStopId: string | null;
  readonly assignedAt: string | null;
  readonly collectedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

interface PickupShipmentResponse {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  /** Device clock — when the driver physically scanned the parcel. */
  readonly scannedAt: string | null;
  /** Server clock — when the scan reached us. Later than `scannedAt` offline. */
  readonly recordedAt: string | null;
  readonly scannedByDriverId: string | null;
}

interface ManifestResponse {
  readonly data: readonly PickupShipmentResponse[];
  readonly summary: ScanSummary;
}

interface ScanResponse {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  readonly scannedAt: string;
  readonly summary: ScanSummary;
}

@Controller("v1/pickups")
export class PickupController {
  constructor(private readonly pickups: PickupService) {}

  @Post()
  @RequirePermissions("pickup:create")
  async request(
    @Body(zodBody(createPickupRequestSchema)) body: z.infer<typeof createPickupRequestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PickupResponse> {
    const result = await this.pickups.request(body, { actorId: principal.userId });
    return toResponse(result);
  }

  @Get("by-window")
  @RequirePermissions("pickup:read")
  async listByWindow(@Query() query: unknown): Promise<{ data: readonly PickupResponse[] }> {
    const { from, to, status } = windowQuerySchema.parse(query);
    const items = await this.pickups.listByWindow(from, to, status);
    return { data: items.map(toResponse) };
  }

  @Get("by-code/:code")
  @RequirePermissions("pickup:read")
  async getByCode(@Param("code") code: string): Promise<PickupResponse> {
    const result = await this.pickups.getByCode(code);
    return toResponse(result);
  }

  @Get()
  @RequirePermissions("pickup:read")
  async list(@Query() query: unknown): Promise<PageResponse<PickupResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.pickups.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.merchantId === undefined ? {} : { merchantId: parsed.merchantId }),
      ...(parsed.driverId === undefined ? {} : { driverId: parsed.driverId }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /** The pickup manifest the driver app reconciles against. */
  @Get(":id/shipments")
  @RequirePermissions("pickup:read")
  async listShipments(@Param("id") id: string): Promise<ManifestResponse> {
    const manifest = await this.pickups.getManifest(id);
    return {
      data: manifest.shipments.map((s) => ({
        shipmentId: s.shipmentId,
        trackingNumber: s.trackingNumber,
        scanStatus: s.scanStatus,
        scannedAt: s.scannedAt?.toISOString() ?? null,
        recordedAt: s.recordedAt?.toISOString() ?? null,
        scannedByDriverId: s.scannedByDriverId,
      })),
      summary: manifest.summary,
    };
  }

  @Get(":id")
  @RequirePermissions("pickup:read")
  async getById(@Param("id") id: string): Promise<PickupResponse> {
    const result = await this.pickups.getById(id);
    return toResponse(result);
  }

  @Post(":id/accept")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:accept")
  async accept(
    @Param("id") id: string,
    @Body(zodBody(acceptPickupRequestSchema)) body: z.infer<typeof acceptPickupRequestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PickupResponse> {
    const result = await this.pickups.accept(id, body, { actorId: principal.userId });
    return toResponse(result);
  }

  @Post(":id/assign")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:assign")
  async assign(
    @Param("id") id: string,
    @Body(zodBody(assignPickupRequestSchema)) body: z.infer<typeof assignPickupRequestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PickupResponse> {
    const result = await this.pickups.assign(id, body, { actorId: principal.userId });
    return toResponse(result);
  }

  /**
   * The caller takes this collection run themselves.
   *
   * Separate from `:id/assign` so a COMMERCIAL never needs `pickup:assign`.
   * The collector is taken from the authenticated principal, never the body —
   * there is no field here that could name someone else.
   */
  @Post(":id/claim")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:claim")
  async claim(
    @Param("id") id: string,
    @Body(zodBody(claimPickupRequestSchema)) body: z.infer<typeof claimPickupRequestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PickupResponse> {
    const result = await this.pickups.claim(id, body, { actorId: principal.userId });
    return toResponse(result);
  }

  /**
   * Offline batch sync. Declared before `:id/scan` so the more specific route
   * is registered first, and never all-or-nothing: every queued scan gets its
   * own verdict + client action (docs/05-api-contracts.md driver sync contract).
   */
  @Post(":id/scan/batch")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:collect")
  async scanBatch(
    @Param("id") id: string,
    @Body(zodBody(batchScanPickupSchema)) body: z.infer<typeof batchScanPickupSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BatchScanResult> {
    return this.pickups.scanBatch(id, body, { actorId: principal.userId });
  }

  @Post(":id/scan")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:collect")
  async scan(
    @Param("id") id: string,
    @Body(zodBody(scanPickupSchema)) body: z.infer<typeof scanPickupSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ScanResponse> {
    const result = await this.pickups.scan(id, body, { actorId: principal.userId });
    return {
      shipmentId: result.shipmentId,
      trackingNumber: result.trackingNumber,
      scanStatus: result.scanStatus,
      scannedAt: result.scannedAt.toISOString(),
      summary: result.summary,
    };
  }

  @Post(":id/collect")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:collect")
  async collect(
    @Param("id") id: string,
    @Body(zodBody(collectPickupRequestSchema)) body: z.infer<typeof collectPickupRequestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PickupResponse> {
    const result = await this.pickups.collect(id, body, { actorId: principal.userId });
    return toResponse(result);
  }

  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:collect")
  async complete(
    @Param("id") id: string,
    @Body(zodBody(completePickupRequestSchema)) body: z.infer<typeof completePickupRequestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PickupResponse> {
    const result = await this.pickups.complete(id, body, { actorId: principal.userId });
    return toResponse(result);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("pickup:accept")
  async cancel(
    @Param("id") id: string,
    @Body(zodBody(cancelPickupRequestSchema)) body: z.infer<typeof cancelPickupRequestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PickupResponse> {
    const result = await this.pickups.cancel(id, body, { actorId: principal.userId });
    return toResponse(result);
  }
}

function toResponse(p: PickupRequest): PickupResponse {
  const countVariance =
    p.actualParcelCount !== null ? p.estimatedParcelCount - p.actualParcelCount : null;

  return {
    id: p.id,
    code: p.code,
    merchantId: p.merchantId,
    status: p.status,
    pickupAddressId: p.pickupAddressId,
    contactName: p.contactName,
    contactPhone: p.contactPhone,
    requestedWindowFrom: p.requestedWindowFrom.toISOString(),
    requestedWindowTo: p.requestedWindowTo.toISOString(),
    estimatedParcelCount: p.estimatedParcelCount,
    actualParcelCount: p.actualParcelCount,
    countVariance,
    selectionMode: p.selectionMode,
    outcomeReason: p.outcomeReason,
    requestedAt: p.requestedAt.toISOString(),
    requestedByUserId: p.requestedByUserId,
    acceptedAt: p.acceptedAt?.toISOString() ?? null,
    acceptedByUserId: p.acceptedByUserId,
    assignedDriverId: p.assignedDriverId,
    assignedRouteStopId: p.assignedRouteStopId,
    assignedAt: p.assignedAt?.toISOString() ?? null,
    collectedAt: p.collectedAt?.toISOString() ?? null,
    completedAt: p.completedAt?.toISOString() ?? null,
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    cancellationReason: p.cancellationReason,
    notes: p.notes,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
