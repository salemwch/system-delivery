/**
 * Fleet context public API (docs/04-context-map.md §3.5).
 *
 * Drivers, vehicles, and shifts as a service layer. Driver PII is encrypted at
 * rest and never leaves in a read model; the OPEN shift is the privacy gate for
 * location collection. Everything other modules may use is exported here.
 */
export { FleetModule } from "./fleet.module.js";
export { VehicleService } from "./application/vehicle.service.js";
export { DriverService } from "./application/driver.service.js";
export { ShiftService } from "./application/shift.service.js";

export type { Capacity, VehicleStatus, VehiclePage } from "./application/vehicle.service.js";
export type { DriverView, DriverStatus, DriverPage } from "./application/driver.service.js";

export { vehicles, drivers, shifts } from "./domain/schema.js";
export type { Vehicle, NewVehicle, Driver, NewDriver, Shift, NewShift } from "./domain/schema.js";

export type {
  CreateVehicleInput,
  UpdateVehicleInput,
  ListVehiclesInput,
  CreateDriverInput,
  UpdateDriverInput,
  ListDriversInput,
  ListAvailableInput,
  StartShiftInput,
  EndShiftInput,
} from "./domain/dtos.js";
