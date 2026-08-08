import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";

import { AddressService } from "../../directory/index.js";
import { DriverService, VehicleService } from "../../fleet/index.js";
import type { Capacity } from "../../fleet/index.js";
import { HubService } from "../../network/index.js";
import { FeatureService, OutboxService } from "../../platform/index.js";
import { ShipmentService, checkTransition } from "../../shipment/index.js";
import type { EventActor, PlanningLeg } from "../../shipment/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { asTenantId } from "../../../shared/database/tenant-context.js";
import {
  addStopsSchema,
  cancelRouteSchema,
  createRouteSchema,
  listRoutesSchema,
  removeStopsSchema,
} from "../domain/dtos.js";
import { haversineMetres } from "../domain/geo.js";
import type { LatLng } from "../domain/geo.js";
import { formatRouteCode } from "../domain/route-code.js";
import { canRouteTransition, toRouteStatus } from "../domain/route-status.js";
import type { RouteStatus, RouteStopStatus, RouteStopType } from "../domain/route-status.js";
import { optimizationJobs, routeStops, routes } from "../domain/schema.js";
import type { Route } from "../domain/schema.js";
import { OPTIMIZATION_PROVIDER } from "./optimization.provider.js";
import type { OptimizationProvider } from "./optimization.provider.js";

/** The authenticated context a dispatch command runs under. Never from the body. */
export interface DispatchContext {
  readonly actor: EventActor;
}

/** A route stop flattened with its coordinates resolved out of PostGIS. */
export interface RouteStopView {
  readonly id: string;
  readonly routeId: string;
  readonly sequence: number;
  readonly type: RouteStopType;
  readonly status: RouteStopStatus;
  readonly locked: boolean;
  readonly addressId: string | null;
  readonly hubId: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly plannedArrivalAt: Date | null;
  readonly serviceDurationS: number;
  readonly legIds: string[];
  readonly failureReason: string | null;
}

/** Planned load vs the assigned vehicle's envelope (null when no vehicle yet). */
export interface CapacityUtilisation {
  readonly parcels: number;
  readonly weightGrams: number;
  readonly volumeCm3: number;
  readonly capacity: Capacity | null;
}

export interface RoutePlan {
  readonly route: Route;
  readonly stops: RouteStopView[];
  readonly capacity: CapacityUtilisation;
}

export interface OptimizeResult {
  readonly routeId: string;
  readonly jobId: string;
  readonly stopCount: number;
  readonly plannedDistanceM: number;
  readonly plannedDurationS: number;
  readonly solver: string;
  readonly solveDurationMs: number;
  readonly usedFallback: boolean;
  readonly sequence: { readonly routeStopId: string; readonly sequence: number }[];
}

export interface RoutePage {
  readonly items: Route[];
  readonly nextCursor: string | null;
}

export interface ManifestStopShipment {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly parcelCount: number;
  readonly codAmountMinor: bigint;
  readonly currency: string;
}

export interface ManifestStop {
  readonly id: string;
  readonly sequence: number;
  readonly type: RouteStopType;
  readonly status: RouteStopStatus;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly plannedArrivalAt: Date | null;
  readonly address: {
    line1: string | null;
    city: string | null;
    accessNotes: string | null;
  } | null;
  readonly shipments: ManifestStopShipment[];
}

export interface ManifestView {
  readonly routeId: string;
  readonly code: string;
  readonly status: RouteStatus;
  readonly plannedDate: string;
  readonly driverId: string | null;
  readonly vehicleId: string | null;
  readonly summary: {
    readonly stopsTotal: number;
    readonly stopsCompleted: number;
    readonly codExpectedMinor: bigint;
  };
  readonly stops: ManifestStop[];
}

/** What a leg resolves to on the ground — the actionable stop for the driver. */
interface StopTarget {
  readonly type: RouteStopType;
  readonly addressId: string | null;
  readonly hubId: string | null;
  readonly location: LatLng;
}

const DEFAULT_PAGE_SIZE = 50;
const CODE_ALLOCATION_RETRIES = 5;
/** ~30 km/h — the same urban default the fallback sequencer uses, for planned ETAs. */
const PLANNING_SPEED_MPS = 8.333;

