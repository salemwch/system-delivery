import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { RequirePermissions } from "../../identity/index.js";
import { ShiftService } from "../application/shift.service.js";
import type { Shift } from "../domain/schema.js";
import { endShiftSchema, startShiftSchema } from "../domain/dtos.js";

interface ShiftResponse {
  readonly id: string;
  readonly driverId: string;
  readonly vehicleId: string;
  readonly hubId: string | null;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly startOdometer: number | null;
  readonly endOdometer: number | null;
  readonly openingCashMinor: string | null;
  readonly closingCashMinor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

@Controller("v1/shifts")
export class ShiftController {
  constructor(private readonly shifts: ShiftService) {}

  @Post()
  @RequirePermissions("shift:start")
  async start(
    @Body(zodBody(startShiftSchema)) body: z.infer<typeof startShiftSchema>,
  ): Promise<ShiftResponse> {
    const shift = await this.shifts.start(body);
    return toResponse(shift);
  }

  @Post(":id/end")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shift:end")
  async end(
    @Param("id") id: string,
    @Body(zodBody(endShiftSchema)) body: z.infer<typeof endShiftSchema>,
  ): Promise<ShiftResponse> {
    const shift = await this.shifts.end(id, body);
    return toResponse(shift);
  }

  @Get(":id")
  @RequirePermissions("shift:start")
  async getById(@Param("id") id: string): Promise<ShiftResponse> {
    const shift = await this.shifts.getById(id);
    return toResponse(shift);
  }
}

function toResponse(s: Shift): ShiftResponse {
  return {
    id: s.id,
    driverId: s.driverId,
    vehicleId: s.vehicleId,
    hubId: s.hubId,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    startOdometer: s.startOdometer,
    endOdometer: s.endOdometer,
    openingCashMinor: s.openingCashMinor?.toString() ?? null,
    closingCashMinor: s.closingCashMinor?.toString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
