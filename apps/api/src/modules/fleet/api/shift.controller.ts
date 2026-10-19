import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { ShiftService } from "../application/shift.service.js";
import type { ShiftContext } from "../application/shift.service.js";
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

/** The shift caller, with the DRIVER role taken from the signed role claim. */
function shiftCtx(principal: Principal): ShiftContext {
  return { actorUserId: principal.userId, actorIsDriver: principal.roles.includes("DRIVER") };
}

@Controller("v1/shifts")
export class ShiftController {
  constructor(private readonly shifts: ShiftService) {}

  @Post()
  @RequirePermissions("shift:start")
  async start(
    @Body(zodBody(startShiftSchema)) body: z.infer<typeof startShiftSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShiftResponse> {
    const shift = await this.shifts.start(body, shiftCtx(principal));
    return toResponse(shift);
  }

  @Post(":id/end")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("shift:end")
  async end(
    @Param("id") id: string,
    @Body(zodBody(endShiftSchema)) body: z.infer<typeof endShiftSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShiftResponse> {
    const shift = await this.shifts.end(id, body, shiftCtx(principal));
    return toResponse(shift);
  }

  /**
   * The caller's driver id and open shift (or null). Declared before `:id`
   * so "current" is never read as a shift id.
   */
  @Get("current")
  @RequirePermissions("shift:start")
  async current(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly driverId: string; readonly shift: ShiftResponse | null }> {
    const { driverId, shift } = await this.shifts.current(shiftCtx(principal));
    return { driverId, shift: shift === null ? null : toResponse(shift) };
  }

  @Get(":id")
  @RequirePermissions("shift:start")
  async getById(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShiftResponse> {
    const shift = await this.shifts.getById(id, shiftCtx(principal));
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
