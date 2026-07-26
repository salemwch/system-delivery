import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { RequirePermissions } from "../../identity/index.js";
import { RecipientService } from "../application/recipient.service.js";
import type { Recipient } from "../domain/schema.js";
import {
  blockRecipientSchema,
  createRecipientSchema,
  updateRecipientSchema,
} from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  blocked: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface RecipientResponse {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly phoneAlt: string | null;
  readonly defaultAddressId: string | null;
  readonly preferredLanguage: string | null;
  readonly notes: string | null;
  readonly totalShipments: number;
  readonly successfulDeliveries: number;
  readonly failedDeliveries: number;
  readonly lastShipmentAt: string | null;
  readonly isBlocked: boolean;
  readonly blockReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/recipients")
export class RecipientController {
  constructor(private readonly recipients: RecipientService) {}

  @Post()
  @RequirePermissions("recipient:create")
  async create(
    @Body(zodBody(createRecipientSchema)) body: z.infer<typeof createRecipientSchema>,
  ): Promise<RecipientResponse> {
    const recipient = await this.recipients.create(body);
    return toResponse(recipient);
  }

  @Get()
  @RequirePermissions("recipient:read")
  async list(@Query() query: unknown): Promise<PageResponse<RecipientResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.recipients.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.blocked === undefined ? {} : { blocked: parsed.blocked }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("recipient:read")
  async getById(@Param("id") id: string): Promise<RecipientResponse> {
    const recipient = await this.recipients.getById(id);
    return toResponse(recipient);
  }

  @Patch(":id")
  @RequirePermissions("recipient:update")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateRecipientSchema)) body: z.infer<typeof updateRecipientSchema>,
  ): Promise<RecipientResponse> {
    const recipient = await this.recipients.update(id, body);
    return toResponse(recipient);
  }

  @Post(":id/block")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("recipient:block")
  async block(
    @Param("id") id: string,
    @Body(zodBody(blockRecipientSchema)) body: z.infer<typeof blockRecipientSchema>,
  ): Promise<RecipientResponse> {
    const recipient = await this.recipients.block(id, body);
    return toResponse(recipient);
  }

  @Post(":id/unblock")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("recipient:block")
  async unblock(@Param("id") id: string): Promise<RecipientResponse> {
    const recipient = await this.recipients.unblock(id);
    return toResponse(recipient);
  }
}

function toResponse(r: Recipient): RecipientResponse {
  return {
    id: r.id,
    fullName: r.fullName,
    phone: r.phone,
    phoneAlt: r.phoneAlt,
    defaultAddressId: r.defaultAddressId,
    preferredLanguage: r.preferredLanguage,
    notes: r.notes,
    totalShipments: r.totalShipments,
    successfulDeliveries: r.successfulDeliveries,
    failedDeliveries: r.failedDeliveries,
    lastShipmentAt: r.lastShipmentAt?.toISOString() ?? null,
    isBlocked: r.isBlocked,
    blockReason: r.blockReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
