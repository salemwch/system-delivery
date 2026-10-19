import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";

import { RequirePermissions } from "../../identity/index.js";
import { AddressCorrectionService } from "../application/address-correction.service.js";
import type { AddressCorrectionView } from "../application/address-correction.service.js";
import {
  correctAddressSchema,
  listCorrectionsSchema,
  reviewCorrectionSchema,
} from "../domain/dtos.js";

/** A malformed id is a 422 at the boundary, never a database cast error. */
const idParam = zodBody(z.uuid());
/** A review note is optional, and so is the body that would carry it. */
const reviewBody = zodBody(reviewCorrectionSchema.optional());

interface CorrectionResponse {
  readonly id: string;
  readonly addressId: string;
  readonly status: string;
  readonly from: { readonly lat: number; readonly lng: number } | null;
  readonly to: { readonly lat: number; readonly lng: number };
  readonly distanceMovedM: number | null;
  readonly accuracyM: number | null;
  readonly confidenceBefore: number | null;
  readonly accessNotes: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly correctedByUserId: string;
  readonly driverId: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
  readonly address: { readonly rawInput: string; readonly city: string | null } | null;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/**
 * Driver geocode corrections (docs/01-mvp-scope.md 2.10).
 *
 * The driver submits under `address:correct`; which address they may reach is
 * decided by RLS (0050), so a colleague's address is a 404. Everything else is
 * the dispatcher's review queue under `address:review`.
 */
@Controller()
export class AddressCorrectionController {
  constructor(private readonly corrections: AddressCorrectionService) {}

  /**
   * 201 with the recorded outcome: APPLIED, PENDING_REVIEW (moved > 2 km) or
   * SUPERSEDED (observed before the current pin). A replayed idempotency key
   * returns the original outcome with `Idempotency-Replayed: true`
   * (docs/05-api-contracts.md §3), so the offline app can tell "done now" from
   * "already done".
   */
  @Post("v1/addresses/:id/corrections")
  @RequirePermissions("address:correct")
  async submit(
    @Param("id", idParam) id: string,
    @Body(zodBody(correctAddressSchema)) body: z.infer<typeof correctAddressSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CorrectionResponse> {
    const outcome = await this.corrections.submit(id, body);
    if (outcome.replayed) {
      void reply.header("Idempotency-Replayed", "true");
    }
    return toResponse(outcome.correction);
  }

  @Get("v1/address-corrections")
  @RequirePermissions("address:review")
  async list(
    @Query(zodBody(listCorrectionsSchema)) query: z.infer<typeof listCorrectionsSchema>,
  ): Promise<PageResponse<CorrectionResponse>> {
    const page = await this.corrections.list(query);
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get("v1/address-corrections/count")
  @RequirePermissions("address:review")
  async pendingCount(): Promise<{ readonly pending: number }> {
    return { pending: await this.corrections.pendingCount() };
  }

  @Get("v1/address-corrections/:id")
  @RequirePermissions("address:review")
  async getById(@Param("id", idParam) id: string): Promise<CorrectionResponse> {
    return toResponse(await this.corrections.getById(id));
  }

  @Post("v1/address-corrections/:id/approve")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("address:review")
  async approve(
    @Param("id", idParam) id: string,
    @Body(reviewBody) body: z.infer<typeof reviewCorrectionSchema> | undefined,
  ): Promise<CorrectionResponse> {
    return toResponse(await this.corrections.approve(id, body ?? {}));
  }

  @Post("v1/address-corrections/:id/reject")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("address:review")
  async reject(
    @Param("id", idParam) id: string,
    @Body(reviewBody) body: z.infer<typeof reviewCorrectionSchema> | undefined,
  ): Promise<CorrectionResponse> {
    return toResponse(await this.corrections.reject(id, body ?? {}));
  }
}

function toResponse(c: AddressCorrectionView): CorrectionResponse {
  return {
    id: c.id,
    addressId: c.addressId,
    status: c.status,
    from: c.from,
    to: c.to,
    distanceMovedM: c.distanceMovedM,
    accuracyM: c.accuracyM,
    confidenceBefore: c.confidenceBefore,
    accessNotes: c.accessNotes,
    occurredAt: c.occurredAt.toISOString(),
    recordedAt: c.recordedAt.toISOString(),
    correctedByUserId: c.correctedByUserId,
    driverId: c.driverId,
    reviewedByUserId: c.reviewedByUserId,
    reviewedAt: c.reviewedAt?.toISOString() ?? null,
    reviewNote: c.reviewNote,
    address: c.address,
  };
}
