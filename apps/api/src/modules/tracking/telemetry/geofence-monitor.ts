import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";

import { DatabaseService, asTenantId } from "../../../shared/database/index.js";
import { VALKEY_CLIENT } from "../../../shared/valkey/index.js";
import { GeofenceService, evaluateGeofences } from "../../network/index.js";
import type { CircleGeofence, LatLng } from "../../network/index.js";
import { OutboxService } from "../../platform/index.js";

/** A geofence the driver entered on this batch. */
export interface GeofenceEntry {
  readonly geofenceId: string;
  readonly at: Date;
  readonly location: LatLng;
}

/** Geofence definitions cached per tenant, with the moment they were loaded. */
interface CachedFences {
  readonly fences: readonly CircleGeofence[];
  readonly loadedAt: number;
}

/** How long a tenant's geofence set is trusted before reloading. */
const FENCE_CACHE_TTL_MS = 60_000;

/** How long a driver's inside-set survives idleness. Generous — a shift is long. */
const INSIDE_SET_TTL_S = 12 * 60 * 60;

/**
 * The one place the telemetry plane crosses into the business plane.
 *
 * docs/03-event-storming.md §2.4, *"the single most important rule in this
 * document"*: a GPS ping is not a business event. Raw telemetry never touches
 * the outbox — it would swamp every consumer and bankrupt the event store. Only
 * a geofence ENTER becomes a fact the business cares about
 * (`shipment.arrived_at_stop`). At Tier 3 that is a 170:1 reduction: 864 million
 * positions a day producing roughly 5 million events.
 *
 * Two things make that ratio hold:
 *
 *  - **Transitions, not states.** A driver parked inside a geofence for twenty
 *    minutes produces one ENTER, not 240 pings' worth. The prior inside-set
 *    lives in Valkey per driver, so the diff survives across requests and across
 *    API instances.
 *  - **Evaluation is pure and in-memory.** `evaluateGeofences` is one haversine
 *    per candidate; geofence definitions are cached per tenant. There is no
 *    database round trip per GPS point, because at 10k points/sec there cannot
 *    be one.
 */
@Injectable()
export class GeofenceMonitor {
  private readonly fenceCache = new Map<string, CachedFences>();

  constructor(
    private readonly database: DatabaseService,
    private readonly geofences: GeofenceService,
    private readonly outbox: OutboxService,
    @Inject(VALKEY_CLIENT) private readonly valkey: Redis,
  ) {}

  /**
   * Evaluates a driver's track against the tenant's geofences and publishes an
   * event per ENTER.
   *
   * Positions are processed in chronological order so the inside-set evolves the
   * way the driver actually moved. Out-of-order points — which offline sync
   * produces routinely — would otherwise manufacture phantom ENTER/EXIT pairs.
   */
  async evaluateTrack(
    tenantId: string,
    driverId: string,
    positions: readonly { readonly at: Date; readonly lat: number; readonly lon: number }[],
    context: { readonly routeId: string | null; readonly actorId: string },
  ): Promise<GeofenceEntry[]> {
    if (positions.length === 0) {
      return [];
    }

    const fences = await this.loadFences(tenantId);
    if (fences.length === 0) {
      return [];
    }

    const insideKey = `tenant:${tenantId}:driver:${driverId}:fences`;
    const stored = await this.valkey.smembers(insideKey);
    const inside = new Set<string>(stored);

    const ordered = [...positions].sort((a, b) => a.at.getTime() - b.at.getTime());
    const entries: GeofenceEntry[] = [];
    const entered = new Set<string>();
    const exited = new Set<string>();

    for (const position of ordered) {
      const point: LatLng = { lat: position.lat, lng: position.lon };
      for (const evaluation of evaluateGeofences(point, fences, inside)) {
        if (evaluation.transition === "ENTER") {
          inside.add(evaluation.geofenceId);
          entered.add(evaluation.geofenceId);
          exited.delete(evaluation.geofenceId);
          entries.push({
            geofenceId: evaluation.geofenceId,
            at: position.at,
            location: point,
          });
        } else if (evaluation.transition === "EXIT") {
          inside.delete(evaluation.geofenceId);
          exited.add(evaluation.geofenceId);
          entered.delete(evaluation.geofenceId);
        }
      }
    }

    await this.persistInsideSet(insideKey, entered, exited);

    if (entries.length > 0) {
      await this.publishArrivals(tenantId, driverId, entries, context);
    }
    return entries;
  }

