import { Injectable } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";

import { DatabaseService } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { shipmentEvents, shipments } from "../domain/schema.js";

interface CustodySegment {
  readonly custodianType: string;
  readonly custodianId: string | null;
  readonly custodianLabel: string;
  readonly receivedAt: string;
  readonly releasedAt: string | null;
  readonly dwellSeconds: number | null;
  readonly receivedVia: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly hubId: string | null;
}

export interface CustodyChainView {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly currentCustodianType: string | null;
  readonly currentCustodianId: string | null;
  readonly totalHandoffs: number;
  readonly chain: readonly CustodySegment[];
}

interface JourneyPoint {
  readonly lat: number;
  readonly lng: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly hubId: string | null;
}

export interface JourneyView {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly points: readonly JourneyPoint[];
  readonly totalDistanceM: number | null;
}

interface AuditEntry {
  readonly id: string;
  readonly sequence: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly serverDelayMs: number;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly locationAccuracyM: number | null;
  readonly hubId: string | null;
  readonly driverId: string | null;
  readonly routeId: string | null;
  readonly legId: string | null;
  readonly reasonCode: string | null;
  readonly idempotencyKey: string;
  readonly metadata: unknown;
}

export interface AuditLogView {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly status: string;
  readonly createdAt: string;
  readonly totalEvents: number;
  readonly entries: readonly AuditEntry[];
}

export interface CurrentCustodyView {
  readonly shipmentId: string;
  readonly trackingNumber: string;
  readonly status: string;
  readonly custodianType: string | null;
  readonly custodianId: string | null;
  readonly inCustodySince: string | null;
  readonly dwellSeconds: number | null;
  readonly lastKnownLocation: { readonly lat: number; readonly lng: number } | null;
  readonly lastEventType: string | null;
  readonly lastEventAt: string | null;
}

const CUSTODY_TRANSFER_EVENTS = new Set([
  "created",
  "picked_up",
  "arrived_at_hub",
  "loaded",
  "departed",
  "out_for_delivery",
  "delivered",
  "returned",
  "assigned",
]);

@Injectable()
export class ShipmentTraceabilityService {
  constructor(private readonly database: DatabaseService) {}

