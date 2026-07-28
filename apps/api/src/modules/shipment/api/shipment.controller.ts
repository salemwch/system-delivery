import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { asTenantId } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { FeatureService } from "../../platform/index.js";
import { BulkShipmentService } from "../application/bulk-shipment.service.js";
import type { BulkCreateResult } from "../application/bulk-shipment.service.js";
import { ShipmentStatsService } from "../application/shipment-stats.service.js";
import type { DashboardStats, DriverStats, MerchantStats } from "../application/shipment-stats.service.js";
import { ShipmentService } from "../application/shipment.service.js";
import type { CommandContext, ShipmentEventView } from "../application/shipment.service.js";
import { ShipmentTraceabilityService } from "../application/traceability.service.js";
import type { AuditLogView, CustodyChainView, CurrentCustodyView, JourneyView } from "../application/traceability.service.js";
import { TrackingService } from "../application/tracking.service.js";
import type { Shipment } from "../domain/schema.js";
import {
  cancelShipmentSchema,
  confirmDeliverySchema,
  createShipmentSchema,
  initiateReturnSchema,
  recordFailedAttemptSchema,
  recordPickupSchema,
} from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  merchantId: z.string().min(1).optional(),
});

interface ShipmentResponse {
  readonly id: string;
  readonly trackingNumber: string;
  readonly merchantId: string | null;
  readonly externalReference: string | null;
  readonly recipientId: string | null;
  readonly status: string;
  readonly serviceLevel: string;
  readonly senderName: string;
  readonly senderPhone: string;
  readonly originAddressId: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly recipientPhoneAlt: string | null;
  readonly destinationAddressId: string;
  readonly promisedFrom: string | null;
  readonly promisedTo: string | null;
  readonly etaAt: string | null;
  readonly weightGrams: number;
  readonly volumeCm3: number | null;
  readonly parcelCount: number;
  readonly declaredValueMinor: string | null;
  readonly currency: string;
  readonly codAmountMinor: string;
  readonly codStatus: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly requiredSkills: string[];
  readonly currentCustodyType: string | null;
  readonly currentCustodyId: string | null;
  readonly customFields: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EventResponse {
  readonly id: string;
  readonly sequence: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly hubId: string | null;
  readonly driverId: string | null;
  readonly routeId: string | null;
  readonly legId: string | null;
  readonly reasonCode: string | null;
}

interface LookupResponse {
  readonly id: string;
  readonly trackingNumber: string;
  readonly status: string;
  readonly recipientName: string;
  readonly codAmountMinor: string;
  readonly currency: string;
  readonly trackingUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BulkItemResponse {
  readonly index: number;
  readonly success: boolean;
  readonly shipment: ShipmentResponse | null;
  readonly error: string | null;
  readonly code: string | null;
}

interface BulkCreateResponse {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BulkItemResponse[];
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

function ctxOf(principal: Principal): CommandContext {
  return {
    actor: { actorType: principal.actorType === "driver" ? "DRIVER" : "DISPATCHER", actorId: principal.userId },
    canOverride: principal.permissions.has("shipment:override_status"),
  };
}

const bulkCreateSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        idempotencyKey: z.string().trim().min(1).max(200),
        data: createShipmentSchema,
      }),
    )
    .min(1)
    .max(100),
});

const statsQuerySchema = z.object({
  currency: z.string().trim().length(3).transform((v) => v.toUpperCase()).optional(),
});

