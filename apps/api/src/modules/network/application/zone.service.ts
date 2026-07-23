import { Injectable } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { createZoneSchema, listZonesSchema, updateZoneSchema } from "../domain/dtos.js";
import { zones } from "../domain/schema.js";

/** A zone with its boundary as GeoJSON and its centroid flattened for convenience. */
export interface ZoneView {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly defaultGeofenceRadiusM: number;
  readonly active: boolean;
  readonly centroidLat: number;
  readonly centroidLng: number;
  readonly boundary: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ZonePage {
  readonly items: ZoneView[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

type BoundaryInput =
  | { readonly type: "Polygon"; readonly coordinates: number[][][] }
  | { readonly type: "MultiPolygon"; readonly coordinates: number[][][][] };

/** GeoJSON → a `geography(MultiPolygon,4326)`. ST_Multi promotes a Polygon. */
function boundaryOf(geojson: BoundaryInput) {
  return sql`ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(${JSON.stringify(geojson)})), 4326)::geography`;
}

/**
 * Zones — territory polygons (docs/02-domain-model.md §3.4, §3.21).
 *
 * A hub serves the zone that contains an address; each zone carries its own
 * default arrival radius (hotspot H6). Zones are soft-retired via `active`, never
 * hard-deleted. Any change publishes `zone.updated` so consumers (dispatch,
 * tracking) can invalidate cached territory/radius data.
 */
@Injectable()
export class ZoneService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  async create(input: unknown): Promise<ZoneView> {
    const dto = parseWithZod(createZoneSchema, input);
    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const inserted = await tx
          .insert(zones)
          .values({
            tenantId,
            code: dto.code,
            name: dto.name,
            boundary: boundaryOf(dto.boundary),
            ...(dto.defaultGeofenceRadiusM === undefined
              ? {}
              : { defaultGeofenceRadiusM: dto.defaultGeofenceRadiusM }),
          })
          .returning({ id: zones.id });
        const id = requireId(inserted);
        await this.emitUpdated(tx, id, dto.code, dto.name, true);
        return this.viewById(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, "zones_tenant_code_uq")) {
        throw new ConflictError("ZONE_CODE_TAKEN", `Zone code "${dto.code}" is already in use.`);
      }
      throw error;
    }
  }

  async update(id: string, input: unknown): Promise<ZoneView> {
    const dto = parseWithZod(updateZoneSchema, input);
    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(zones)
        .set({
          updatedAt: sql`now()`,
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.boundary === undefined ? {} : { boundary: boundaryOf(dto.boundary) }),
          ...(dto.defaultGeofenceRadiusM === undefined
            ? {}
            : { defaultGeofenceRadiusM: dto.defaultGeofenceRadiusM }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
        })
        .where(eq(zones.id, id))
        .returning({ id: zones.id, code: zones.code, name: zones.name, active: zones.active });
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError("Zone");
      }
      await this.emitUpdated(tx, row.id, row.code, row.name, row.active);
      return this.viewById(tx, id);
    });
  }

  async getById(id: string): Promise<ZoneView> {
    return this.database.withTenant((tx) => this.viewById(tx, id));
  }

  async list(input: unknown = {}): Promise<ZonePage> {
    const dto = parseWithZod(listZonesSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(dto.active === undefined ? [] : [eq(zones.active, dto.active)]),
        ...(dto.cursor === undefined ? [] : [lt(zones.id, dto.cursor)]),
      ];
      const rows = await selectZoneViews(
        tx,
        conditions.length > 0 ? and(...conditions) : undefined,
        limit + 1,
      );
      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /** The most specific active zone covering a point, or `null`. */
  async containing(location: { lat: number; lng: number }): Promise<string | null> {
    const point = sql`ST_SetSRID(ST_MakePoint(${location.lng}, ${location.lat}), 4326)::geography`;
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: zones.id })
        .from(zones)
        .where(and(eq(zones.active, true), sql`ST_Covers(${zones.boundary}, ${point})`))
        .orderBy(sql`ST_Area(${zones.boundary}) ASC`)
        .limit(1);
      return rows[0]?.id ?? null;
    });
  }

  private async emitUpdated(
    tx: TenantTransaction,
    id: string,
    code: string,
    name: string,
    active: boolean,
  ): Promise<void> {
    await this.outbox.publish(tx, {
      eventType: "zone.updated",
      aggregateType: "zone",
      aggregateId: id,
      payload: { zoneId: id, code, name, active },
    });
  }

  private async viewById(tx: TenantTransaction, id: string): Promise<ZoneView> {
    const rows = await selectZoneViews(tx, eq(zones.id, id), 1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Zone");
    }
    return row;
  }
}

async function selectZoneViews(
  tx: TenantTransaction,
  where: ReturnType<typeof eq> | undefined,
  limit: number,
): Promise<ZoneView[]> {
  const rows = await tx
    .select({
      id: zones.id,
      tenantId: zones.tenantId,
      code: zones.code,
      name: zones.name,
      defaultGeofenceRadiusM: zones.defaultGeofenceRadiusM,
      active: zones.active,
      centroidLat: sql<number>`ST_Y(ST_Centroid(${zones.boundary})::geometry)`,
      centroidLng: sql<number>`ST_X(ST_Centroid(${zones.boundary})::geometry)`,
      boundary: sql<unknown>`ST_AsGeoJSON(${zones.boundary})::json`,
      createdAt: zones.createdAt,
      updatedAt: zones.updatedAt,
    })
    .from(zones)
    .where(where)
    .orderBy(desc(zones.id))
    .limit(limit);
  return rows;
}

function requireId(rows: { id: string }[]): string {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Zone insert returned no row");
  }
  return row.id;
}