  async getCustodyChain(shipmentId: string): Promise<CustodyChainView> {
    return this.database.withTenant(async (tx) => {
      const shipmentRows = await tx
        .select({
          id: shipments.id,
          trackingNumber: shipments.trackingNumber,
          currentCustodyType: shipments.currentCustodyType,
          currentCustodyId: shipments.currentCustodyId,
        })
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .limit(1);
      const shipment = shipmentRows[0];
      if (shipment === undefined) throw new NotFoundError("Shipment");

      const events = await tx
        .select({
          eventType: shipmentEvents.eventType,
          occurredAt: shipmentEvents.occurredAt,
          actorType: shipmentEvents.actorType,
          actorId: shipmentEvents.actorId,
          hubId: shipmentEvents.hubId,
          driverId: shipmentEvents.driverId,
          latitude: sql<number | null>`ST_Y(${shipmentEvents.location}::geometry)`,
          longitude: sql<number | null>`ST_X(${shipmentEvents.location}::geometry)`,
        })
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipmentId))
        .orderBy(asc(shipmentEvents.sequence));

      const chain: CustodySegment[] = [];

      for (const event of events) {
        if (!CUSTODY_TRANSFER_EVENTS.has(event.eventType)) continue;

        const custodianType = resolveCustodianType(event);
        const custodianId = event.driverId ?? event.hubId ?? event.actorId;
        const location =
          event.latitude !== null && event.longitude !== null
            ? { lat: event.latitude, lng: event.longitude }
            : null;

        if (chain.length > 0) {
          const prev = chain[chain.length - 1];
          if (prev !== undefined && prev.releasedAt === null) {
            const released = event.occurredAt.toISOString();
            const dwell = Math.round(
              (event.occurredAt.getTime() - new Date(prev.receivedAt).getTime()) / 1000,
            );
            chain[chain.length - 1] = { ...prev, releasedAt: released, dwellSeconds: dwell };
          }
        }

        chain.push({
          custodianType,
          custodianId,
          custodianLabel:
            custodianType === "HUB" ? "Hub" : custodianType === "DRIVER" ? "Driver" : "System",
          receivedAt: event.occurredAt.toISOString(),
          releasedAt: null,
          dwellSeconds: null,
          receivedVia: event.eventType,
          location,
          hubId: event.hubId,
        });
      }

      return {
        shipmentId: shipment.id,
        trackingNumber: shipment.trackingNumber,
        currentCustodianType: shipment.currentCustodyType,
        currentCustodianId: shipment.currentCustodyId,
        totalHandoffs: chain.length,
        chain,
      };
    });
  }

  async getJourney(shipmentId: string): Promise<JourneyView> {
    return this.database.withTenant(async (tx) => {
      const shipmentRows = await tx
        .select({
          id: shipments.id,
          trackingNumber: shipments.trackingNumber,
        })
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .limit(1);
      const shipment = shipmentRows[0];
      if (shipment === undefined) throw new NotFoundError("Shipment");

      const events = await tx
        .select({
          eventType: shipmentEvents.eventType,
          occurredAt: shipmentEvents.occurredAt,
          actorType: shipmentEvents.actorType,
          actorId: shipmentEvents.actorId,
          hubId: shipmentEvents.hubId,
          latitude: sql<number | null>`ST_Y(${shipmentEvents.location}::geometry)`,
          longitude: sql<number | null>`ST_X(${shipmentEvents.location}::geometry)`,
        })
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipmentId))
        .orderBy(asc(shipmentEvents.sequence));

      const points: JourneyPoint[] = [];
      for (const event of events) {
        if (event.latitude !== null && event.longitude !== null) {
          points.push({
            lat: event.latitude,
            lng: event.longitude,
            eventType: event.eventType,
            occurredAt: event.occurredAt.toISOString(),
            actorType: event.actorType,
            actorId: event.actorId,
            hubId: event.hubId,
          });
        }
      }

      let totalDistanceM: number | null = null;
      if (points.length >= 2) {
        let sum = 0;
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];
          if (prev !== undefined && curr !== undefined) {
            sum += haversineMetres(prev.lat, prev.lng, curr.lat, curr.lng);
          }
        }
        totalDistanceM = Math.round(sum);
      }

      return {
        shipmentId: shipment.id,
        trackingNumber: shipment.trackingNumber,
        points,
        totalDistanceM,
      };
    });
  }

  async getCurrentCustody(shipmentId: string): Promise<CurrentCustodyView> {
    return this.database.withTenant(async (tx) => {
      const shipmentRows = await tx
        .select({
          id: shipments.id,
          trackingNumber: shipments.trackingNumber,
          status: shipments.status,
          currentCustodyType: shipments.currentCustodyType,
          currentCustodyId: shipments.currentCustodyId,
        })
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .limit(1);
      const shipment = shipmentRows[0];
      if (shipment === undefined) throw new NotFoundError("Shipment");

      const lastEventRows = await tx
        .select({
          eventType: shipmentEvents.eventType,
          occurredAt: shipmentEvents.occurredAt,
          latitude: sql<number | null>`ST_Y(${shipmentEvents.location}::geometry)`,
          longitude: sql<number | null>`ST_X(${shipmentEvents.location}::geometry)`,
        })
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipmentId))
        .orderBy(sql`${shipmentEvents.sequence} desc`)
        .limit(1);
      const lastEvent = lastEventRows[0];

      const custodyEventRows = await tx
        .select({ occurredAt: shipmentEvents.occurredAt })
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipmentId))
        .orderBy(sql`${shipmentEvents.sequence} desc`)
        .limit(1);
      const custodyEvent = custodyEventRows[0];

      const inCustodySince = custodyEvent?.occurredAt ?? null;
      const dwellSeconds =
        inCustodySince !== null ? Math.round((Date.now() - inCustodySince.getTime()) / 1000) : null;

      const lastLocation =
        lastEvent !== undefined && lastEvent.latitude !== null && lastEvent.longitude !== null
          ? { lat: lastEvent.latitude, lng: lastEvent.longitude }
          : null;

      return {
        shipmentId: shipment.id,
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        custodianType: shipment.currentCustodyType,
        custodianId: shipment.currentCustodyId,
        inCustodySince: inCustodySince?.toISOString() ?? null,
        dwellSeconds,
        lastKnownLocation: lastLocation,
        lastEventType: lastEvent?.eventType ?? null,
        lastEventAt: lastEvent?.occurredAt.toISOString() ?? null,
      };
    });
  }

  async getAuditLog(shipmentId: string): Promise<AuditLogView> {
    return this.database.withTenant(async (tx) => {
      const shipmentRows = await tx
        .select({
          id: shipments.id,
          trackingNumber: shipments.trackingNumber,
          status: shipments.status,
          createdAt: shipments.createdAt,
        })
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .limit(1);
      const shipment = shipmentRows[0];
      if (shipment === undefined) throw new NotFoundError("Shipment");

      const events = await tx
        .select({
          id: shipmentEvents.id,
          sequence: shipmentEvents.sequence,
          eventType: shipmentEvents.eventType,
          occurredAt: shipmentEvents.occurredAt,
          recordedAt: shipmentEvents.recordedAt,
          actorType: shipmentEvents.actorType,
          actorId: shipmentEvents.actorId,
          latitude: sql<number | null>`ST_Y(${shipmentEvents.location}::geometry)`,
          longitude: sql<number | null>`ST_X(${shipmentEvents.location}::geometry)`,
          locationAccuracyM: shipmentEvents.locationAccuracyM,
          hubId: shipmentEvents.hubId,
          driverId: shipmentEvents.driverId,
          routeId: shipmentEvents.routeId,
          legId: shipmentEvents.legId,
          reasonCode: shipmentEvents.reasonCode,
          idempotencyKey: shipmentEvents.idempotencyKey,
          metadata: shipmentEvents.metadata,
        })
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, shipmentId))
        .orderBy(asc(shipmentEvents.sequence));

      const entries: AuditEntry[] = events.map((e) => ({
        id: e.id,
        sequence: e.sequence.toString(),
        eventType: e.eventType,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
        serverDelayMs: e.recordedAt.getTime() - e.occurredAt.getTime(),
        actorType: e.actorType,
        actorId: e.actorId,
        location:
          e.latitude !== null && e.longitude !== null
            ? { lat: e.latitude, lng: e.longitude }
            : null,
        locationAccuracyM: e.locationAccuracyM,
        hubId: e.hubId,
        driverId: e.driverId,
        routeId: e.routeId,
        legId: e.legId,
        reasonCode: e.reasonCode,
        idempotencyKey: e.idempotencyKey,
        metadata: e.metadata,
      }));

      return {
        shipmentId: shipment.id,
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        createdAt: shipment.createdAt.toISOString(),
        totalEvents: entries.length,
        entries,
      };
    });
  }
}

function resolveCustodianType(event: {
  eventType: string;
  hubId: string | null;
  driverId: string | null;
}): string {
  if (event.hubId !== null) return "HUB";
  if (event.driverId !== null) return "DRIVER";
  if (event.eventType === "created") return "SYSTEM";
  return "UNKNOWN";
}

function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
