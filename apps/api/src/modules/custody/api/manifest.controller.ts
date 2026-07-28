import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { HubScanService } from "../application/hub-scan.service.js";
import type { InboundBatchResult, InboundScanResult } from "../application/hub-scan.service.js";
import { ManifestService } from "../application/manifest.service.js";
import type {
  BatchScanResult,
  DiscrepancyReport,
  ReceiptSummary,
} from "../application/manifest.service.js";
import {
  addManifestItemSchema,
  dispatchManifestSchema,
  finaliseReceiptSchema,
  hubInboundScanBatchSchema,
  hubInboundScanSchema,
  openManifestSchema,
  receiveScanBatchSchema,
  receiveScanSchema,
  resolveDiscrepancySchema,
  sealManifestSchema,
} from "../domain/dtos.js";
import type { Manifest } from "../domain/schema.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  fromHubId: z.string().min(1).optional(),
  toHubId: z.string().min(1).optional(),
});

interface ManifestResponse {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly status: string;
  readonly fromHubId: string | null;
  readonly toHubId: string | null;
  readonly fromDriverId: string | null;
  readonly toDriverId: string | null;
  readonly vehicleId: string | null;
  readonly itemCount: number;
  readonly discrepancyCount: number;
  readonly sealedAt: string | null;
  readonly sealedByUserId: string | null;
  readonly dispatchedAt: string | null;
  readonly receivedAt: string | null;
  readonly receivedByUserId: string | null;
  readonly reconciledAt: string | null;
  readonly createdAt: string;
  readonly createdByUserId: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

interface ManifestItemResponse {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  /** Device clock — when the operator physically scanned the parcel. */
  readonly scannedAt: string | null;
  /** Server clock — when the scan reached us. Later than `scannedAt` offline. */
  readonly recordedAt: string | null;
  readonly scannedByUserId: string | null;
}

interface ScanResponse {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly scanStatus: string;
  readonly scannedAt: string;
  readonly summary: ReceiptSummary;
}

/**
 * Manifests and hub scanning (docs/04-context-map.md §3.8).
 *
 * Permission split follows the separation the role model already encodes:
 * `manifest:seal` builds and sends a handover, `manifest:receive` takes delivery
 * of one and resolves what went wrong. A hub operator who loads a truck is not
 * automatically the one who signs for it at the other end.
 */
@Controller("v1/manifests")
export class ManifestController {
  constructor(private readonly manifests: ManifestService) {}