/** A geography point literal for INSERT — lng first, per PostGIS. */
function pointOf(coordinates: LatLng) {
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.lng}, ${coordinates.lat}), 4326)::geography`;
}

/**
 * Dispatch — planning work: which driver, which vehicle, which order
 * (docs/02-domain-model.md §3.9–3.10, docs/04-context-map.md §3.7, Layer 2).
 *
 * The single sanctioned same-layer caller of `shipment` (context-map §2.1):
 * assignment and out-for-delivery transitions are recorded through
 * {@link ShipmentService.recordEvent}, GUARDED by the shipment state machine
 * ({@link checkTransition}) — dispatch never writes shipment state itself, and a
 * transition the machine forbids is simply not attempted. Route stops reference
 * shipment legs by ID, so sequencing a route locks no shipment rows.
 *
 * Optimisation goes through the {@link OptimizationProvider} port; at MVP the
 * deterministic haversine fallback is the only binding (ADR-003).
 */
@Injectable()
export class RouteService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly features: FeatureService,
    @Inject(OPTIMIZATION_PROVIDER) private readonly optimizer: OptimizationProvider,
    private readonly shipments: ShipmentService,
    private readonly vehicles: VehicleService,
    private readonly drivers: DriverService,
    private readonly hubs: HubService,
    private readonly addresses: AddressService,
  ) {}

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(input: unknown): Promise<Route> {
    const dto = parseWithZod(createRouteSchema, input);

    // Validate references up front (clear 404s, not opaque FK errors).
    if (dto.driverId !== undefined) {
      await this.drivers.getById(dto.driverId);
    }
    if (dto.vehicleId !== undefined) {
      await this.vehicles.getById(dto.vehicleId);
    }
    if (dto.startHubId !== undefined) {
      await this.hubs.getById(dto.startHubId);
    }
    if (dto.endHubId !== undefined) {
      await this.hubs.getById(dto.endHubId);
    }

    // The route code is a per-tenant, per-day ordinal; a unique-violation retry
    // resolves two dispatchers allocating the day's Nth code at the same instant.
    for (let attempt = 0; attempt < CODE_ALLOCATION_RETRIES; attempt++) {
      try {
        return await this.database.withTenant(async (tx) => {
          const tenantId = TenantContext.requireTenantId();
          const ordinal = await this.nextOrdinal(tx, dto.plannedDate);
          const code = formatRouteCode(dto.plannedDate, ordinal);
          const rows = await tx
            .insert(routes)
            .values({
              tenantId,
              code,
              plannedDate: dto.plannedDate,
              status: "DRAFT",
              ...(dto.driverId === undefined ? {} : { driverId: dto.driverId }),
              ...(dto.vehicleId === undefined ? {} : { vehicleId: dto.vehicleId }),
              ...(dto.startHubId === undefined ? {} : { startHubId: dto.startHubId }),
              ...(dto.endHubId === undefined ? {} : { endHubId: dto.endHubId }),
              ...(dto.plannedStartAt === undefined ? {} : { plannedStartAt: dto.plannedStartAt }),
            })
            .returning();
          return requireRow(rows, "Route");
        });
      } catch (error) {
        if (isUniqueViolation(error, "routes_tenant_code_uq")) {
          continue; // another route took this ordinal; recompute and retry
        }
        throw error;
      }
    }
    throw new ConflictError(
      "ROUTE_CODE_ALLOCATION_FAILED",
      "Could not allocate a unique route code; please retry.",
    );
  }

  // ── Plan stops ───────────────────────────────────────────────────────────────

  async addStops(routeId: string, input: unknown): Promise<RoutePlan> {
    const dto = parseWithZod(addStopsSchema, input);
    const route = await this.getById(routeId);
    assertDraft(route);

    const legs = await this.shipments.getLegsForPlanning(dto.legIds);
    assertAllLegsFound(dto.legIds, legs);

    // Resolve each leg to a physical stop target (reads via other services, done
    // before the write transaction so it opens no nested transactions).
    const targets = new Map<string, StopTarget>();
    for (const leg of legs) {
      targets.set(leg.legId, await this.targetForLeg(leg));
    }

    await this.database.withTenant(async (tx) => {
      await this.assertLegsNotPlannedElsewhere(tx, routeId, dto.legIds);

      const existing = await tx
        .select()
        .from(routeStops)
        .where(eq(routeStops.routeId, routeId))
        .orderBy(asc(routeStops.sequence));

      // Group incoming legs by their target so several parcels to one building
      // become one stop (domain §3.10). Merge into an existing stop when present.
      const byGroup = new Map<string, string[]>();
      for (const leg of legs) {
        const target = requireTarget(targets, leg.legId);
        const key = groupKey(target);
        const bucket = byGroup.get(key) ?? [];
        bucket.push(leg.legId);
        byGroup.set(key, bucket);
      }

      const tenantId = TenantContext.requireTenantId();
      let nextSequence = existing.length;
      for (const [key, newLegIds] of byGroup) {
        const target = requireTarget(targets, requireFirst(newLegIds));
        const match = existing.find((s) => stopGroupKey(s) === key);
        if (match !== undefined) {
          const merged = unique([...match.legIds, ...newLegIds]);
          await tx
            .update(routeStops)
            .set({ legIds: merged, updatedAt: sql`now()` })
            .where(eq(routeStops.id, match.id));
        } else {
          await tx.insert(routeStops).values({
            tenantId,
            routeId,
            sequence: nextSequence,
            type: target.type,
            location: pointOf(target.location),
            legIds: unique(newLegIds),
            ...(target.addressId === null ? {} : { addressId: target.addressId }),
            ...(target.hubId === null ? {} : { hubId: target.hubId }),
          });
          nextSequence++;
        }
      }

      await this.refreshStopCount(tx, routeId);
    });

    return this.plan(routeId);
  }

  async removeStops(routeId: string, input: unknown): Promise<RoutePlan> {
    const dto = parseWithZod(removeStopsSchema, input);
    const route = await this.getById(routeId);
    assertDraft(route);

    await this.database.withTenant(async (tx) => {
      await tx
        .delete(routeStops)
        .where(and(eq(routeStops.routeId, routeId), inArray(routeStops.id, [...dto.stopIds])));
      // Re-pack sequences to stay contiguous from 0 (domain §3.10 rule 1). The
      // DEFERRABLE unique lets us rewrite them all before the commit-time check.
      const remaining = await tx
        .select({ id: routeStops.id })
        .from(routeStops)
        .where(eq(routeStops.routeId, routeId))
        .orderBy(asc(routeStops.sequence));
      for (let i = 0; i < remaining.length; i++) {
        const row = remaining[i];
        if (row === undefined) {
          continue;
        }
        await tx
          .update(routeStops)
          .set({ sequence: i, updatedAt: sql`now()` })
          .where(eq(routeStops.id, row.id));
      }
      await this.refreshStopCount(tx, routeId);
    });

    return this.plan(routeId);
  }

  // ── Optimise ───────────────────────────────────────────────────────────────

  async optimize(routeId: string, ctx: DispatchContext): Promise<OptimizeResult> {
    const route = await this.getById(routeId);
    assertDraft(route);

    const tenantId = asTenantId(route.tenantId);
    const enabled = await this.features.isEnabled(tenantId, "ROUTE_OPTIMIZATION_ENABLED");

    const stops = await this.selectStops(routeId);
    const sequenceable = stops.filter(
      (s): s is RouteStopView & { latitude: number; longitude: number } =>
        s.latitude !== null && s.longitude !== null,
    );

    const start = await this.startLocation(route);

    // Feature-gated: when off, keep the dispatcher's manual order (solver MANUAL)
    // and still record the plan distance over that order, so the metrics and the
    // route.optimized contract hold either way (docs/05 §4).
    const output = enabled
      ? await this.optimizer.optimize({
          points: sequenceable.map((s) => ({
            id: s.id,
            location: { lat: s.latitude, lng: s.longitude },
          })),
          ...(start === null ? {} : { start }),
        })
      : manualOrder(sequenceable, start);

    const ordered = orderStops(sequenceable, output.order);
    const arrivals = computeArrivals(ordered, start, route.plannedStartAt);
    const serviceTotal = ordered.reduce((sum, s) => sum + s.serviceDurationS, 0);
    const plannedDurationS = output.durationS + serviceTotal;

    const jobId = await this.database.withTenant(async (tx) => {
      // Rewrite the sequence + planned arrival for every stop (DEFERRABLE unique).
      for (let i = 0; i < ordered.length; i++) {
        const s = ordered[i];
        if (s === undefined) {
          continue;
        }
        const arrival = arrivals[i] ?? null;
        await tx
          .update(routeStops)
          .set({
            sequence: i,
            updatedAt: sql`now()`,
            ...(arrival === null ? {} : { plannedArrivalAt: arrival }),
          })
          .where(eq(routeStops.id, s.id));
      }

      const jobRows = await tx
        .insert(optimizationJobs)
        .values({
          tenantId: route.tenantId,
          routeId,
          status: "SUCCEEDED",
          solver: enabled ? output.solver : "MANUAL",
          usedFallback: enabled ? output.usedFallback : false,
          solveDurationMs: output.solveDurationMs,
          plannedDistanceM: output.distanceM,
          plannedDurationS,
          stopCount: ordered.length,
          completedAt: sql`now()`,
          ...(ctx.actor.actorId === undefined ? {} : { requestedByUserId: ctx.actor.actorId }),
        })
        .returning({ id: optimizationJobs.id });
      const job = jobRows[0];
      if (job === undefined) {
        throw new Error("Optimization job insert returned no row");
      }

      await tx
        .update(routes)
        .set({
          plannedDistanceM: output.distanceM,
          plannedDurationS,
          optimizationJobId: job.id,
          updatedAt: sql`now()`,
        })
        .where(eq(routes.id, routeId));

      await this.outbox.publish(tx, {
        eventType: "route.optimized",
        aggregateType: "route",
        aggregateId: routeId,
        payload: {
          routeId,
          jobId: job.id,
          stopCount: ordered.length,
          plannedDistanceM: output.distanceM,
          plannedDurationS,
          solver: enabled ? output.solver : "MANUAL",
          solveDurationMs: output.solveDurationMs,
          usedFallback: enabled ? output.usedFallback : false,
          constraintsViolated: [],
        },
      });

      return job.id;
    });

    return {
      routeId,
      jobId,
      stopCount: ordered.length,
      plannedDistanceM: output.distanceM,
      plannedDurationS,
      solver: enabled ? output.solver : "MANUAL",
      solveDurationMs: output.solveDurationMs,
      usedFallback: enabled ? output.usedFallback : false,
      sequence: ordered.map((s, i) => ({ routeStopId: s.id, sequence: i })),
    };
  }

  // ── Publish ────────────────────────────────────────────────────────────────

  async publish(routeId: string, ctx: DispatchContext): Promise<Route> {
    const route = await this.getById(routeId);
    if (!canRouteTransition(toRouteStatus(route.status), "PUBLISHED")) {
      throw notDraft(route);
    }
    if (route.driverId === null || route.vehicleId === null) {
      throw new BusinessRuleError(
        "ROUTE_NOT_ASSIGNABLE",
        "A route needs a driver and a vehicle before it can be published.",
      );
    }
    const driverId = route.driverId;
    const vehicleId = route.vehicleId;

    const stops = await this.selectStops(routeId);
    const allLegIds = unique(stops.flatMap((s) => s.legIds));
    const legs = await this.shipments.getLegsForPlanning(allLegIds);

    await this.assertCapacity(vehicleId, legs);
    await this.assertSkills(driverId, legs);
    await this.assertDriverFree(driverId);

    const legToStop = new Map<string, string>();
    for (const stop of stops) {
      for (const legId of stop.legIds) {
        legToStop.set(legId, stop.id);
      }
    }

    // Record shipment.assigned FIRST (each its own idempotent transaction), so a
    // partial failure leaves the route DRAFT and the whole publish is retryable —
    // already-assigned legs replay as clean no-ops. Only legs whose shipment the
    // state machine currently permits to become ASSIGNED are transitioned; a
    // shipment already in custody on a later-leg route keeps its status.
    for (const leg of legs) {
      if (checkTransition(leg.shipmentStatus, "assigned").kind !== "allowed") {
        continue;
      }
      const stopId = legToStop.get(leg.legId);
      if (stopId === undefined) {
        continue;
      }
      await this.shipments.recordEvent(
        leg.shipmentId,
        {
          eventType: "assigned",
          legId: leg.legId,
          routeId,
          routeStopId: stopId,
          driverId,
          idempotencyKey: `assign:${stopId}:${leg.legId}`,
          payload: {
            vehicleId,
            assignmentMode: "MANUAL",
            assignedByUserId: ctx.actor.actorId ?? null,
          },
        },
        { actor: ctx.actor },
      );
    }

    const cod = summariseCod(legs);
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(routes)
        .set({ status: "PUBLISHED", publishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(routes.id, routeId))
        .returning();
      const updated = requireRow(rows, "Route");

      await tx
        .update(routeStops)
        .set({ locked: true, updatedAt: sql`now()` })
        .where(eq(routeStops.routeId, routeId));

      await this.outbox.publish(tx, {
        eventType: "route.published",
        aggregateType: "route",
        aggregateId: routeId,
        payload: {
          routeId,
          routeCode: updated.code,
          driverId,
          vehicleId,
          plannedDate: updated.plannedDate,
          startHubId: updated.startHubId,
          stopCount: stops.length,
          shipmentCount: cod.shipmentCount,
          codShipmentCount: cod.codShipmentCount,
          totalCodAmountMinor: cod.totalMinor.toString(),
          currency: cod.currency,
          plannedStartAt: updated.plannedStartAt?.toISOString() ?? null,
          publishedByUserId: ctx.actor.actorId ?? null,
        },
      });

      return updated;
    });
  }

  // ── Start / complete / cancel ────────────────────────────────────────────────

  async start(routeId: string, ctx: DispatchContext): Promise<Route> {
    const route = await this.getById(routeId);
    if (!canRouteTransition(toRouteStatus(route.status), "IN_PROGRESS")) {
      throw new BusinessRuleError(
        "ROUTE_NOT_STARTABLE",
        `A ${route.status} route cannot be started; only a PUBLISHED route can.`,
      );
    }
    const driverId = route.driverId;

    const updated = await this.database
      .withTenant(async (tx) => {
        const rows = await tx
          .update(routes)
          .set({ status: "IN_PROGRESS", actualStartAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(routes.id, routeId))
          .returning();
        const row = requireRow(rows, "Route");
        await this.outbox.publish(tx, {
          eventType: "route.started",
          aggregateType: "route",
          aggregateId: routeId,
          payload: { routeId, driverId, occurredAt: new Date().toISOString() },
        });
        return row;
      })
      .catch((error: unknown) => {
        // The partial unique index enforces at most one IN_PROGRESS route per
        // driver (I8); surface it as a clear conflict, not a raw DB error.
        if (isUniqueViolation(error, "routes_one_in_progress_per_driver_uq")) {
          throw new ConflictError(
            "DRIVER_ROUTE_IN_PROGRESS",
            "This driver already has a route in progress.",
          );
        }
        throw error;
      });

    // Departing with the parcels aboard is out-for-delivery — but only for legs
    // whose shipment is already in custody (PICKED_UP / AT_HUB). A just-assigned
    // shipment must be picked up first; the state-machine guard enforces that.
    if (driverId !== null) {
      const stops = await this.selectStops(routeId);
      const legs = await this.shipments.getLegsForPlanning(unique(stops.flatMap((s) => s.legIds)));
      const legToStop = new Map<string, string>();
      for (const stop of stops) {
        for (const legId of stop.legIds) {
          legToStop.set(legId, stop.id);
        }
      }
      for (const leg of legs) {
        if (checkTransition(leg.shipmentStatus, "out_for_delivery").kind !== "allowed") {
          continue;
        }
        const stopId = legToStop.get(leg.legId);
        await this.shipments.recordEvent(
          leg.shipmentId,
          {
            eventType: "out_for_delivery",
            legId: leg.legId,
            routeId,
            driverId,
            ...(stopId === undefined ? {} : { routeStopId: stopId }),
            idempotencyKey: `ofd:${routeId}:${leg.legId}`,
            // Self-contained per event-storming §2.2: the notification consumer
            // needs recipient contact + tracking number to SMS the customer (P3),
            // and it must not import shipment — so the event carries them.
            payload: {
              routeId,
              driverId,
              trackingNumber: leg.trackingNumber,
              recipientName: leg.recipientName,
              recipientPhone: leg.recipientPhone,
            },
          },
          { actor: ctx.actor },
        );
      }
    }

    return updated;
  }

  async complete(routeId: string): Promise<Route> {
    const route = await this.getById(routeId);
    if (!canRouteTransition(toRouteStatus(route.status), "COMPLETED")) {
      throw new BusinessRuleError(
        "ROUTE_NOT_COMPLETABLE",
        `A ${route.status} route cannot be completed; only an IN_PROGRESS route can.`,
      );
    }
    const stops = await this.selectStops(routeId);
    const open = stops.filter((s) => !isTerminalStop(s.status));
    if (open.length > 0) {
      throw new BusinessRuleError(
        "ROUTE_HAS_OPEN_STOPS",
        `Every stop must be completed, failed, or skipped first (${open.length} still open).`,
      );
    }
    const tally = tallyStops(stops);

    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(routes)
        .set({ status: "COMPLETED", actualEndAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(routes.id, routeId))
        .returning();
      const updated = requireRow(rows, "Route");
      await this.outbox.publish(tx, {
        eventType: "route.completed",
        aggregateType: "route",
        aggregateId: routeId,
        payload: {
          routeId,
          driverId: updated.driverId,
          stopsCompleted: tally.completed,
          stopsFailed: tally.failed,
          stopsSkipped: tally.skipped,
          occurredAt: new Date().toISOString(),
        },
      });
      return updated;
    });
  }

  async cancel(routeId: string, input: unknown): Promise<Route> {
    parseWithZod(cancelRouteSchema, input);
    const route = await this.getById(routeId);
    if (!canRouteTransition(toRouteStatus(route.status), "CANCELLED")) {
      throw new BusinessRuleError("ROUTE_TERMINAL", `A ${route.status} route cannot be cancelled.`);
    }
    // Incomplete stops return to the unassigned pool (domain §3.9 rule 5): the
    // route becomes CANCELLED, and addStops on another route no longer sees these
    // legs as planned (its conflict check excludes CANCELLED routes). Shipments
    // stay as they are — re-adding to a new route replays `assigned`, which the
    // state machine permits (ASSIGNED → ASSIGNED).
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(routes)
        .set({ status: "CANCELLED", updatedAt: sql`now()` })
        .where(eq(routes.id, routeId))
        .returning();
      return requireRow(rows, "Route");
    });
  }

  // ── Stop outcomes (driver operations dispatch owns) ──────────────────────────

  /** Marks a stop ARRIVED and emits `stop.arrived` (geofence or driver confirm). */
  async arriveAtStop(stopId: string): Promise<RouteStopView> {
    return this.transitionStop(stopId, "ARRIVED", { emit: "stop.arrived" });
  }

  /**
   * Resolves a stop as COMPLETED/FAILED/SKIPPED. SKIPPED/FAILED require a reason
   * (domain §3.10 rule 6) and raise a dispatcher exception via `stop.completed`.
   */
  async resolveStop(
    stopId: string,
    outcome: "COMPLETED" | "FAILED" | "SKIPPED",
    reason?: string,
  ): Promise<RouteStopView> {
    if (
      (outcome === "FAILED" || outcome === "SKIPPED") &&
      (reason === undefined || reason.trim() === "")
    ) {
      throw new BusinessRuleError("STOP_REASON_REQUIRED", `A ${outcome} stop requires a reason.`);
    }
    return this.transitionStop(stopId, outcome, {
      emit: "stop.completed",
      ...(reason === undefined ? {} : { reason }),
    });
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<Route> {
    return this.database.withTenant(async (tx) => this.requireRoute(tx, id));
  }

  async list(input: unknown = {}): Promise<RoutePage> {
    const dto = parseWithZod(listRoutesSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(dto.status === undefined ? [] : [eq(routes.status, dto.status)]),
        ...(dto.driverId === undefined ? [] : [eq(routes.driverId, dto.driverId)]),
        ...(dto.plannedDate === undefined ? [] : [eq(routes.plannedDate, dto.plannedDate)]),
        ...(dto.cursor === undefined ? [] : [lt(routes.id, dto.cursor)]),
      ];
      const rows = await tx
        .select()
        .from(routes)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(routes.id))
        .limit(limit + 1);
      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  async getStops(routeId: string): Promise<RouteStopView[]> {
    await this.getById(routeId); // 404 if absent / other tenant
    return this.selectStops(routeId);
  }

  /** The driver's day — the single payload the app caches for offline operation. */
  async getManifest(routeId: string): Promise<ManifestView> {
    const route = await this.getById(routeId);
    const stops = await this.selectStops(routeId);
    const legs = await this.shipments.getLegsForPlanning(unique(stops.flatMap((s) => s.legIds)));
    const legById = new Map<string, PlanningLeg>(legs.map((l) => [l.legId, l]));

    const addressIds = unique(
      stops.map((s) => s.addressId).filter((id): id is string => id !== null),
    );
    const addressById = new Map<
      string,
      { line1: string | null; city: string | null; accessNotes: string | null }
    >();
    for (const addressId of addressIds) {
      const a = await this.addresses.getById(addressId);
      addressById.set(addressId, {
        line1: a.normalisedLine1,
        city: a.city,
        accessNotes: a.accessNotes,
      });
    }

    let codExpected = 0n;
    const seenShipments = new Set<string>();
    const manifestStops: ManifestStop[] = stops.map((stop) => {
      const shipmentMap = new Map<string, ManifestStopShipment>();
      for (const legId of stop.legIds) {
        const leg = legById.get(legId);
        if (leg === undefined) {
          continue;
        }
        if (!shipmentMap.has(leg.shipmentId)) {
          shipmentMap.set(leg.shipmentId, {
            shipmentId: leg.shipmentId,
            trackingNumber: leg.trackingNumber,
            recipientName: leg.recipientName,
            recipientPhone: leg.recipientPhone,
            parcelCount: leg.parcelCount,
            codAmountMinor: leg.codAmountMinor,
            currency: leg.currency,
          });
          if (!seenShipments.has(leg.shipmentId)) {
            seenShipments.add(leg.shipmentId);
            codExpected += leg.codAmountMinor;
          }
        }
      }
      return {
        id: stop.id,
        sequence: stop.sequence,
        type: stop.type,
        status: stop.status,
        latitude: stop.latitude,
        longitude: stop.longitude,
        plannedArrivalAt: stop.plannedArrivalAt,
        address: stop.addressId === null ? null : (addressById.get(stop.addressId) ?? null),
        shipments: [...shipmentMap.values()],
      };
    });

    return {
      routeId,
      code: route.code,
      status: toRouteStatus(route.status),
      plannedDate: route.plannedDate,
      driverId: route.driverId,
      vehicleId: route.vehicleId,
      summary: {
        stopsTotal: stops.length,
        stopsCompleted: stops.filter((s) => s.status === "COMPLETED").length,
        codExpectedMinor: codExpected,
      },
      stops: manifestStops,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private async requireRoute(tx: TenantTransaction, id: string): Promise<Route> {
    const rows = await tx.select().from(routes).where(eq(routes.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Route");
    }
    return row;
  }

  /**
   * The route with its stops and load.
   *
   * Public so the bon de distribution can assemble a manifest without
   * re-deriving the stop order — the paper must follow the order the driver
   * actually drives, which only this method knows.
   */
  async getPlan(routeId: string): Promise<RoutePlan> {
    return this.plan(routeId);
  }

  private async plan(routeId: string): Promise<RoutePlan> {
    const route = await this.getById(routeId);
    const stops = await this.selectStops(routeId);
    const legs = await this.shipments.getLegsForPlanning(unique(stops.flatMap((s) => s.legIds)));
    const load = summariseLoad(legs);
    const capacity =
      route.vehicleId === null ? null : await this.vehicles.capacityOf(route.vehicleId);
    return {
      route,
      stops,
      capacity: {
        parcels: load.parcels,
        weightGrams: load.weightGrams,
        volumeCm3: load.volumeCm3,
        capacity,
      },
    };
  }

  private async selectStops(routeId: string): Promise<RouteStopView[]> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({
          id: routeStops.id,
          routeId: routeStops.routeId,
          sequence: routeStops.sequence,
          type: routeStops.type,
          status: routeStops.status,
          locked: routeStops.locked,
          addressId: routeStops.addressId,
          hubId: routeStops.hubId,
          latitude: sql<number | null>`ST_Y(${routeStops.location}::geometry)`,
          longitude: sql<number | null>`ST_X(${routeStops.location}::geometry)`,
          plannedArrivalAt: routeStops.plannedArrivalAt,
          serviceDurationS: routeStops.serviceDurationS,
          legIds: routeStops.legIds,
          failureReason: routeStops.failureReason,
        })
        .from(routeStops)
        .where(eq(routeStops.routeId, routeId))
        .orderBy(asc(routeStops.sequence));
      return rows.map((r) => ({
        ...r,
        type: r.type as RouteStopType,
        status: r.status as RouteStopStatus,
      }));
    });
  }

  private async transitionStop(
    stopId: string,
    to: RouteStopStatus,
    options: { emit: "stop.arrived" | "stop.completed"; reason?: string },
  ): Promise<RouteStopView> {
    return this.database.withTenant(async (tx) => {
      const existing = await tx.select().from(routeStops).where(eq(routeStops.id, stopId)).limit(1);
      const stop = existing[0];
      if (stop === undefined) {
        throw new NotFoundError("RouteStop");
      }
      const nowFields =
        to === "ARRIVED" ? { actualArrivalAt: sql`now()` } : { actualDepartureAt: sql`now()` };
      await tx
        .update(routeStops)
        .set({
          status: to,
          updatedAt: sql`now()`,
          ...nowFields,
          ...(options.reason === undefined ? {} : { failureReason: options.reason }),
        })
        .where(eq(routeStops.id, stopId));

      await this.outbox.publish(tx, {
        eventType: options.emit,
        aggregateType: "route",
        aggregateId: stop.routeId,
        payload: {
          routeStopId: stopId,
          routeId: stop.routeId,
          legIds: stop.legIds,
          outcome: to,
          occurredAt: new Date().toISOString(),
        },
      });

      const refreshed = await tx
        .select({
          id: routeStops.id,
          routeId: routeStops.routeId,
          sequence: routeStops.sequence,
          type: routeStops.type,
          status: routeStops.status,
          locked: routeStops.locked,
          addressId: routeStops.addressId,
          hubId: routeStops.hubId,
          latitude: sql<number | null>`ST_Y(${routeStops.location}::geometry)`,
          longitude: sql<number | null>`ST_X(${routeStops.location}::geometry)`,
          plannedArrivalAt: routeStops.plannedArrivalAt,
          serviceDurationS: routeStops.serviceDurationS,
          legIds: routeStops.legIds,
          failureReason: routeStops.failureReason,
        })
        .from(routeStops)
        .where(eq(routeStops.id, stopId))
        .limit(1);
      const row = refreshed[0];
      if (row === undefined) {
        throw new NotFoundError("RouteStop");
      }
      return { ...row, type: row.type as RouteStopType, status: row.status as RouteStopStatus };
    });
  }

  private async nextOrdinal(tx: TenantTransaction, plannedDate: string): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(routes)
      .where(eq(routes.plannedDate, plannedDate));
    return (rows[0]?.count ?? 0) + 1;
  }

  private async refreshStopCount(tx: TenantTransaction, routeId: string): Promise<void> {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(routeStops)
      .where(eq(routeStops.routeId, routeId));
    await tx
      .update(routes)
      .set({ stopCount: rows[0]?.count ?? 0, updatedAt: sql`now()` })
      .where(eq(routes.id, routeId));
  }

  private async targetForLeg(leg: PlanningLeg): Promise<StopTarget> {
    if (leg.legType === "PICKUP") {
      const addressId = requireLegAddress(leg.fromAddressId, leg.legId, "pickup");
      const location = await this.addressLocation(addressId);
      return { type: "PICKUP", addressId, hubId: null, location };
    }
    if (leg.toAddressId !== null) {
      const location = await this.addressLocation(leg.toAddressId);
      return { type: "DELIVERY", addressId: leg.toAddressId, hubId: null, location };
    }
    if (leg.toHubId !== null) {
      const hub = await this.hubs.getById(leg.toHubId);
      return {
        type: "HUB_UNLOAD",
        addressId: null,
        hubId: leg.toHubId,
        location: { lat: hub.latitude, lng: hub.longitude },
      };
    }
    throw new BusinessRuleError(
      "STOP_TARGET_MISSING",
      `Leg ${leg.legId} has no address or hub to visit.`,
    );
  }

  private async addressLocation(addressId: string): Promise<LatLng> {
    const address = await this.addresses.getById(addressId);
    if (address.latitude === null || address.longitude === null) {
      // Low/zero geocode confidence leaves an address unlocatable; it cannot be
      // sequenced. This is the MENA address-quality control surfacing in dispatch.
      throw new BusinessRuleError(
        "GEOCODE_CONFIDENCE_TOO_LOW",
        `Address ${addressId} has no usable location; resolve it before dispatch.`,
      );
    }
    return { lat: address.latitude, lng: address.longitude };
  }

  private async startLocation(route: Route): Promise<LatLng | null> {
    if (route.startHubId === null) {
      return null;
    }
    const hub = await this.hubs.getById(route.startHubId);
    return { lat: hub.latitude, lng: hub.longitude };
  }

  private async assertLegsNotPlannedElsewhere(
    tx: TenantTransaction,
    routeId: string,
    legIds: readonly string[],
  ): Promise<void> {
    const legArray = sql`ARRAY[${sql.join(
      legIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[]`;
    const rows = await tx
      .select({ routeId: routeStops.routeId })
      .from(routeStops)
      .innerJoin(routes, eq(routeStops.routeId, routes.id))
      .where(
        and(
          sql`${routeStops.legIds} && ${legArray}`,
          ne(routes.id, routeId),
          ne(routes.status, "CANCELLED"),
        ),
      )
      .limit(1);
    if (rows.length > 0) {
      throw new ConflictError(
        "LEG_ALREADY_PLANNED",
        "One or more legs are already planned on another active route.",
      );
    }
  }

  private async assertCapacity(vehicleId: string, legs: readonly PlanningLeg[]): Promise<void> {
    const capacity = await this.vehicles.capacityOf(vehicleId);
    const load = summariseLoad(legs);
    // A dimension of 0 means "unspecified" — do not fail a route on an unset limit.
    if (capacity.parcels > 0 && load.parcels > capacity.parcels) {
      throw capacityExceeded("parcels", load.parcels, capacity.parcels);
    }
    if (capacity.weightGrams > 0 && load.weightGrams > capacity.weightGrams) {
      throw capacityExceeded("weightGrams", load.weightGrams, capacity.weightGrams);
    }
    if (capacity.volumeCm3 > 0 && load.volumeCm3 > capacity.volumeCm3) {
      throw capacityExceeded("volumeCm3", load.volumeCm3, capacity.volumeCm3);
    }
  }

  private async assertSkills(driverId: string, legs: readonly PlanningLeg[]): Promise<void> {
    const required = unique(legs.flatMap((l) => l.requiredSkills));
    if (required.length === 0) {
      return;
    }
    const driver = await this.drivers.getById(driverId);
    const held = new Set(driver.skills);
    const missing = required.filter((s) => !held.has(s));
    if (missing.length > 0) {
      throw new BusinessRuleError(
        "DRIVER_MISSING_SKILL",
        `The assigned driver lacks required skill(s): ${missing.join(", ")}.`,
      );
    }
  }

  private async assertDriverFree(driverId: string): Promise<void> {
    const inProgress = await this.database.withTenant(async (tx) =>
      tx
        .select({ id: routes.id })
        .from(routes)
        .where(and(eq(routes.driverId, driverId), eq(routes.status, "IN_PROGRESS")))
        .limit(1),
    );
    if (inProgress.length > 0) {
      throw new ConflictError(
        "DRIVER_ROUTE_IN_PROGRESS",
        "This driver already has a route in progress.",
      );
    }
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

function requireRow(rows: Route[], label: string): Route {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`${label} write returned no row`);
  }
  return row;
}

function assertDraft(route: Route): void {
  if (route.status !== "DRAFT") {
    throw notDraft(route);
  }
}

function notDraft(route: Route): BusinessRuleError {
  return new BusinessRuleError(
    "ROUTE_NOT_DRAFT",
    `This route is ${route.status}; only a DRAFT route can be edited.`,
  );
}

function assertAllLegsFound(requested: readonly string[], found: readonly PlanningLeg[]): void {
  const foundIds = new Set(found.map((l) => l.legId));
  const missing = requested.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new NotFoundError("ShipmentLeg");
  }
}

function requireLegAddress(addressId: string | null, legId: string, kind: string): string {
  if (addressId === null) {
    throw new BusinessRuleError("STOP_TARGET_MISSING", `Leg ${legId} has no ${kind} address.`);
  }
  return addressId;
}

function isTerminalStop(status: RouteStopStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "SKIPPED";
}

function tallyStops(stops: readonly RouteStopView[]): {
  completed: number;
  failed: number;
  skipped: number;
} {
  return {
    completed: stops.filter((s) => s.status === "COMPLETED").length,
    failed: stops.filter((s) => s.status === "FAILED").length,
    skipped: stops.filter((s) => s.status === "SKIPPED").length,
  };
}

function summariseLoad(legs: readonly PlanningLeg[]): {
  parcels: number;
  weightGrams: number;
  volumeCm3: number;
} {
  return legs.reduce(
    (acc, l) => ({
      parcels: acc.parcels + l.parcelCount,
      weightGrams: acc.weightGrams + l.weightGrams,
      volumeCm3: acc.volumeCm3 + (l.volumeCm3 ?? 0),
    }),
    { parcels: 0, weightGrams: 0, volumeCm3: 0 },
  );
}

function summariseCod(legs: readonly PlanningLeg[]): {
  shipmentCount: number;
  codShipmentCount: number;
  totalMinor: bigint;
  currency: string | null;
} {
  const perShipment = new Map<string, { cod: bigint; currency: string }>();
  for (const leg of legs) {
    if (!perShipment.has(leg.shipmentId)) {
      perShipment.set(leg.shipmentId, { cod: leg.codAmountMinor, currency: leg.currency });
    }
  }
  let total = 0n;
  let codCount = 0;
  let currency: string | null = null;
  for (const { cod, currency: c } of perShipment.values()) {
    total += cod;
    if (cod > 0n) {
      codCount++;
    }
    currency ??= c;
  }
  return {
    shipmentCount: perShipment.size,
    codShipmentCount: codCount,
    totalMinor: total,
    currency,
  };
}

function capacityExceeded(dimension: string, load: number, limit: number): BusinessRuleError {
  return new BusinessRuleError(
    "CAPACITY_EXCEEDED",
    `Planned load exceeds vehicle ${dimension} capacity (${load} > ${limit}).`,
  );
}

function groupKey(target: StopTarget): string {
  return `${target.type}:${target.addressId ?? target.hubId ?? "BREAK"}`;
}

function stopGroupKey(stop: {
  type: string;
  addressId: string | null;
  hubId: string | null;
}): string {
  return `${stop.type}:${stop.addressId ?? stop.hubId ?? "BREAK"}`;
}

function requireTarget(targets: Map<string, StopTarget>, legId: string): StopTarget {
  const t = targets.get(legId);
  if (t === undefined) {
    throw new Error(`no resolved target for leg ${legId}`);
  }
  return t;
}

function requireFirst(ids: readonly string[]): string {
  const first = ids[0];
  if (first === undefined) {
    throw new Error("empty leg group");
  }
  return first;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

type LocatedStop = RouteStopView & { latitude: number; longitude: number };

/** Keeps the stops' current order (feature flag off — no re-sequencing). */
function manualOrder(
  stops: readonly LocatedStop[],
  start: LatLng | null,
): {
  order: string[];
  distanceM: number;
  durationS: number;
  solver: "HAVERSINE_NN_2OPT";
  usedFallback: false;
  solveDurationMs: number;
} {
  let distance = 0;
  let prev = start;
  for (const stop of stops) {
    const here = { lat: stop.latitude, lng: stop.longitude };
    if (prev !== null) {
      distance += haversineMetres(prev, here);
    }
    prev = here;
  }
  const rounded = Math.round(distance);
  return {
    order: stops.map((s) => s.id),
    distanceM: rounded,
    durationS: Math.round(rounded / PLANNING_SPEED_MPS),
    solver: "HAVERSINE_NN_2OPT",
    usedFallback: false,
    solveDurationMs: 0,
  };
}

/** Reorders `stops` to match the optimiser's id order, appending any it omitted. */
function orderStops(stops: readonly LocatedStop[], order: readonly string[]): LocatedStop[] {
  const byId = new Map(stops.map((s) => [s.id, s]));
  const ordered: LocatedStop[] = [];
  for (const id of order) {
    const s = byId.get(id);
    if (s !== undefined) {
      ordered.push(s);
      byId.delete(id);
    }
  }
  for (const s of byId.values()) {
    ordered.push(s);
  }
  return ordered;
}

/** Cumulative planned arrival per stop from the route start, or nulls if unstarted. */
function computeArrivals(
  ordered: readonly LocatedStop[],
  start: LatLng | null,
  plannedStartAt: Date | null,
): (Date | null)[] {
  if (plannedStartAt === null) {
    return ordered.map(() => null);
  }
  const arrivals: (Date | null)[] = [];
  let cursorMs = plannedStartAt.getTime();
  let prev = start;
  for (const stop of ordered) {
    const here = { lat: stop.latitude, lng: stop.longitude };
    const travelS = prev === null ? 0 : haversineMetres(prev, here) / PLANNING_SPEED_MPS;
    cursorMs += travelS * 1000;
    arrivals.push(new Date(cursorMs));
    cursorMs += stop.serviceDurationS * 1000;
    prev = here;
  }
  return arrivals;
}
