/**
 * Dispatch context public API (docs/04-context-map.md §3.7).
 *
 * Planning work as a service layer: build a route, plan and sequence stops,
 * publish it to a driver, and drive the route + stop lifecycle. Everything other
 * modules may use is exported here; internals stay unreachable.
 */
export { DispatchModule } from "./dispatch.module.js";
export { RouteService } from "./application/route.service.js";
export { AssignmentService } from "./application/assignment.service.js";

export {
  OPTIMIZATION_PROVIDER,
  HeuristicOptimizationProvider,
} from "./application/optimization.provider.js";
export type {
  OptimizationProvider,
  OptimizationRequest,
  OptimizationOutput,
  SolverName,
} from "./application/optimization.provider.js";

export type {
  DispatchContext,
  RouteStopView,
  RoutePlan,
  RoutePage,
  CapacityUtilisation,
  OptimizeResult,
  ManifestView,
  ManifestStop,
  ManifestStopShipment,
} from "./application/route.service.js";
export type { ScoredDriver } from "./application/assignment.service.js";

export { routes, routeStops, optimizationJobs } from "./domain/schema.js";
export type {
  Route,
  NewRoute,
  RouteStop,
  NewRouteStop,
  OptimizationJob,
  NewOptimizationJob,
} from "./domain/schema.js";

export {
  ROUTE_STATUSES,
  ROUTE_STOP_TYPES,
  ROUTE_STOP_STATUSES,
  TERMINAL_ROUTE_STATUSES,
  TERMINAL_STOP_STATUSES,
  canRouteTransition,
  toRouteStatus,
} from "./domain/route-status.js";
export type { RouteStatus, RouteStopType, RouteStopStatus } from "./domain/route-status.js";

export { sequenceStops } from "./domain/sequencer.js";
export type { SequenceablePoint, SequenceOptions, SequenceResult } from "./domain/sequencer.js";

export { formatRouteCode } from "./domain/route-code.js";
export { haversineMetres } from "./domain/geo.js";
export type { LatLng } from "./domain/geo.js";

export type {
  CreateRouteInput,
  AddStopsInput,
  RemoveStopsInput,
  CancelRouteInput,
  ListRoutesInput,
  SuggestDriversInput,
} from "./domain/dtos.js";