  @Post()
  @RequirePermissions("manifest:seal")
  async open(
    @Body(zodBody(openManifestSchema)) body: z.infer<typeof openManifestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ManifestResponse> {
    return toResponse(await this.manifests.open(body, { actorId: principal.userId }));
  }

  @Get("by-code/:code")
  @RequirePermissions("manifest:read")
  async getByCode(@Param("code") code: string): Promise<ManifestResponse> {
    return toResponse(await this.manifests.getByCode(code));
  }

  @Get()
  @RequirePermissions("manifest:read")
  async list(@Query() query: unknown): Promise<PageResponse<ManifestResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.manifests.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.type === undefined ? {} : { type: parsed.type }),
      ...(parsed.fromHubId === undefined ? {} : { fromHubId: parsed.fromHubId }),
      ...(parsed.toHubId === undefined ? {} : { toHubId: parsed.toHubId }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id/items")
  @RequirePermissions("manifest:read")
  async items(@Param("id") id: string): Promise<{ data: readonly ManifestItemResponse[] }> {
    const items = await this.manifests.getItems(id);
    return {
      data: items.map((i) => ({
        shipmentId: i.shipmentId,
        trackingNumber: i.trackingNumber,
        scanStatus: i.scanStatus,
        scannedAt: i.scannedAt?.toISOString() ?? null,
        recordedAt: i.recordedAt?.toISOString() ?? null,
        scannedByUserId: i.scannedByUserId,
      })),
    };
  }

  @Get(":id/discrepancies")
  @RequirePermissions("manifest:read")
  async discrepancies(@Param("id") id: string): Promise<DiscrepancyReport> {
    return this.manifests.getDiscrepancies(id);
  }

  @Get(":id")
  @RequirePermissions("manifest:read")
  async getById(@Param("id") id: string): Promise<ManifestResponse> {
    return toResponse(await this.manifests.getById(id));
  }

  @Post(":id/items")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:seal")
  async addItem(
    @Param("id") id: string,
    @Body(zodBody(addManifestItemSchema)) body: z.infer<typeof addManifestItemSchema>,
  ): Promise<ManifestItemResponse> {
    const item = await this.manifests.addItem(id, body);
    return {
      shipmentId: item.shipmentId,
      trackingNumber: item.trackingNumber,
      scanStatus: item.scanStatus,
      scannedAt: null,
      recordedAt: null,
      scannedByUserId: null,
    };
  }

  @Post(":id/seal")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:seal")
  async seal(
    @Param("id") id: string,
    @Body(zodBody(sealManifestSchema)) body: z.infer<typeof sealManifestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ManifestResponse> {
    return toResponse(await this.manifests.seal(id, body, { actorId: principal.userId }));
  }

  @Post(":id/dispatch")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:seal")
  async dispatch(
    @Param("id") id: string,
    @Body(zodBody(dispatchManifestSchema)) body: z.infer<typeof dispatchManifestSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ManifestResponse> {
    return toResponse(await this.manifests.dispatch(id, body, { actorId: principal.userId }));
  }

  /**
   * Offline batch receipt. Declared before `:id/receive` so the more specific
   * route wins, and never all-or-nothing: every queued scan gets its own verdict
   * and client action (docs/05-api-contracts.md driver sync contract).
   */
  @Post(":id/receive/batch")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:receive")
  async receiveBatch(
    @Param("id") id: string,
    @Body(zodBody(receiveScanBatchSchema)) body: z.infer<typeof receiveScanBatchSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BatchScanResult> {
    return this.manifests.receiveScanBatch(id, body, { actorId: principal.userId });
  }

  @Post(":id/receive")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:receive")
  async receive(
    @Param("id") id: string,
    @Body(zodBody(receiveScanSchema)) body: z.infer<typeof receiveScanSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ScanResponse> {
    const result = await this.manifests.receiveScan(id, body, { actorId: principal.userId });
    return {
      shipmentId: result.shipmentId,
      trackingNumber: result.trackingNumber,
      scanStatus: result.scanStatus,
      scannedAt: result.scannedAt.toISOString(),
      summary: result.summary,
    };
  }

  @Post(":id/finalise-receipt")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:receive")
  async finaliseReceipt(
    @Param("id") id: string,
    @Body(zodBody(finaliseReceiptSchema)) body: z.infer<typeof finaliseReceiptSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DiscrepancyReport> {
    return this.manifests.finaliseReceipt(id, body, { actorId: principal.userId });
  }

  @Post(":id/discrepancies/resolve")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:receive")
  async resolveDiscrepancy(
    @Param("id") id: string,
    @Body(zodBody(resolveDiscrepancySchema)) body: z.infer<typeof resolveDiscrepancySchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{
    trackingNumber: string;
    resolutionReason: string | null;
    resolvedAt: string | null;
  }> {
    const row = await this.manifests.resolveDiscrepancy(id, body, {
      actorId: principal.userId,
    });
    return {
      trackingNumber: row.trackingNumber,
      resolutionReason: row.resolutionReason,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }

  @Post(":id/reconcile")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:receive")
  async reconcile(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ManifestResponse> {
    return toResponse(await this.manifests.reconcile(id, { actorId: principal.userId }));
  }
}

/**
 * Hub inbound scanning — parcels arriving without a manifest.
 *
 * Separate controller because the resource is the hub, not a manifest: this is
 * the "scan at hub inbound" trigger from docs/03 §4.2, the path a driver takes
 * when handing in a pickup round.
 */
@Controller("v1/hubs/:hubId/inbound")
export class HubInboundController {
  constructor(private readonly hubScans: HubScanService) {}

  @Post("batch")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:receive")
  async scanBatch(
    @Param("hubId") hubId: string,
    @Body(zodBody(hubInboundScanBatchSchema)) body: z.infer<typeof hubInboundScanBatchSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InboundBatchResult> {
    return this.hubScans.scanBatch(hubId, body, { actorId: principal.userId });
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("manifest:receive")
  async scan(
    @Param("hubId") hubId: string,
    @Body(zodBody(hubInboundScanSchema)) body: z.infer<typeof hubInboundScanSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InboundScanResult> {
    return this.hubScans.scan(hubId, body, { actorId: principal.userId });
  }
}

function toResponse(m: Manifest): ManifestResponse {
  return {
    id: m.id,
    code: m.code,
    type: m.type,
    status: m.status,
    fromHubId: m.fromHubId,
    toHubId: m.toHubId,
    fromDriverId: m.fromDriverId,
    toDriverId: m.toDriverId,
    vehicleId: m.vehicleId,
    itemCount: m.itemCount,
    discrepancyCount: m.discrepancyCount,
    sealedAt: m.sealedAt?.toISOString() ?? null,
    sealedByUserId: m.sealedByUserId,
    dispatchedAt: m.dispatchedAt?.toISOString() ?? null,
    receivedAt: m.receivedAt?.toISOString() ?? null,
    receivedByUserId: m.receivedByUserId,
    reconciledAt: m.reconciledAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    createdByUserId: m.createdByUserId,
    updatedAt: m.updatedAt.toISOString(),
  };
}
