import { Module } from "@nestjs/common";

import { DirectoryModule } from "../directory/index.js";
import { PlatformModule } from "../platform/index.js";
import { GeofenceService } from "./application/geofence.service.js";
import { HubService } from "./application/hub.service.js";
import { ZoneService } from "./application/zone.service.js";

/**
 * Network context (docs/04-context-map.md §3.4) — Layer 1.
 *
 * The physical topology: hubs, zones, and geofences. Depends on `platform` (the
 * outbox for hub.created / zone.updated) and `directory` (address resolution and
 * geocodes). Exposes services rather than controllers at MVP, per contract 05.
 */
@Module({
  imports: [PlatformModule, DirectoryModule],
  providers: [HubService, ZoneService, GeofenceService],
  exports: [HubService, ZoneService, GeofenceService],
})
export class NetworkModule {}
