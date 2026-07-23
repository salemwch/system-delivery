import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { AddressService } from "../../directory/index.js";
import { OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { createHubSchema, listHubsSchema, updateHubSchema } from "../domain/dtos.js";
import { hubs, zones } from "../domain/schema.js";

/** A hub with its coordinates flattened out of PostGIS (location is opaque WKB). */
export interface HubView {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly addressId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  readonly parentHubId: string | null;
  readonly serviceZoneIds: string[];
  readonly cutoffTimes: unknown;
  readonly cashAccountId: string | null;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface HubPage {
  readonly items: HubView[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PARENT_DEPTH = 64;

function pointOf(coordinates: { lat: number; lng: number }) {
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.lng}, ${coordinates.lat}), 4326)::geography`;
}

/**
 * Hubs — the physical facilities of the network (docs/02-domain-model.md §3.4).
 *
 * A hub is never hard-deleted: `status` ACTIVE/INACTIVE is its lifecycle. Its
 * `location` is denormalised from the facility address so nearest-hub and
 * resolve-for-address queries never join back to `addresses`.
 *
 * Deferred by layering (network is Layer 1): the HUB_CASH LedgerAccount (rule 1)
 * and the deactivation guard (rule 3 — no in-custody shipments / open manifests /
 * cash) attach when the finance, shipment, and manifest contexts exist.
 */
@Injectable()
export class HubService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly addresses: AddressService,
  ) {}

  async create(input: unknown): Promise<HubView> {
    const dto = parseWithZod(createHubSchema, input);
    // The facility address is resolved through the directory pipeline; the pinned
    // coordinates from the input are authoritative for the denormalised location.
    const address = await this.addresses.resolve({
      rawInput: dto.address.rawInput,
      countryCode: dto.address.countryCode,
      coordinates: dto.address.coordinates,
      ...(dto.address.line1 === undefined ? {} : { line1: dto.address.line1 }),
      ...(dto.address.city === undefined ? {} : { city: dto.address.city }),
      ...(dto.address.region === undefined ? {} : { region: dto.address.region }),
      ...(dto.address.postalCode === undefined ? {} : { postalCode: dto.address.postalCode }),
    });

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        if (dto.parentHubId !== undefined) {
          await this.requireHubExists(tx, dto.parentHubId);
        }
        if (dto.serviceZoneIds !== undefined && dto.serviceZoneIds.length > 0) {
          await this.requireZonesExist(tx, dto.serviceZoneIds);
        }

        const inserted = await tx
          .insert(hubs)
          .values({
            tenantId,
            code: dto.code,
            name: dto.name,
            type: dto.type,
            addressId: address.addressId,
            location: pointOf(dto.address.coordinates),
            timezone: dto.timezone,
            ...(dto.parentHubId === undefined ? {} : { parentHubId: dto.parentHubId }),
            ...(dto.serviceZoneIds === undefined ? {} : { serviceZoneIds: dto.serviceZoneIds }),
            ...(dto.cutoffTimes === undefined ? {} : { cutoffTimes: dto.cutoffTimes }),
          })
          .returning({ id: hubs.id });
        const id = requireId(inserted);

        await this.outbox.publish(tx, {
          eventType: "hub.created",
          aggregateType: "hub",
          aggregateId: id,
          payload: { hubId: id, code: dto.code, name: dto.name, type: dto.type },
        });

        return this.viewById(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, "hubs_tenant_code_uq")) {
        throw new ConflictError("HUB_CODE_TAKEN", `Hub code "${dto.code}" is already in use.`);
      }
      throw error;
    }
  }

  async getById(id: string): Promise<HubView> {
    return this.database.withTenant((tx) => this.viewById(tx, id));
  }

  async listActive(): Promise<HubView[]> {
    return this.database.withTenant(async (tx) => {
      const rows = await selectHubViews(tx, eq(hubs.status, "ACTIVE"));
      return rows;
    });
  }

  async list(input: unknown = {}): Promise<HubPage> {
    const dto = parseWithZod(listHubsSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(dto.status === undefined ? [] : [eq(hubs.status, dto.status)]),
        ...(dto.cursor === undefined ? [] : [lt(hubs.id, dto.cursor)]),
      ];
      const rows = await selectHubViews(
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

  async update(id: string, input: unknown): Promise<HubView> {
    const dto = parseWithZod(updateHubSchema, input);
    return this.database.withTenant(async (tx) => {
      await this.requireHubExists(tx, id);
      if (dto.parentHubId !== undefined && dto.parentHubId !== null) {
        await this.requireHubExists(tx, dto.parentHubId);
        await this.assertNoCycle(tx, id, dto.parentHubId);
      }
      if (dto.serviceZoneIds !== undefined && dto.serviceZoneIds.length > 0) {
        await this.requireZonesExist(tx, dto.serviceZoneIds);
      }
      await tx
        .update(hubs)
        .set({
          updatedAt: sql`now()`,
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.type === undefined ? {} : { type: dto.type }),
          ...(dto.timezone === undefined ? {} : { timezone: dto.timezone }),
          ...(dto.parentHubId === undefined ? {} : { parentHubId: dto.parentHubId }),
          ...(dto.serviceZoneIds === undefined ? {} : { serviceZoneIds: dto.serviceZoneIds }),
          ...(dto.cutoffTimes === undefined ? {} : { cutoffTimes: dto.cutoffTimes }),
        })
        .where(eq(hubs.id, id));
      return this.viewById(tx, id);
    });
  }

  /** Deactivates a hub. The cross-module custody/cash guard (rule 3) attaches later. */
  async deactivate(id: string): Promise<HubView> {
    return this.setStatus(id, "INACTIVE");
  }

  async activate(id: string): Promise<HubView> {
    return this.setStatus(id, "ACTIVE");
  }

  private async setStatus(id: string, status: "ACTIVE" | "INACTIVE"): Promise<HubView> {
    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(hubs)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(hubs.id, id))
        .returning({ id: hubs.id });
      if (updated[0] === undefined) {
        throw new NotFoundError("Hub");
      }
      return this.viewById(tx, id);
    });
  }

  /**
   * Which hub serves an address: the nearest ACTIVE hub whose service zones cover
   * the address, falling back to the nearest ACTIVE hub overall. `null` when the
   * address has no geocode or the tenant has no active hub.
   */
  async resolveForAddress(addressId: string): Promise<HubView | null> {
    const address = await this.addresses.getById(addressId);
    if (address.latitude === null || address.longitude === null) {
      return null;
    }
    const point = pointOf({ lat: address.latitude, lng: address.longitude });

    return this.database.withTenant(async (tx) => {
      const zoneRows = await tx
        .select({ id: zones.id })
        .from(zones)
        .where(and(eq(zones.active, true), sql`ST_Covers(${zones.boundary}, ${point})`))
        .orderBy(sql`ST_Area(${zones.boundary}) ASC`)
        .limit(1);
      const zoneId = zoneRows[0]?.id;

      if (zoneId !== undefined) {
        const served = await selectHubViews(
          tx,
          and(eq(hubs.status, "ACTIVE"), sql`${hubs.serviceZoneIds} @> ARRAY[${zoneId}]::uuid[]`),
          1,
          sql`${hubs.location} <-> ${point} ASC`,
        );
        if (served[0] !== undefined) {
          return served[0];
        }
      }

      const nearest = await selectHubViews(
        tx,
        eq(hubs.status, "ACTIVE"),
        1,
        sql`${hubs.location} <-> ${point} ASC`,
      );
      return nearest[0] ?? null;
    });
  }

  private async viewById(tx: TenantTransaction, id: string): Promise<HubView> {
    const rows = await selectHubViews(tx, eq(hubs.id, id), 1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Hub");
    }
    return row;
  }

  private async requireHubExists(tx: TenantTransaction, id: string): Promise<void> {
    const rows = await tx.select({ id: hubs.id }).from(hubs).where(eq(hubs.id, id)).limit(1);
    if (rows[0] === undefined) {
      throw new NotFoundError("Hub");
    }
  }

  private async requireZonesExist(tx: TenantTransaction, zoneIds: string[]): Promise<void> {
    const rows = await tx.select({ id: zones.id }).from(zones).where(inArray(zones.id, zoneIds));
    if (rows.length !== new Set(zoneIds).size) {
      throw new BusinessRuleError(
        "ZONE_NOT_FOUND",
        "One or more service zones do not exist in this tenant.",
      );
    }
  }

  /** Walks the proposed parent chain; a cycle back to `hubId` is rejected (rule 4). */
  private async assertNoCycle(
    tx: TenantTransaction,
    hubId: string,
    proposedParentId: string,
  ): Promise<void> {
    let cursor: string | null = proposedParentId;
    for (let depth = 0; depth < MAX_PARENT_DEPTH && cursor !== null; depth += 1) {
      if (cursor === hubId) {
        throw new BusinessRuleError(
          "HUB_PARENT_CYCLE",
          "Re-parenting this hub there would create a cycle in the network hierarchy.",
        );
      }
      const rows: { parentHubId: string | null }[] = await tx
        .select({ parentHubId: hubs.parentHubId })
        .from(hubs)
        .where(eq(hubs.id, cursor))
        .limit(1);
      cursor = rows[0]?.parentHubId ?? null;
    }
  }
}

async function selectHubViews(
  tx: TenantTransaction,
  where: ReturnType<typeof eq> | undefined,
  limit?: number,
  orderBy?: ReturnType<typeof sql>,
): Promise<HubView[]> {
  const base = tx
    .select({
      id: hubs.id,
      tenantId: hubs.tenantId,
      code: hubs.code,
      name: hubs.name,
      type: hubs.type,
      addressId: hubs.addressId,
      latitude: sql<number>`ST_Y(${hubs.location}::geometry)`,
      longitude: sql<number>`ST_X(${hubs.location}::geometry)`,
      timezone: hubs.timezone,
      parentHubId: hubs.parentHubId,
      serviceZoneIds: hubs.serviceZoneIds,
      cutoffTimes: hubs.cutoffTimes,
      cashAccountId: hubs.cashAccountId,
      status: hubs.status,
      createdAt: hubs.createdAt,
      updatedAt: hubs.updatedAt,
    })
    .from(hubs)
    .where(where)
    .orderBy(orderBy ?? desc(hubs.id));
  return limit === undefined ? base : base.limit(limit);
}

function requireId(rows: { id: string }[]): string {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Hub insert returned no row");
  }
  return row.id;
}
