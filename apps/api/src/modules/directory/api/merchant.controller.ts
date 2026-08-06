import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { RequirePermissions } from "../../identity/index.js";
import { MerchantService } from "../application/merchant.service.js";
import type { Merchant } from "../domain/schema.js";
import {
  assignAccountManagerSchema,
  createMerchantSchema,
  updateMerchantSchema,
} from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  /** "Show me this commercial's book of business". Ignored by RLS, not by it. */
  accountManagerId: z.uuid().optional(),
});

const suspendSchema = z.strictObject({
  reason: z.string().trim().min(1, "reason is required"),
});

interface MerchantResponse {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly defaultPickupAddressId: string | null;
  /** The COMMERCIAL who owns this account. NULL = house-managed. */
  readonly accountManagerId: string | null;
  readonly status: string;
  readonly blockReason: string | null;
  readonly settings: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/merchants")
export class MerchantController {
  constructor(private readonly merchants: MerchantService) {}

  /**
   * Registers a merchant.
   *
   * A COMMERCIAL becomes its account manager automatically. Nothing is passed
   * from here to say so — the service reads the scope from the ambient request
   * context, which was derived from the signed role claim by
   * TenantContextInterceptor and is the same value RLS narrows by. One source,
   * so the row's owner and the rows the owner can see cannot disagree.
   */
  @Post()
  @RequirePermissions("merchant:create")
  async create(
    @Body(zodBody(createMerchantSchema)) body: z.infer<typeof createMerchantSchema>,
  ): Promise<MerchantResponse> {
    const merchant = await this.merchants.create(body);
    return toResponse(merchant);
  }

  @Get()
  @RequirePermissions("merchant:read")
  async list(@Query() query: unknown): Promise<PageResponse<MerchantResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.merchants.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.accountManagerId === undefined
        ? {}
        : { accountManagerId: parsed.accountManagerId }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("merchant:read")
  async getById(@Param("id") id: string): Promise<MerchantResponse> {
    const merchant = await this.merchants.getById(id);
    return toResponse(merchant);
  }

  @Patch(":id")
  @RequirePermissions("merchant:update")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateMerchantSchema)) body: z.infer<typeof updateMerchantSchema>,
  ): Promise<MerchantResponse> {
    const merchant = await this.merchants.update(id, body);
    return toResponse(merchant);
  }

  /**
   * Moves the account between commercials, or unassigns it (`null`).
   *
   * PUT, not PATCH: the whole of the ownership is replaced, and repeating the
   * call changes nothing — the operation is idempotent by construction rather
   * than by an Idempotency-Key.
   */
  @Put(":id/account-manager")
  @RequirePermissions("merchant:assign_manager")
  async assignAccountManager(
    @Param("id") id: string,
    @Body(zodBody(assignAccountManagerSchema)) body: z.infer<typeof assignAccountManagerSchema>,
  ): Promise<MerchantResponse> {
    const merchant = await this.merchants.assignAccountManager(id, body);
    return toResponse(merchant);
  }

  @Post(":id/suspend")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("merchant:block")
  async suspend(
    @Param("id") id: string,
    @Body(zodBody(suspendSchema)) body: z.infer<typeof suspendSchema>,
  ): Promise<MerchantResponse> {
    const merchant = await this.merchants.suspend(id, body.reason);
    return toResponse(merchant);
  }

  @Post(":id/activate")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("merchant:block")
  async activate(@Param("id") id: string): Promise<MerchantResponse> {
    const merchant = await this.merchants.activate(id);
    return toResponse(merchant);
  }
}

function toResponse(m: Merchant): MerchantResponse {
  return {
    id: m.id,
    name: m.name,
    code: m.code,
    contactName: m.contactName,
    contactPhone: m.contactPhone,
    contactEmail: m.contactEmail,
    defaultPickupAddressId: m.defaultPickupAddressId,
    accountManagerId: m.accountManagerId,
    status: m.status,
    blockReason: m.blockReason,
    settings: m.settings,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}
