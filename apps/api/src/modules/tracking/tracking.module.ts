import { Inject, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import postgres from "postgres";
import type { Sql } from "postgres";

import { AppConfigService } from "../../shared/config/index.js";
import { FleetModule } from "../fleet/index.js";
import { NetworkModule } from "../network/index.js";
import { PlatformModule } from "../platform/index.js";
import { DriverPositionController, TelemetryController } from "./api/telemetry.controller.js";
import { GeofenceMonitor } from "./telemetry/geofence-monitor.js";
import { PresenceService } from "./telemetry/presence.service.js";
import { TelemetryService } from "./telemetry/telemetry.service.js";
import { TelemetryWriter } from "./telemetry/telemetry-writer.js";
import { TELEMETRY_POSTGRES_CLIENT } from "./tracking.tokens.js";

/**
 * Tracking context (docs/04-context-map.md §3.9) — Layer 3.
 *
 * Everything real-time and location: GPS ingest, driver presence, and (in the
 * realtime half) WebSocket fan-out.
 *
 * ⚠️ **This module bridges the telemetry plane and the business plane, and that
 * boundary is its entire reason for existing.** It writes ~40/sec at MVP to
 * ~10,000/sec at Tier 3 through a dedicated connection pool, and emits **only**
 * geofence transitions to the business event bus.
 *
 * ADR-005 keeps it inside `core-api` rather than a Go service at MVP scale, and
 * §3.9 notes it is the module extracted first. Its interface is deliberately
 * narrow so that extraction is reimplementing one endpoint, not untangling
 * business logic — which is why it depends only on platform, fleet, and network.
 */
@Module({
  imports: [PlatformModule, FleetModule, NetworkModule],
  controllers: [TelemetryController, DriverPositionController],
  providers: [
    {
      // The dedicated telemetry pool (ADR-005 requirement 4). Small by design:
      // batched writes need few connections, and capping it is what stops a GPS
      // burst from starving the transactional API.
      provide: TELEMETRY_POSTGRES_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Sql =>
        postgres(config.get("TELEMETRY_DATABASE_URL") ?? config.get("DATABASE_URL"), {
          max: config.get("TELEMETRY_POOL_MAX"),
          prepare: false,
          onnotice: () => undefined,
          connection: {
            application_name: `${config.get("OTEL_SERVICE_NAME")}-telemetry`,
            statement_timeout: config.get("DATABASE_STATEMENT_TIMEOUT_MS"),
          },
        }),
    },
    TelemetryWriter,
    PresenceService,
    GeofenceMonitor,
    TelemetryService,
  ],
  exports: [TelemetryService, PresenceService],
})
export class TrackingModule implements OnApplicationShutdown {
  constructor(
    @Inject(TELEMETRY_POSTGRES_CLIENT) private readonly telemetryClient: Sql,
    private readonly writer: TelemetryWriter,
  ) {}

  /**
   * Drains the buffer before closing the pool.
   *
   * Order matters: flushing after the connections are gone would lose the last
   * second of every driver's trail on every deploy.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.writer.flush();
    await this.telemetryClient.end({ timeout: 5 });
  }
}
