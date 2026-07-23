import { Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";

import { AddressService } from "../../directory/index.js";
import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { createGeofenceSchema } from "../domain/dtos.js";
import type { CreateGeofenceInput } from "../domain/dtos.js";
import { evaluateGeofences } from "../domain/geofence-eval.js";
import type { CircleGeofence, GeofenceEvaluation } from "../domain/geofence-eval.js";
import type { LatLng } from "../domain/geo.js";
import { geofences, hubs, zones } from "../domain/schema.js";

/** A geofence with its centre flattened out of PostGIS. */
export interface GeofenceView {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: string;
  readonly hubId: string | null;
  readonly addressId: string | null;
  readonly zoneId: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly radiusM: number;
  readonly active: boolean;
  readonly metadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const DEFAULT_HUB_GEOFENCE_RADIUS_M = 200;
const DEFAULT_STOP_GEOFENCE_RADIUS_M = 150;

function pointOf(coordinates: LatLng) {
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.lng}, ${coordinates.lat}), 4326)::geography`;
}

interface Derived {
  readonly centre: LatLng;
  readonly radius: number;
}

/**
 * Geofences — circular arrival boundaries (docs/02-domain-model.md §3.4,
 * docs/04-context-map.md §3.4).
 *
 * The persisted definitions plus the seam that the `tracking` context uses:
 * {@link load} preloads a tenant's active geofences once, then {@link evaluate}
 * is a pure, in-memory crossing test with no I/O — the pattern that keeps
 * geofence evaluation cheap enough to run on every GPS point (hotspot H6).
 *
 * A geofence's centre and radius are DERIVED from its target: a HUB geofence sits
 * on the hub, a ZONE geofence on the zone centroid at the zone's default radius, a
 * STOP geofence on the address (inheriting its zone's radius). Only a CUSTOM
 * geofence carries both explicitly.
 */
@Injectable()
export class GeofenceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly addresses: AddressService,
  ) {}

  async create(input: unknown): Promise<GeofenceView> {
    const dto = parseWithZod(createGeofenceSchema, input);

    // A STOP geofence's centre is the address geocode, read through the directory
    // service before the write transaction (it opens its own).
    let stopCentre: LatLng | undefined;
    if (dto.kind === "STOP") {
      if (dto.addressId === undefined) {
        throw new BusinessRuleError(
          "GEOFENCE_TARGET_REQUIRED",
          "A STOP geofence requires an addressId.",
        );
      }
      const address = await this.addresses.getById(dto.addressId);
      if (address.latitude === null || address.longitude === null) {
        throw new BusinessRuleError(
          "GEOFENCE_ADDRESS_NOT_LOCATED",
          "The address has no geocode, so a geofence cannot be placed on it.",
        );
      }
      stopCentre = { lat: address.latitude, lng: address.longitude };
    }

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const derived = await this.derive(tx, dto, stopCentre);

      const inserted = await tx
        .insert(geofences)
        .values({
          tenantId,
          name: dto.name,
          kind: dto.kind,
          centre: pointOf(derived.centre),
          radiusM: derived.radius,
          ...(dto.hubId === undefined ? {} : { hubId: dto.hubId }),
          ...(dto.addressId === undefined ? {} : { addressId: dto.addressId }),
          ...(dto.zoneId === undefined ? {} : { zoneId: dto.zoneId }),
          ...(dto.metadata === undefined ? {} : { metadata: dto.metadata }),
        })
        .returning({ id: geofences.id });
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("Geofence insert returned no row");
      }
      return this.viewById(tx, row.id);
    });
  }

  async getById(id: string): Promise<GeofenceView> {
    return this.database.withTenant((tx) => this.viewById(tx, id));
  }

  async deactivate(id: string): Promise<GeofenceView> {
    return this.setActive(id, false);
  }

  async activate(id: string): Promise<GeofenceView> {
    return this.setActive(id, true);
  }

  /**
   * Preloads a tenant's active geofences for in-memory evaluation. The `tracking`
   * context calls this once per batch, then {@link evaluate} per GPS point.
   */
  async load(): Promise<CircleGeofence[]> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({
          id: geofences.id,
          lat: sql<number>`ST_Y(${geofences.centre}::geometry)`,
          lng: sql<number>`ST_X(${geofences.centre}::geometry)`,
          radiusM: geofences.radiusM,
        })
        .from(geofences)
        .where(eq(geofences.active, true));
      return rows.map((row) => ({
        id: row.id,
        centre: { lat: row.lat, lng: row.lng },
        radiusM: row.radiusM,
      }));
    });
  }

  /**
   * Pure, in-memory evaluation — no I/O. Delegates to the domain function so the
   * crossing logic is unit-testable without a database and identical wherever the
   * tracking context runs it.
   */
  evaluate(
    point: LatLng,
    candidates: readonly CircleGeofence[],
    previouslyInside: ReadonlySet<string>,
  ): GeofenceEvaluation[] {
    return evaluateGeofences(point, candidates, previouslyInside);
  }

  private async setActive(id: string, active: boolean): Promise<GeofenceView> {
    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(geofences)
        .set({ active, updatedAt: sql`now()` })
        .where(eq(geofences.id, id))
        .returning({ id: geofences.id });
      if (updated[0] === undefined) {
        throw new NotFoundError("Geofence");
      }
      return this.viewById(tx, id);
    });
  }

  private async derive(
    tx: TenantTransaction,
    dto: CreateGeofenceInput,
    stopCentre: LatLng | undefined,
  ): Promise<Derived> {
    switch (dto.kind) {
      case "CUSTOM": {
        if (dto.centre === undefined || dto.radiusM === undefined) {
          throw new BusinessRuleError(
            "GEOFENCE_CENTRE_REQUIRED",
            "A CUSTOM geofence requires an explicit centre and radiusM.",
          );
        }
        return { centre: dto.centre, radius: dto.radiusM };
      }
      case "HUB": {
        if (dto.hubId === undefined) {
          throw new BusinessRuleError(
            "GEOFENCE_TARGET_REQUIRED",
            "A HUB geofence requires a hubId.",
          );
        }
        const rows = await tx
          .select({
            lat: sql<number>`ST_Y(${hubs.location}::geometry)`,
            lng: sql<number>`ST_X(${hubs.location}::geometry)`,
          })
          .from(hubs)
          .where(eq(hubs.id, dto.hubId))
          .limit(1);
        const hub = rows[0];
        if (hub === undefined) {
          throw new NotFoundError("Hub");
        }
        return {
          centre: { lat: hub.lat, lng: hub.lng },
          radius: dto.radiusM ?? DEFAULT_HUB_GEOFENCE_RADIUS_M,
        };
      }
      case "ZONE": {
        if (dto.zoneId === undefined) {
          throw new BusinessRuleError(
            "GEOFENCE_TARGET_REQUIRED",
            "A ZONE geofence requires a zoneId.",
          );
        }
        const rows = await tx
          .select({
            lat: sql<number>`ST_Y(ST_Centroid(${zones.boundary})::geometry)`,
            lng: sql<number>`ST_X(ST_Centroid(${zones.boundary})::geometry)`,
            defaultRadius: zones.defaultGeofenceRadiusM,
          })
          .from(zones)
          .where(eq(zones.id, dto.zoneId))
          .limit(1);
        const zone = rows[0];
        if (zone === undefined) {
          throw new NotFoundError("Zone");
        }
        return {
          centre: { lat: zone.lat, lng: zone.lng },
          radius: dto.radiusM ?? zone.defaultRadius,
        };
      }
      case "STOP": {
        // stopCentre is guaranteed for STOP (validated before the transaction).
        if (stopCentre === undefined) {
          throw new BusinessRuleError(
            "GEOFENCE_TARGET_REQUIRED",
            "A STOP geofence requires an addressId.",
          );
        }
        const radius = dto.radiusM ?? (await this.zoneRadiusAt(tx, stopCentre));
        return { centre: stopCentre, radius };
      }
    }
  }

  /** The default radius of the zone covering a point, or the stop default. */
  private async zoneRadiusAt(tx: TenantTransaction, point: LatLng): Promise<number> {
    const rows = await tx
      .select({ radius: zones.defaultGeofenceRadiusM })
      .from(zones)
      .where(and(eq(zones.active, true), sql`ST_Covers(${zones.boundary}, ${pointOf(point)})`))
      .orderBy(sql`ST_Area(${zones.boundary}) ASC`)
      .limit(1);
    return rows[0]?.radius ?? DEFAULT_STOP_GEOFENCE_RADIUS_M;
  }

  private async viewById(tx: TenantTransaction, id: string): Promise<GeofenceView> {
    const rows = await tx
      .select({
        id: geofences.id,
        tenantId: geofences.tenantId,
        name: geofences.name,
        kind: geofences.kind,
        hubId: geofences.hubId,
        addressId: geofences.addressId,
        zoneId: geofences.zoneId,
        latitude: sql<number>`ST_Y(${geofences.centre}::geometry)`,
        longitude: sql<number>`ST_X(${geofences.centre}::geometry)`,
        radiusM: geofences.radiusM,
        active: geofences.active,
        metadata: geofences.metadata,
        createdAt: geofences.createdAt,
        updatedAt: geofences.updatedAt,
      })
      .from(geofences)
      .where(eq(geofences.id, id))
      .orderBy(desc(geofences.id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Geofence");
    }
    return row;
  }
}
