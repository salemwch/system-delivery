import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { RequirePermissions } from "../../identity/index.js";
import { ZoneService } from "../application/zone.service.js";
import type { ZoneView } from "../application/zone.service.js";
import { createZoneSchema, updateZoneSchema } from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  active: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

interface ZoneResponse {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly defaultGeofenceRadiusM: number;
  readonly active: boolean;
  readonly centroidLat: number;
  readonly centroidLng: number;
  readonly boundary: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/zones")
export class ZoneController {
  constructor(private readonly zones: ZoneService) {}

  @Post()
  @RequirePermissions("hub:manage")
  async create(
    @Body(zodBody(createZoneSchema)) body: z.infer<typeof createZoneSchema>,
  ): Promise<ZoneResponse> {
    const zone = await this.zones.create(body);
    return toResponse(zone);
  }

  @Get()
  @RequirePermissions("hub:read")
  async list(@Query() query: unknown): Promise<PageResponse<ZoneResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.zones.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.active === undefined ? {} : { active: parsed.active }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("hub:read")
  async getById(@Param("id") id: string): Promise<ZoneResponse> {
    const zone = await this.zones.getById(id);
    return toResponse(zone);
  }

  @Patch(":id")
  @RequirePermissions("hub:manage")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateZoneSchema)) body: z.infer<typeof updateZoneSchema>,
  ): Promise<ZoneResponse> {
    const zone = await this.zones.update(id, body);
    return toResponse(zone);
  }
}

function toResponse(z: ZoneView): ZoneResponse {
  return {
    id: z.id,
    code: z.code,
    name: z.name,
    defaultGeofenceRadiusM: z.defaultGeofenceRadiusM,
    active: z.active,
    centroidLat: z.centroidLat,
    centroidLng: z.centroidLng,
    boundary: z.boundary,
    createdAt: z.createdAt.toISOString(),
    updatedAt: z.updatedAt.toISOString(),
  };
}
