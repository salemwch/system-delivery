import { Body, Controller, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import type { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { DriverSyncService } from "../application/driver-sync.service.js";
import type { SyncResult } from "../application/driver-sync.service.js";
import { driverSyncSchema } from "../domain/sync-dtos.js";

/**
 * `POST /v1/drivers/me/sync`: the offline driver app drains its queue and
 * learns what changed (docs/05 §5).
 *
 * Always `200` with one result per item, whatever happened to each: a batch
 * is never all-or-nothing (docs/08 §8.1). Only a malformed envelope is a 400.
 *
 * `route:read` gates the call (every driver holds it); each item is then
 * checked against the permission of the command it replays, exactly as the
 * online route would be. A non-driver account is a 403: it has no device
 * queue to drain.
 */
@Controller("v1/drivers/me")
export class DriverSyncController {
  constructor(private readonly sync: DriverSyncService) {}

  @Post("sync")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:read")
  async drain(
    @Body(zodBody(driverSyncSchema)) body: z.infer<typeof driverSyncSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SyncResult> {
    return this.sync.sync(body, principal);
  }

  /** The driver starts their own published route (docs/03 route.started). */
  @Post("routes/:id/start")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:drive")
  async startRoute(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly id: string; readonly status: string }> {
    const route = await this.sync.startRoute(id, principal);
    return { id: route.id, status: route.status };
  }

  /** The driver completes their own route; every stop must be settled first. */
  @Post("routes/:id/complete")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:drive")
  async completeRoute(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly id: string; readonly status: string }> {
    const route = await this.sync.completeRoute(id, principal);
    return { id: route.id, status: route.status };
  }
}
