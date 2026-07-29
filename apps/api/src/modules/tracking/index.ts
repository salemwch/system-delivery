/**
 * Tracking context public API (docs/04-context-map.md §3.9).
 *
 * Telemetry ingest, driver presence, and geofence detection — the bridge between
 * the telemetry plane and the business plane. Everything other modules may use
 * is exported here; internals stay unreachable.
 */
export { TrackingModule } from "./tracking.module.js";
export { TelemetryService } from "./telemetry/telemetry.service.js";
export { PresenceService } from "./telemetry/presence.service.js";

export type { IngestResult, RejectionReason } from "./telemetry/telemetry.service.js";
export type { LastKnownPosition } from "./telemetry/presence.service.js";

export { driverPositions } from "./domain/schema.js";
export type { DriverPosition, NewDriverPosition } from "./domain/schema.js";

export { POSITION_SOURCES } from "./domain/dtos.js";
export type { PositionSource, PositionInput, IngestTelemetryInput } from "./domain/dtos.js";

export { RealtimeGateway } from "./realtime/realtime.gateway.js";
export { registerRealtime } from "./realtime/realtime.plugin.js";
export { RealtimeConnection } from "./realtime/realtime-connection.js";
export type { Socket, DriverPositionUpdate } from "./realtime/realtime-connection.js";
export { withinBbox, clientMessageSchema } from "./realtime/protocol.js";
export type {
  Bbox,
  ClientMessage,
  ServerMessage,
  PositionFrameEntry,
} from "./realtime/protocol.js";
