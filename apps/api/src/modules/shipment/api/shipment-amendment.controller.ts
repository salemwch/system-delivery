import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrencyService } from "../../../shared/money/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Permission, Principal } from "../../identity/index.js";
import { ShipmentAmendmentService } from "../application/shipment-amendment.service.js";
import type { AmendmentView } from "../application/shipment-amendment.service.js";
import { rejectAmendmentSchema, requestAmendmentSchema } from "../domain/dtos.js";

/**
 * The permission that turns a request into an immediate change.
 *
 * Typed as `Permission` so a typo is a build error rather than a check that
 * silently never matches — which would make every dispatcher's edit sit in the
 * queue waiting for themselves.
 */
const APPROVE_PERMISSION: Permission = "shipment:amend_approve";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(["PENDING", "APPLIED", "REJECTED"]).optional(),
  shipmentId: z.string().min(1).optional(),
});

interface AmendmentResponse {
  readonly id: string;
  readonly shipmentId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly recipientName: string | null;
  readonly recipientPhone: string | null;
  readonly recipientPhoneAlt: string | null;
  readonly destinationRawInput: string | null;
  readonly destinationCity: string | null;
  /** Minor units as a string — JSON has no bigint. */
  readonly codAmountMinor: string | null;
  /**
   * The parcel's currency and its ISO 4217 exponent.
   *
   * Always present, even when no amount changed: without them 45000 is 45
   * dinars or 450 euros, and a client that guessed ÷100 would misprice every
   * Tunisian parcel tenfold.
   */
  readonly currency: string;
  readonly currencyExponent: number;
  /** What the parcel held before, for the fields this touched. */
  readonly previous: unknown;
  readonly requestedByUserId: string;
  readonly decidedAt: string | null;
  readonly decidedByUserId: string | null;
  readonly decisionReason: string | null;
  readonly createdAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Modification Colis.
 *
 * Requesting is `shipment:update`, which a merchant holds for their own parcels
 * (RLS narrows the rows). Deciding is `shipment:amend_approve`, which they do
 * not.
 */
@Controller("v1")
export class ShipmentAmendmentController {
  constructor(
    private readonly amendments: ShipmentAmendmentService,
    private readonly currencies: CurrencyService,
  ) {}

  /**
   * Ask to change a parcel.
   *
   * ⚠️ Returns 200 with `status: "APPLIED"` when the caller could have made the
   * change directly, and 202 with `status: "PENDING"` otherwise. The status in
   * the body is the authority — a client that assumed "requested" would tell a
   * dispatcher their own edit was waiting for someone.
   */
  @Post("shipments/:id/amendments")
  @RequirePermissions("shipment:update")
  @HttpCode(HttpStatus.OK)
  async request(
    @Param("id") shipmentId: string,
    @Body(zodBody(requestAmendmentSchema)) body: z.infer<typeof requestAmendmentSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AmendmentResponse> {
    // Read from the token, never the body: whether this is applied on the spot
    // is an authorization decision, and a caller-supplied flag would be a way to
    // approve your own change without the permission to do so.
    const canApprove = principal.permissions.has(APPROVE_PERMISSION);
    return this.render(
      await this.amendments.request(shipmentId, body, principal.userId, canApprove),
    );
  }

  /** A parcel's own change history, newest first. */
  @Get("shipments/:id/amendments")
  @RequirePermissions("shipment:read")
  async forShipment(@Param("id") shipmentId: string): Promise<PageResponse<AmendmentResponse>> {
    const page = await this.amendments.list({ shipmentId });
    return {
      data: await this.renderAll(page.items),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /** The dispatcher's queue across every parcel. */
  @Get("shipment-amendments")
  @RequirePermissions("shipment:read")
  async list(@Query() query: unknown): Promise<PageResponse<AmendmentResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.amendments.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.shipmentId === undefined ? {} : { shipmentId: parsed.shipmentId }),
    });
    return {
      data: await this.renderAll(page.items),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /** How many are waiting. Declared before `:id`, which would match "count". */
  @Get("shipment-amendments/count")
  @RequirePermissions("shipment:read")
  async count(): Promise<{ readonly pending: number }> {
    return { pending: await this.amendments.pendingCount() };
  }

  @Get("shipment-amendments/:id")
  @RequirePermissions("shipment:read")
  async getById(@Param("id") id: string): Promise<AmendmentResponse> {
    return this.render(await this.amendments.getById(id));
  }

  @Post("shipment-amendments/:id/approve")
  @RequirePermissions("shipment:amend_approve")
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AmendmentResponse> {
    return this.render(await this.amendments.apply(id, principal.userId));
  }

  @Post("shipment-amendments/:id/reject")
  @RequirePermissions("shipment:amend_approve")
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param("id") id: string,
    @Body(zodBody(rejectAmendmentSchema)) body: z.infer<typeof rejectAmendmentSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AmendmentResponse> {
    return this.render(await this.amendments.reject(id, body, principal.userId));
  }

  private async render(row: AmendmentView): Promise<AmendmentResponse> {
    return toResponse(row, await this.currencies.exponentOf(row.currency));
  }

  /**
   * One exponent lookup per DISTINCT currency, not per row.
   *
   * `CurrencyService` caches per process, so this is cheap either way — but a
   * page of fifty awaiting the same answer fifty times is fifty awaits in a hot
   * path for a value that cannot differ within a currency.
   */
  private async renderAll(rows: readonly AmendmentView[]): Promise<AmendmentResponse[]> {
    const exponents = new Map<string, number>();
    for (const currency of new Set(rows.map((row) => row.currency))) {
      exponents.set(currency, await this.currencies.exponentOf(currency));
    }
    return rows.map((row) => {
      const exponent = exponents.get(row.currency);
      if (exponent === undefined) {
        // Unreachable: the map is built from these same rows. Thrown rather than
        // defaulted, because a defaulted exponent prints 45000 millimes as
        // "45000 TND" on a screen a dispatcher decides money from.
        throw new Error(`No exponent resolved for currency ${row.currency}`);
      }
      return toResponse(row, exponent);
    });
  }
}

function toResponse(row: AmendmentView, currencyExponent: number): AmendmentResponse {
  return {
    id: row.id,
    shipmentId: row.shipmentId,
    status: row.status,
    reason: row.reason,
    recipientName: row.recipientName,
    recipientPhone: row.recipientPhone,
    recipientPhoneAlt: row.recipientPhoneAlt,
    destinationRawInput: row.destinationRawInput,
    destinationCity: row.destinationCity,
    codAmountMinor: row.codAmountMinor === null ? null : row.codAmountMinor.toString(),
    currency: row.currency,
    currencyExponent,
    previous: row.previous,
    requestedByUserId: row.requestedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt.toISOString(),
  };
}
