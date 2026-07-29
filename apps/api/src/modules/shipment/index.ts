/**
 * Shipment context public API (docs/04-context-map.md §3.5).
 *
 * The core aggregate as a service layer: create a shipment (composing directory),
 * record custody events through the state machine, and read the immutable ledger.
 * Everything other modules may use is exported here; internals stay unreachable.
 */

/**
 * Retained for tools/verify-lint-rules.mjs, whose `platform -> shipment` fixture
 * imports this symbol to prove the upward-dependency boundary rule rejects a
 * layer violation. Removing it would silently disable that check.
 */
export const SHIPMENT_MODULE = "shipment" as const;

export { ShipmentModule } from "./shipment.module.js";
export { ShipmentService } from "./application/shipment.service.js";
export { ShipmentEventService } from "./application/shipment-event.service.js";
export { LabelService } from "./application/label.service.js";
export type { ShipmentLabel } from "./application/label.service.js";
export { PickupScanEventHandler } from "./application/pickup-scan-event.handler.js";

export type {
  CommandContext,
  ShipmentPage,
  ShipmentEventView,
  PlanningLeg,
} from "./application/shipment.service.js";
export type {
  ShipmentSnapshot,
  AppendEventParams,
  AppendResult,
} from "./application/shipment-event.service.js";

export { shipments, shipmentLegs, shipmentEvents, pod } from "./domain/schema.js";
export type {
  Shipment,
  NewShipment,
  ShipmentLeg,
  NewShipmentLeg,
  ShipmentEvent,
  NewShipmentEvent,
  Pod,
  NewPod,
} from "./domain/schema.js";

export {
  SHIPMENT_STATUSES,
  SHIPMENT_EVENT_TYPES,
  TERMINAL_STATUSES,
  checkTransition,
  targetStatusFor,
  outboxEventName,
  isInCustody,
  toShipmentStatus,
} from "./domain/shipment-status.js";
export type {
  ShipmentStatus,
  ShipmentEventType,
  ActorType,
  CustodyType,
  CodStatus,
  EventActor,
  TransitionCheck,
} from "./domain/shipment-status.js";

export type {
  CreateShipmentInput,
  RecordPickupInput,
  ConfirmDeliveryInput,
  RecordFailedAttemptInput,
  InitiateReturnInput,
  CancelShipmentInput,
  RecordEventInput,
  ListShipmentsInput,
} from "./domain/dtos.js";
