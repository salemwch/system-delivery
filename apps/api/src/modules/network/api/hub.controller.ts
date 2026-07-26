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
import { HubService } from "../application/hub.service.js";
import type { HubView } from "../application/hub.service.js";
import { createHubSchema, updateHubSchema } from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

interface HubResponse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly addressId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  readonly parentHubId: string | null;
  readonly serviceZoneIds: string[];
  readonly cutoffTimes: unknown;
  readonly cashAccountId: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/hubs")
export class HubController {
  constructor(private readonly hubs: HubService) {}

  @Post()
  @RequirePermissions("hub:manage")
  async create(
    @Body(zodBody(createHubSchema)) body: z.infer<typeof createHubSchema>,
  ): Promise<HubResponse> {
    const hub = await this.hubs.create(body);
    return toResponse(hub);
  }

  @Get()
  @RequirePermissions("hub:read")
  async list(@Query() query: unknown): Promise<PageResponse<HubResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.hubs.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("hub:read")
  async getById(@Param("id") id: string): Promise<HubResponse> {
    const hub = await this.hubs.getById(id);
    return toResponse(hub);
  }

  @Patch(":id")
  @RequirePermissions("hub:manage")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateHubSchema)) body: z.infer<typeof updateHubSchema>,
  ): Promise<HubResponse> {
    const hub = await this.hubs.update(id, body);
    return toResponse(hub);
  }

  @Post(":id/deactivate")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("hub:manage")
  async deactivate(@Param("id") id: string): Promise<HubResponse> {
    const hub = await this.hubs.deactivate(id);
    return toResponse(hub);
  }

  @Post(":id/activate")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("hub:manage")
  async activate(@Param("id") id: string): Promise<HubResponse> {
    const hub = await this.hubs.activate(id);
    return toResponse(hub);
  }
}

function toResponse(h: HubView): HubResponse {
  return {
    id: h.id,
    code: h.code,
    name: h.name,
    type: h.type,
    addressId: h.addressId,
    latitude: h.latitude,
    longitude: h.longitude,
    timezone: h.timezone,
    parentHubId: h.parentHubId,
    serviceZoneIds: h.serviceZoneIds,
    cutoffTimes: h.cutoffTimes,
    cashAccountId: h.cashAccountId,
    status: h.status,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}
