/**
 * Network context public API (docs/04-context-map.md §3.4).
 *
 * The physical topology as a service layer: hubs (facilities + resolveForAddress),
 * zones (territory containment), and geofences (pure in-memory arrival detection).
 * Everything other modules may use is exported here; internals stay unreachable.
 */
export { NetworkModule } from "./network.module.js";
export { HubService } from "./application/hub.service.js";
export { ZoneService } from "./application/zone.service.js";
export { GeofenceService } from "./application/geofence.service.js";

export type { HubView, HubPage } from "./application/hub.service.js";
export type { ZoneView, ZonePage } from "./application/zone.service.js";
export type { GeofenceView } from "./application/geofence.service.js";

export { evaluateGeofences, isInside } from "./domain/geofence-eval.js";
export type {
  CircleGeofence,
  GeofenceEvaluation,
  GeofenceTransition,
} from "./domain/geofence-eval.js";
export type { LatLng } from "./domain/geo.js";

export { hubs, zones, geofences } from "./domain/schema.js";
export type { Hub, NewHub, Zone, NewZone, Geofence, NewGeofence } from "./domain/schema.js";

export type {
  CreateHubInput,
  UpdateHubInput,
  ListHubsInput,
  CreateZoneInput,
  UpdateZoneInput,
  ListZonesInput,
  CreateGeofenceInput,
} from "./domain/dtos.js";