  /** Forgets a driver's geofence state — used when a shift ends. */
  async clear(tenantId: string, driverId: string): Promise<void> {
    await this.valkey.del(`tenant:${tenantId}:driver:${driverId}:fences`);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Geofence definitions for a tenant, cached briefly.
   *
   * Reloading per batch would put a query on the hottest path in the system.
   * A 60-second staleness window is the right trade: a geofence created now
   * starts firing within a minute, and nothing in this domain needs it sooner.
   */
  private async loadFences(tenantId: string): Promise<readonly CircleGeofence[]> {
    const cached = this.fenceCache.get(tenantId);
    if (cached !== undefined && Date.now() - cached.loadedAt < FENCE_CACHE_TTL_MS) {
      return cached.fences;
    }
    const fences = await this.geofences.load();
    this.fenceCache.set(tenantId, { fences, loadedAt: Date.now() });
    return fences;
  }

  private async persistInsideSet(
    key: string,
    entered: ReadonlySet<string>,
    exited: ReadonlySet<string>,
  ): Promise<void> {
    if (entered.size === 0 && exited.size === 0) {
      return;
    }
    const pipeline = this.valkey.pipeline();
    if (entered.size > 0) {
      pipeline.sadd(key, ...entered);
    }
    if (exited.size > 0) {
      pipeline.srem(key, ...exited);
    }
    // Refreshed on every change so an active driver's set never expires
    // mid-shift, while an abandoned one does not linger forever.
    pipeline.expire(key, INSIDE_SET_TTL_S);
    await pipeline.exec();
  }

  /**
   * Publishes `shipment.arrived_at_stop` — the only outbox write in this module.
   *
   * Resolving which shipment sits behind a geofence is a cross-module read, done
   * with raw SQL rather than importing `dispatch` or `shipment`: `tracking` is
   * layer 3 and may depend only on platform, fleet, and network
   * (docs/04-context-map.md §3.9). RLS scopes it to the tenant.
   *
   * A geofence with no active stop behind it publishes nothing. Hub and zone
   * fences exist for other reasons, and inventing an arrival for them would put
   * noise on the business bus — exactly what §2.4 forbids.
   */
  private async publishArrivals(
    tenantId: string,
    driverId: string,
    entries: readonly GeofenceEntry[],
    context: { readonly routeId: string | null; readonly actorId: string },
  ): Promise<void> {
    await this.database.withTenant(async (tx) => {
      for (const entry of entries) {
        const rows: Array<{
          stopId: string;
          shipmentId: string | null;
          legId: string | null;
          distanceM: number | null;
        }> = await tx
          .select({
            stopId: sql<string>`rs.id`,
            shipmentId: sql<string | null>`sl.shipment_id`,
            legId: sql<string | null>`sl.id`,
            distanceM: sql<number | null>`ST_Distance(g.centre, rs.location)`,
          })
          .from(
            sql`geofences g
                join route_stops rs on rs.address_id = g.address_id
                left join shipment_legs sl on sl.route_stop_id = rs.id`,
          )
          .where(
            sql`g.id = ${entry.geofenceId}
                and rs.status not in ('COMPLETED', 'FAILED', 'SKIPPED')`,
          )
          .limit(1);

        const stop = rows[0];
        if (stop === undefined || stop.shipmentId === null) {
          continue;
        }

        await this.outbox.publish(tx, {
          eventType: "shipment.arrived_at_stop",
          aggregateType: "shipment",
          aggregateId: stop.shipmentId,
          payload: {
            shipmentId: stop.shipmentId,
            legId: stop.legId,
            routeStopId: stop.stopId,
            routeId: context.routeId,
            driverId,
            location: { lat: entry.location.lat, lng: entry.location.lng },
            distanceFromDestinationM: stop.distanceM,
            detectionMethod: "GEOFENCE",
            occurredAt: entry.at.toISOString(),
          },
        });
      }
    }, asTenantId(tenantId));
  }
}
