import { Module } from "@nestjs/common";

import { NetworkModule } from "../network/index.js";
import { PlatformModule } from "../platform/index.js";
import { DriverService } from "./application/driver.service.js";
import { ShiftService } from "./application/shift.service.js";
import { VehicleService } from "./application/vehicle.service.js";

/**
 * Fleet context (docs/04-context-map.md §3.5) — Layer 1.
 *
 * The people and vehicles that execute work, and the shift that gates location
 * collection. Depends on `platform` (outbox) and `network` (home-hub validation);
 * the shared `CryptoModule` (global) supplies the `FIELD_CIPHER` that encrypts
 * driver PII. Exposes services rather than controllers at MVP, per contract 05.
 */
@Module({
  imports: [PlatformModule, NetworkModule],
  providers: [VehicleService, DriverService, ShiftService],
  exports: [VehicleService, DriverService, ShiftService],
})
export class FleetModule {}