@Controller("v1/shipments")
export class ShipmentController {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly stats: ShipmentStatsService,
    private readonly bulkService: BulkShipmentService,
    private readonly tracking: TrackingService,
    private readonly traceability: ShipmentTraceabilityService,
    private readonly features: FeatureService,
  ) {}

  @Get("dashboard")
  @RequirePermissions("shipment:read")
  async dashboard(@Query() query: unknown): Promise<DashboardStats> {
    const { currency } = statsQuerySchema.parse(query);
    return this.stats.dashboard(currency ?? "TND");
  }

  @Get("lookup/:trackingNumber")
  @RequirePermissions("shipment:read")
  async lookupByTrackingNumber(
    @Param("trackingNumber") trackingNumber: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LookupResponse> {
    const result = await this.stats.lookupByTrackingNumber(trackingNumber);
    if (result === null) {
      throw new NotFoundError("Shipment");
    }
    const token = this.tracking.generateToken(principal.tenantId, result.trackingNumber);
    return {
      id: result.id,
      trackingNumber: result.trackingNumber,
      status: result.status,
      recipientName: result.recipientName,
      codAmountMinor: result.codAmountMinor,
      currency: result.currency,
      trackingUrl: token,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    };
  }

  @Get("merchant/:merchantId/stats")
  @RequirePermissions("shipment:read")
  async merchantStats(
    @Param("merchantId") merchantId: string,
    @Query() query: unknown,
  ): Promise<MerchantStats> {
    const { currency } = statsQuerySchema.parse(query);
    return this.stats.merchantStats(merchantId, currency ?? "TND");
  }

  @Get("driver/:driverId/stats")
  @RequirePermissions("shipment:read")
  async driverStats(
    @Param("driverId") driverId: string,
    @Query() query: unknown,
  ): Promise<DriverStats> {
    const { currency } = statsQuerySchema.parse(query);
    return this.stats.driverStats(driverId, currency ?? "TND");
  }

  @Post("bulk")
  @RequirePermissions("shipment:create")
  async bulkCreate(
    @Body(zodBody(bulkCreateSchema)) body: z.infer<typeof bulkCreateSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BulkCreateResponse> {
    await this.features.requireEnabled(asTenantId(principal.tenantId), "BULK_IMPORT_ENABLED");
    const items = body.items.map((item) => ({
      input: item.data,
      idempotencyKey: item.idempotencyKey,
    }));
    const result = await this.bulkService.createBulk(items, ctxOf(principal));
    return toBulkResponse(result);
  }

  @Post()
  @RequirePermissions("shipment:create")
  async create(
    @Body(zodBody(createShipmentSchema)) body: z.infer<typeof createShipmentSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.create(body, ctxOf(principal));
    return toResponse(shipment);
  }

  @Get()
  @RequirePermissions("shipment:read")
  async list(@Query() query: unknown): Promise<PageResponse<ShipmentResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.shipments.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.merchantId === undefined ? {} : { merchantId: parsed.merchantId }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("shipment:read")
  async getById(@Param("id") id: string): Promise<ShipmentResponse> {
    const shipment = await this.shipments.getById(id);
    return toResponse(shipment);
  }

  @Get(":id/events")
  @RequirePermissions("shipment:read")
  async getEvents(@Param("id") id: string): Promise<{ data: readonly EventResponse[] }> {
    const events = await this.shipments.getEvents(id);
    return { data: events.map(toEventResponse) };
  }

  @Get(":id/custody")
  @RequirePermissions("shipment:read")
  async getCustodyChain(@Param("id") id: string): Promise<CustodyChainView> {
    return this.traceability.getCustodyChain(id);
  }

  @Get(":id/journey")
  @RequirePermissions("shipment:read")
  async getJourney(@Param("id") id: string): Promise<JourneyView> {
    return this.traceability.getJourney(id);
  }

  @Get(":id/custody/current")
  @RequirePermissions("shipment:read")
  async getCurrentCustody(@Param("id") id: string): Promise<CurrentCustodyView> {
    return this.traceability.getCurrentCustody(id);
  }

  @Get(":id/audit")
  @RequirePermissions("audit:read")
  async getAuditLog(@Param("id") id: string): Promise<AuditLogView> {
    return this.traceability.getAuditLog(id);
  }

  @Post(":id/pickup")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shipment:update")
  async recordPickup(
    @Param("id") id: string,
    @Body(zodBody(recordPickupSchema)) body: z.infer<typeof recordPickupSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.recordPickup(id, body, ctxOf(principal));
    return toResponse(shipment);
  }

  @Post(":id/deliver")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shipment:deliver")
  async confirmDelivery(
    @Param("id") id: string,
    @Body(zodBody(confirmDeliverySchema)) body: z.infer<typeof confirmDeliverySchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.confirmDelivery(id, body, ctxOf(principal));
    return toResponse(shipment);
  }

  @Post(":id/fail")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shipment:fail")
  async recordFailedAttempt(
    @Param("id") id: string,
    @Body(zodBody(recordFailedAttemptSchema)) body: z.infer<typeof recordFailedAttemptSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.recordFailedAttempt(id, body, ctxOf(principal));
    return toResponse(shipment);
  }

  @Post(":id/return")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shipment:update")
  async initiateReturn(
    @Param("id") id: string,
    @Body(zodBody(initiateReturnSchema)) body: z.infer<typeof initiateReturnSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.initiateReturn(id, body, ctxOf(principal));
    return toResponse(shipment);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shipment:cancel")
  async cancel(
    @Param("id") id: string,
    @Body(zodBody(cancelShipmentSchema)) body: z.infer<typeof cancelShipmentSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.cancel(id, body, ctxOf(principal));
    return toResponse(shipment);
  }
}

function toResponse(s: Shipment): ShipmentResponse {
  return {
    id: s.id,
    trackingNumber: s.trackingNumber,
    merchantId: s.merchantId,
    externalReference: s.externalReference,
    recipientId: s.recipientId,
    status: s.status,
    serviceLevel: s.serviceLevel,
    senderName: s.senderName,
    senderPhone: s.senderPhone,
    originAddressId: s.originAddressId,
    recipientName: s.recipientName,
    recipientPhone: s.recipientPhone,
    recipientPhoneAlt: s.recipientPhoneAlt,
    destinationAddressId: s.destinationAddressId,
    promisedFrom: s.promisedFrom?.toISOString() ?? null,
    promisedTo: s.promisedTo?.toISOString() ?? null,
    etaAt: s.etaAt?.toISOString() ?? null,
    weightGrams: s.weightGrams,
    volumeCm3: s.volumeCm3,
    parcelCount: s.parcelCount,
    declaredValueMinor: s.declaredValueMinor?.toString() ?? null,
    currency: s.currency,
    codAmountMinor: s.codAmountMinor.toString(),
    codStatus: s.codStatus,
    attemptCount: s.attemptCount,
    maxAttempts: s.maxAttempts,
    priority: s.priority,
    requiredSkills: s.requiredSkills,
    currentCustodyType: s.currentCustodyType,
    currentCustodyId: s.currentCustodyId,
    customFields: s.customFields,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function toEventResponse(e: ShipmentEventView): EventResponse {
  return {
    id: e.id,
    sequence: e.sequence.toString(),
    eventType: e.eventType,
    occurredAt: e.occurredAt.toISOString(),
    recordedAt: e.recordedAt.toISOString(),
    actorType: e.actorType,
    actorId: e.actorId,
    latitude: e.latitude,
    longitude: e.longitude,
    hubId: e.hubId,
    driverId: e.driverId,
    routeId: e.routeId,
    legId: e.legId,
    reasonCode: e.reasonCode,
  };
}

function toBulkResponse(result: BulkCreateResult): BulkCreateResponse {
  return {
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
    results: result.results.map((r) => ({
      index: r.index,
      success: r.success,
      shipment: r.shipment !== null ? toResponse(r.shipment) : null,
      error: r.error,
      code: r.code,
    })),
  };
}
