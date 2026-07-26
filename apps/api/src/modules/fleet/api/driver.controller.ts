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
import { DriverService } from "../application/driver.service.js";
import type { DriverView } from "../application/driver.service.js";
import { createDriverSchema, updateDriverSchema } from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(["PENDING", "ACTIVE", "INACTIVE", "SUSPENDED"]).optional(),
});

const listAvailableQuerySchema = z.object({
  at: z.coerce.date().optional(),
  skills: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
});

interface DriverResponse {
  readonly id: string;
  readonly userId: string | null;
  readonly employeeCode: string;
  readonly fullName: string;
  readonly phone: string;
  readonly hasNationalId: boolean;
  readonly hasLicence: boolean;
  readonly licenceExpiryAt: string | null;
  readonly status: string;
  readonly employmentType: string;
  readonly homeHubId: string | null;
  readonly defaultVehicleId: string | null;
  readonly skills: string[];
  readonly cashAccountId: string | null;
  readonly locale: string;
  readonly deviceId: string | null;
  readonly appVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/drivers")
export class DriverController {
  constructor(private readonly drivers: DriverService) {}

  @Post()
  @RequirePermissions("driver:create")
  async create(
    @Body(zodBody(createDriverSchema)) body: z.infer<typeof createDriverSchema>,
  ): Promise<DriverResponse> {
    const driver = await this.drivers.create(body);
    return toResponse(driver);
  }

  @Get("available")
  @RequirePermissions("driver:read")
  async listAvailable(@Query() query: unknown): Promise<{ data: readonly DriverResponse[] }> {
    const parsed = listAvailableQuerySchema.parse(query);
    const available = await this.drivers.listAvailable({
      ...(parsed.at === undefined ? {} : { at: parsed.at }),
      ...(parsed.skills === undefined ? {} : { skills: parsed.skills }),
    });
    return { data: available.map(toResponse) };
  }

  @Get()
  @RequirePermissions("driver:read")
  async list(@Query() query: unknown): Promise<PageResponse<DriverResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.drivers.list({
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
  @RequirePermissions("driver:read")
  async getById(@Param("id") id: string): Promise<DriverResponse> {
    const driver = await this.drivers.getById(id);
    return toResponse(driver);
  }

  @Get(":id/pii")
  @RequirePermissions("pii:export")
  async revealPii(
    @Param("id") id: string,
  ): Promise<{ nationalId: string | null; licenceNumber: string | null }> {
    return this.drivers.revealPii(id);
  }

  @Patch(":id")
  @RequirePermissions("driver:update")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateDriverSchema)) body: z.infer<typeof updateDriverSchema>,
  ): Promise<DriverResponse> {
    const driver = await this.drivers.update(id, body);
    return toResponse(driver);
  }

  @Post(":id/activate")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("driver:update")
  async activate(@Param("id") id: string): Promise<DriverResponse> {
    const driver = await this.drivers.activate(id);
    return toResponse(driver);
  }

  @Post(":id/suspend")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("driver:update")
  async suspend(@Param("id") id: string): Promise<DriverResponse> {
    const driver = await this.drivers.suspend(id);
    return toResponse(driver);
  }

  @Post(":id/deactivate")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("driver:update")
  async deactivate(@Param("id") id: string): Promise<DriverResponse> {
    const driver = await this.drivers.deactivate(id);
    return toResponse(driver);
  }
}

function toResponse(d: DriverView): DriverResponse {
  return {
    id: d.id,
    userId: d.userId,
    employeeCode: d.employeeCode,
    fullName: d.fullName,
    phone: d.phone,
    hasNationalId: d.hasNationalId,
    hasLicence: d.hasLicence,
    licenceExpiryAt: d.licenceExpiryAt,
    status: d.status,
    employmentType: d.employmentType,
    homeHubId: d.homeHubId,
    defaultVehicleId: d.defaultVehicleId,
    skills: d.skills,
    cashAccountId: d.cashAccountId,
    locale: d.locale,
    deviceId: d.deviceId,
    appVersion: d.appVersion,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}
