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
import { VehicleService } from "../application/vehicle.service.js";
import type { Vehicle } from "../domain/schema.js";
import { createVehicleSchema, updateVehicleSchema } from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(["ACTIVE", "MAINTENANCE", "INACTIVE"]).optional(),
});

const setStatusSchema = z.strictObject({
  status: z.enum(["ACTIVE", "MAINTENANCE", "INACTIVE"]),
});

interface VehicleResponse {
  readonly id: string;
  readonly plateNumber: string;
  readonly type: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly capacityWeightGrams: number;
  readonly capacityVolumeCm3: number;
  readonly capacityParcels: number;
  readonly features: string[];
  readonly homeHubId: string | null;
  readonly status: string;
  readonly insuranceExpiryAt: string | null;
  readonly inspectionExpiryAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/vehicles")
export class VehicleController {
  constructor(private readonly vehicles: VehicleService) {}

  @Post()
  @RequirePermissions("vehicle:manage")
  async create(
    @Body(zodBody(createVehicleSchema)) body: z.infer<typeof createVehicleSchema>,
  ): Promise<VehicleResponse> {
    const vehicle = await this.vehicles.create(body);
    return toResponse(vehicle);
  }

  @Get()
  @RequirePermissions("vehicle:read")
  async list(@Query() query: unknown): Promise<PageResponse<VehicleResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.vehicles.list({
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
  @RequirePermissions("vehicle:read")
  async getById(@Param("id") id: string): Promise<VehicleResponse> {
    const vehicle = await this.vehicles.getById(id);
    return toResponse(vehicle);
  }

  @Patch(":id")
  @RequirePermissions("vehicle:manage")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateVehicleSchema)) body: z.infer<typeof updateVehicleSchema>,
  ): Promise<VehicleResponse> {
    const vehicle = await this.vehicles.update(id, body);
    return toResponse(vehicle);
  }

  @Post(":id/status")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("vehicle:manage")
  async setStatus(
    @Param("id") id: string,
    @Body(zodBody(setStatusSchema)) body: z.infer<typeof setStatusSchema>,
  ): Promise<VehicleResponse> {
    const vehicle = await this.vehicles.setStatus(id, body.status);
    return toResponse(vehicle);
  }
}

function toResponse(v: Vehicle): VehicleResponse {
  return {
    id: v.id,
    plateNumber: v.plateNumber,
    type: v.type,
    make: v.make,
    model: v.model,
    year: v.year,
    capacityWeightGrams: v.capacityWeightGrams,
    capacityVolumeCm3: v.capacityVolumeCm3,
    capacityParcels: v.capacityParcels,
    features: v.features,
    homeHubId: v.homeHubId,
    status: v.status,
    insuranceExpiryAt: v.insuranceExpiryAt,
    inspectionExpiryAt: v.inspectionExpiryAt,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}
