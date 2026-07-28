/**
 * Pickup context public API (docs/02-domain-model.md §3.18).
 *
 * Upstream of shipments — how parcels enter the system. Everything other modules
 * may use is exported here; internals stay unreachable.
 */
export { PickupModule } from "./pickup.module.js";
export { PickupService } from "./application/pickup.service.js";
export type {
  PickupRequestPage,
  ListPickupRequestsParams,
  ScanSummary,
  AppliedScan,
  ScanResult,
  ScanItemResult,
  BatchScanResult,
  PickupShipmentView,
  PickupManifest,
} from "./application/pickup.service.js";

export { pickupRequests, pickupShipments } from "./domain/schema.js";
export type {
  PickupRequest,
  NewPickupRequest,
  PickupShipment,
  NewPickupShipment,
} from "./domain/schema.js";

export {
  PICKUP_STATUSES,
  TERMINAL_PICKUP_STATUSES,
  canPickupTransition,
  toPickupStatus,
} from "./domain/pickup-status.js";
export type { PickupStatus } from "./domain/pickup-status.js";

export { formatPickupCode } from "./domain/pickup-code.js";

export { SELECTION_MODES, OUTCOME_REASONS } from "./domain/dtos.js";
export type {
  CreatePickupRequestInput,
  AcceptPickupRequestInput,
  AssignPickupRequestInput,
  CollectPickupRequestInput,
  CompletePickupRequestInput,
  CancelPickupRequestInput,
  ScanPickupInput,
  BatchScanPickupInput,
  SelectionMode,
  OutcomeReason,
} from "./domain/dtos.js";
