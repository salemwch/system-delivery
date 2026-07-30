import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { PresenceService } from "../telemetry/presence.service.js";
import { TelemetryService } from "../telemetry/telemetry.service.js";
import { ingestTelemetrySchema } from "../domain/dtos.js";

interface IngestResponse {
  readonly accepted: number;
  readonly rejected: number;
  readonly serverTime: string;
}

interface PositionResponse {
  readonly driverId: string;
  readonly lat: number;
  readonly lon: number;
  readonly hdg: number | null;
  readonly spd: number | null;
  readonly bat: number | null;
  readonly at: string;
}

/**
 * GPS telemetry ingest (docs/05-api-contracts.md §5).
 *
 * ⚠️ This is the highest-volume endpoint in the system — ~40 requests/sec at
 * MVP, ~10,000 positions/sec at Tier 3. It is also the first thing ADR-005
 * extracts to Go. Both facts push the same way: keep it thin, keep it
 * versioned, and keep the contract stable enough that reimplementing it
 * elsewhere is a transport change rather than a rewrite.
 */
@Controller("v1/telemetry")
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  /**
   * Accepts a batch of positions.
   *
   * `202 Accepted`, not `201`: the positions are buffered, not yet durable. That
   * is the honest status code, and waiting for the flush would hold a phone's
   * connection open for a guarantee a GPS sample does not need.
   *
   * The driver id comes from the authenticated principal, never the body — a
   * driver reporting positions "for" another driver is not a feature.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions("telemetry:write")
  async ingest(
    @Body(zodBody(ingestTelemetrySchema)) body: z.infer<typeof ingestTelemetrySchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IngestResponse> {
    // The USER id. The service resolves the driver from it in the same query as
    // the shift gate — a user id is not a driver id, and passing one where the
    // other was expected made every real driver's upload fail.
    const result = await this.telemetry.ingestBatch(body, { userId: principal.userId });
    return {
      accepted: result.accepted,
      rejected: result.rejected,
      serverTime: result.serverTime.toISOString(),
    };
  }
}

/**
 * Live driver positions for the dispatcher board.
 *
 * Reads Valkey, never the hypertable (docs/06 §5.3). Separate permission from
 * ingest: seeing where every driver is, is a supervisory capability, while
 * reporting your own position is a driver one.
 */
@Controller("v1/drivers")
export class DriverPositionController {
  constructor(private readonly presence: PresenceService) {}

  @Get("positions/live")
  @RequirePermissions("driver:location:read_live")
  async live(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ data: readonly PositionResponse[] }> {
    const driverIds = await this.presence.onlineDrivers(principal.tenantId);
    const positions = await this.presence.lastKnownMany(principal.tenantId, driverIds);
    return { data: positions.map(toResponse) };
  }

  @Get(":driverId/position")
  @RequirePermissions("driver:location:read_live")
  async one(
    @Param("driverId") driverId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PositionResponse | null> {
    const position = await this.presence.lastKnown(principal.tenantId, driverId);
    return position === null ? null : toResponse(position);
  }
}

function toResponse(p: {
  driverId: string;
  lat: number;
  lon: number;
  headingDeg: number | null;
  speedMps: number | null;
  batteryPct: number | null;
  at: Date;
}): PositionResponse {
  return {
    driverId: p.driverId,
    lat: p.lat,
    lon: p.lon,
    hdg: p.headingDeg,
    spd: p.speedMps,
    bat: p.batteryPct,
    at: p.at.toISOString(),
  };
}
