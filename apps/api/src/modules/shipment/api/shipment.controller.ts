import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { asTenantId } from "../../../shared/database/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { AddressService } from "../../directory/index.js";
import type { AddressView } from "../../directory/index.js";
import { FeatureService } from "../../platform/index.js";
import { BulkShipmentService } from "../application/bulk-shipment.service.js";
import type { BulkCreateResult } from "../application/bulk-shipment.service.js";
import { DocumentService } from "../application/document.service.js";
import { LabelService } from "../application/label.service.js";
import { ShipmentStatsService } from "../application/shipment-stats.service.js";
import type {
  DashboardStats,
  DriverStats,
  MerchantStats,
} from "../application/shipment-stats.service.js";
import { ShipmentService } from "../application/shipment.service.js";
import type { CommandContext, ShipmentEventView } from "../application/shipment.service.js";
import { ShipmentTraceabilityService } from "../application/traceability.service.js";
import type {
  AuditLogView,
  CustodyChainView,
  CurrentCustodyView,
  JourneyView,
} from "../application/traceability.service.js";
import { TrackingService } from "../application/tracking.service.js";
import { isDocumentType } from "../domain/document.js";
import type { Shipment } from "../domain/schema.js";
import {
  cancelShipmentSchema,
  completeReturnSchema,
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
  /**
   * ISO 4217 minor-unit exponent for `currency`, from the `currencies` table.
   *
   * Sent so no client has to assume one. TND has THREE decimals; a UI dividing
   * `codAmountMinor` by a hardcoded 100 misprices every Tunisian parcel by a
   * factor of ten, and both web pages were doing exactly that.
   */
  readonly currencyExponent: number;
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

/**
 * An address as a caller reads it.
 *
 * A narrow projection, not the row: `tenantId` is implied by the request and
 * `geocodeConfidence`/`geocodeSource` are dispatch-internal quality signals
 * that mean nothing on a detail page.
 */
interface AddressResponse {
  readonly id: string;
  /** Exactly what was submitted. Always populated, unlike the parsed fields. */
  readonly rawInput: string;
  readonly line1: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly accessNotes: string | null;
}

/** A shipment plus its resolved addresses. Returned by the single-row route only. */
interface ShipmentDetailResponse extends ShipmentResponse {
  readonly origin: AddressResponse;
  readonly destination: AddressResponse;
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
    actor: {
      actorType: principal.actorType === "driver" ? "DRIVER" : "DISPATCHER",
      actorId: principal.userId,
    },
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

const documentQuerySchema = z.object({
  /** ar | fr | en. Omitted → the tenant default, then French. */
  locale: z.string().trim().min(2).max(5).optional(),
});

const statsQuerySchema = z.object({
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((v) => v.toUpperCase())
    .optional(),
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
    private readonly labels: LabelService,
    private readonly documents: DocumentService,
    private readonly addresses: AddressService,
    private readonly currencies: CurrencyService,
  ) {}

  /** One currency's minor-unit exponent. Cached per process by CurrencyService. */
  private async exponentOf(currency: string): Promise<number> {
    return this.currencies.exponentOf(currency);
  }

  /**
   * Exponents for a page of shipments, resolved ONCE per distinct currency.
   *
   * A page is almost always one currency, so this is one lookup — and the
   * lookup is itself process-cached. Mapping each row independently would be
   * correct but would ask the same question fifty times.
   */
  private async exponentsFor(currencies: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const distinct = [...new Set(currencies)];
    const pairs = await Promise.all(
      distinct.map(async (code) => [code, await this.currencies.exponentOf(code)] as const),
    );
    return new Map(pairs);
  }

  /**
   * The scannable label for a parcel (docs/01-mvp-scope.md §4.2 #2.15).
   *
   * Returns the QR as a data URI plus the tracking number, so a merchant or
   * courier UI can drop it straight into a printable page. Reads through
   * ShipmentService, so RLS and the merchant scope apply — asking for another
   * merchant's label is a not-found, not a picture of their parcel.
   */
  @Get(":id/label")
  @RequirePermissions("shipment:label")
  async label(@Param("id") id: string): Promise<{
    shipmentId: string;
    trackingNumber: string;
    recipientName: string;
    qrDataUri: string;
  }> {
    const label = await this.labels.render(id);
    return {
      shipmentId: label.shipmentId,
      trackingNumber: label.trackingNumber,
      recipientName: label.recipientName,
      qrDataUri: label.qrDataUri,
    };
  }

  /**
   * A printable delivery document (docs/01-mvp-scope.md §4.2 #2.14).
   *
   * `bon-de-livraison` · `bon-d-envoi` · `bon-de-retour` — paper documents are
   * standard practice in Tunisian courier operations, so these are printed,
   * signed and filed.
   *
   * Returns **HTML**, and the browser's own Print-to-PDF produces the PDF. That is
   * not a shortcut: Arabic needs bidirectional layout and contextual glyph
   * shaping, which browsers do natively and Node PDF libraries do not — through
   * one of those, Arabic comes out as disconnected letters in the wrong order.
   *
   * `shipment:label` rather than a new permission: this is the same authority as
   * printing the parcel's label, held by the same people, and a permission nobody
   * can articulate the difference for is a permission that gets granted by
   * accident.
   */
  @Get(":id/documents/:documentType")
  @RequirePermissions("shipment:label")
  @Header("content-type", "text/html; charset=utf-8")
  // A document is a snapshot of a live shipment. Caching it means a driver prints
  // yesterday's address after a correction — the exact failure the address
  // -correction flow exists to prevent.
  @Header("cache-control", "no-store")
  async document(
    @Param("id") id: string,
    @Param("documentType") documentType: string,
    @Query() query: unknown,
  ): Promise<string> {
    const { locale } = documentQuerySchema.parse(query);
    const normalised = documentType.replace(/-/gu, "_").toUpperCase();
    if (!isDocumentType(normalised)) {
      throw new NotFoundError("Document type");
    }
    const rendered = await this.documents.render(id, normalised, locale);
    return rendered.html;
  }

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
    const exponents = await this.exponentsFor(
      result.results.flatMap((r) => (r.shipment === null ? [] : [r.shipment.currency])),
    );
    return toBulkResponse(result, exponents);
  }

  @Post()
  @RequirePermissions("shipment:create")
  async create(
    @Body(zodBody(createShipmentSchema)) body: z.infer<typeof createShipmentSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.create(body, ctxOf(principal));
    return toResponse(shipment, await this.exponentOf(shipment.currency));
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
    const exponents = await this.exponentsFor(page.items.map((item) => item.currency));
    return {
      data: page.items.map((item) => toResponse(item, exponents.get(item.currency) ?? 0)),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /**
   * One shipment, with its two addresses RESOLVED.
   *
   * The list returns `originAddressId`/`destinationAddressId` and stops there —
   * resolving on a list would be N+1. A detail view is one row, and a
   * dispatcher looking at a single parcel needs to read where it is going;
   * an id tells them nothing and there is no address endpoint to follow it to.
   *
   * The two lookups run together: they are independent, and a detail page
   * should not pay for them in series.
   */
  @Get(":id")
  @RequirePermissions("shipment:read")
  async getById(@Param("id") id: string): Promise<ShipmentDetailResponse> {
    const shipment = await this.shipments.getById(id);
    const [origin, destination] = await Promise.all([
      this.addresses.getById(shipment.originAddressId),
      this.addresses.getById(shipment.destinationAddressId),
    ]);
    return { ...toResponse(shipment, await this.exponentOf(shipment.currency)), origin: toAddress(origin), destination: toAddress(destination) };
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
    return toResponse(shipment, await this.exponentOf(shipment.currency));
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
    return toResponse(shipment, await this.exponentOf(shipment.currency));
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
    return toResponse(shipment, await this.exponentOf(shipment.currency));
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
    return toResponse(shipment, await this.exponentOf(shipment.currency));
  }

  /**
   * Closes the RTO lifecycle — the parcel is physically back with the merchant.
   *
   * `shipment:deliver` rather than `shipment:update`: handing a parcel back is a
   * custody transfer performed by the driver who carried it, and it is the same
   * authority as completing a delivery. A dispatcher who can edit a shipment
   * should not be able to assert that a parcel arrived somewhere.
   */
  @Post(":id/return/complete")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shipment:deliver")
  async completeReturn(
    @Param("id") id: string,
    @Body(zodBody(completeReturnSchema)) body: z.infer<typeof completeReturnSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShipmentResponse> {
    const shipment = await this.shipments.completeReturn(id, body, ctxOf(principal));
    return toResponse(shipment, await this.exponentOf(shipment.currency));
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
    return toResponse(shipment, await this.exponentOf(shipment.currency));
  }
}

function toResponse(s: Shipment, currencyExponent: number): ShipmentResponse {
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
    currencyExponent,
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

function toAddress(a: AddressView): AddressResponse {
  return {
    id: a.id,
    rawInput: a.rawInput,
    line1: a.normalisedLine1,
    city: a.city,
    region: a.region,
    postalCode: a.postalCode,
    countryCode: a.countryCode,
    latitude: a.latitude,
    longitude: a.longitude,
    accessNotes: a.accessNotes,
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

function toBulkResponse(
  result: BulkCreateResult,
  exponents: ReadonlyMap<string, number>,
): BulkCreateResponse {
  return {
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
    results: result.results.map((r) => ({
      index: r.index,
      success: r.success,
      shipment:
        r.shipment === null
          ? null
          : toResponse(r.shipment, exponents.get(r.shipment.currency) ?? 0),
      error: r.error,
      code: r.code,
    })),
  };
}
