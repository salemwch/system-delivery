import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
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
}
