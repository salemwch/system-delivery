import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";

import { TenantContext } from "../../../shared/database/index.js";
import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, Public, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { TenantService } from "../../platform/index.js";
import { MerchantApplicationService } from "../application/merchant-application.service.js";
import {
  approveApplicationSchema,
  rejectApplicationSchema,
  submitApplicationSchema,
} from "../domain/dtos.js";
import type { MerchantApplication } from "../domain/schema.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
});

interface ApplicationResponse {
  readonly id: string;
  readonly businessName: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string | null;
  readonly city: string | null;
  readonly addressLine: string | null;
  readonly expectedVolume: number | null;
  readonly message: string | null;
  readonly source: string;
  readonly status: string;
  readonly merchantId: string | null;
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
 * Nouveaux clients.
 *
 * The intake is PUBLIC; everything else needs a session. Reading the queue is
 * `merchant:read`, deciding it is `merchant:decide_application` — a separate
 * permission from `merchant:create`, because entering an account you already
 * agreed to and accepting a stranger are different authorities.
 */
@Controller("v1/merchant-applications")
export class MerchantApplicationController {
  constructor(
    private readonly applications: MerchantApplicationService,
    private readonly tenants: TenantService,
  ) {}

  /**
   * The public form. Unauthenticated.
   *
   * ⚠️ RETURNS 202 AND NOTHING ELSE, always — for a new application, for a
   * duplicate, for anything. An anonymous endpoint that answered differently
   * would be a way to ask "does this courier already know this phone number?".
   *
   * `TenantContext.run` is explicit here because the route is `@Public()`: no
   * interceptor has established a tenant, and the slug in the path is the only
   * thing that says which one this is.
   */
  @Post("public/:tenantSlug")
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  async submitPublic(
    @Param("tenantSlug") slug: string,
    @Body(zodBody(submitApplicationSchema)) body: z.infer<typeof submitApplicationSchema>,
  ): Promise<{ readonly received: true }> {
    const tenantId = await this.tenants.resolveBySlug(slug);

    await TenantContext.run({ tenantId, actorType: "api_client" }, () =>
      this.applications.submit(body, "PUBLIC_FORM"),
    );

    return { received: true };
  }

  /**
   * A lead logged by staff — a commercial back from a market visit.
   *
   * Same schema, different `source`, and no hourly cap: the cap exists to stop
   * an anonymous script, and a signed-in salesperson entering ten leads is the
   * intended use of the feature.
   */
  @Post()
  @RequirePermissions("merchant:create")
  @HttpCode(HttpStatus.ACCEPTED)
  async submitAsStaff(
    @Body(zodBody(submitApplicationSchema)) body: z.infer<typeof submitApplicationSchema>,
  ): Promise<{ readonly received: true }> {
    await this.applications.submit(body, "STAFF");
    return { received: true };
  }

  @Get()
  @RequirePermissions("merchant:read")
  async list(@Query() query: unknown): Promise<PageResponse<ApplicationResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.applications.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  /** How many are waiting. Declared before `:id`, which would match "count". */
  @Get("count")
  @RequirePermissions("merchant:read")
  async count(): Promise<{ readonly pending: number }> {
    return { pending: await this.applications.pendingCount() };
  }

  @Get(":id")
  @RequirePermissions("merchant:read")
  async getById(@Param("id") id: string): Promise<ApplicationResponse> {
    return toResponse(await this.applications.getById(id));
  }

  /** Approve: creates the merchant and links it. */
  @Post(":id/approve")
  @RequirePermissions("merchant:decide_application")
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param("id") id: string,
    @Body(zodBody(approveApplicationSchema)) body: z.infer<typeof approveApplicationSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ApplicationResponse> {
    return toResponse(await this.applications.approve(id, body, principal.userId));
  }

  @Post(":id/reject")
  @RequirePermissions("merchant:decide_application")
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param("id") id: string,
    @Body(zodBody(rejectApplicationSchema)) body: z.infer<typeof rejectApplicationSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ApplicationResponse> {
    return toResponse(await this.applications.reject(id, body, principal.userId));
  }
}

function toResponse(row: MerchantApplication): ApplicationResponse {
  return {
    id: row.id,
    businessName: row.businessName,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    city: row.city,
    addressLine: row.addressLine,
    expectedVolume: row.expectedVolume,
    message: row.message,
    source: row.source,
    status: row.status,
    merchantId: row.merchantId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt.toISOString(),
  };
}
