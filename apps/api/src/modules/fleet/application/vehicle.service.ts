import { Injectable } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { HubService } from "../../network/index.js";
import { OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { createVehicleSchema, listVehiclesSchema, updateVehicleSchema } from "../domain/dtos.js";
import { vehicles } from "../domain/schema.js";
import type { Vehicle } from "../domain/schema.js";

export type VehicleStatus = "ACTIVE" | "MAINTENANCE" | "INACTIVE";

/** The capacity envelope a route must not exceed on ANY dimension. */
export interface Capacity {
  readonly weightGrams: number;
  readonly volumeCm3: number;
  readonly parcels: number;
}

export interface VehiclePage {
  readonly items: Vehicle[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Vehicles — transport assets with capacity constraints (docs/02-domain-model.md
 * §3.5). Never hard-deleted: `status` is the lifecycle. A status change publishes
 * `vehicle.status_changed` (dispatch drops a vehicle that went to MAINTENANCE).
 */
@Injectable()
export class VehicleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly hubs: HubService,
  ) {}

  async create(input: unknown): Promise<Vehicle> {
    const dto = parseWithZod(createVehicleSchema, input);
    if (dto.homeHubId !== undefined) {
      await this.hubs.getById(dto.homeHubId); // throws NotFound if absent/other tenant
    }
    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const rows = await tx
          .insert(vehicles)
          .values({
            tenantId,
            plateNumber: dto.plateNumber,
            type: dto.type,
            ...(dto.make === undefined ? {} : { make: dto.make }),
            ...(dto.model === undefined ? {} : { model: dto.model }),
            ...(dto.year === undefined ? {} : { year: dto.year }),
            ...(dto.capacityWeightGrams === undefined
              ? {}
              : { capacityWeightGrams: dto.capacityWeightGrams }),
            ...(dto.capacityVolumeCm3 === undefined
              ? {}
              : { capacityVolumeCm3: dto.capacityVolumeCm3 }),
            ...(dto.capacityParcels === undefined ? {} : { capacityParcels: dto.capacityParcels }),
            ...(dto.features === undefined ? {} : { features: dto.features }),
            ...(dto.homeHubId === undefined ? {} : { homeHubId: dto.homeHubId }),
            ...(dto.insuranceExpiryAt === undefined
              ? {}
              : { insuranceExpiryAt: dto.insuranceExpiryAt }),
            ...(dto.inspectionExpiryAt === undefined
              ? {}
              : { inspectionExpiryAt: dto.inspectionExpiryAt }),
          })
          .returning();
        return requireRow(rows);
      });
    } catch (error) {
      if (isUniqueViolation(error, "vehicles_tenant_plate_uq")) {
        throw new ConflictError(
          "VEHICLE_PLATE_TAKEN",
          `Plate number "${dto.plateNumber}" is already registered.`,
        );
      }
      throw error;
    }
  }

  async getById(id: string): Promise<Vehicle> {
    return this.database.withTenant(async (tx) => this.requireById(tx, id));
  }

  /** The capacity envelope for the load planner. */
  async capacityOf(id: string): Promise<Capacity> {
    const vehicle = await this.getById(id);
    return {
      weightGrams: vehicle.capacityWeightGrams,
      volumeCm3: vehicle.capacityVolumeCm3,
      parcels: vehicle.capacityParcels,
    };
  }

  async list(input: unknown = {}): Promise<VehiclePage> {
    const dto = parseWithZod(listVehiclesSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(dto.status === undefined ? [] : [eq(vehicles.status, dto.status)]),
        ...(dto.cursor === undefined ? [] : [lt(vehicles.id, dto.cursor)]),
      ];
      const rows = await tx
        .select()
        .from(vehicles)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(vehicles.id))
        .limit(limit + 1);
      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  async update(id: string, input: unknown): Promise<Vehicle> {
    const dto = parseWithZod(updateVehicleSchema, input);
    if (dto.homeHubId !== undefined && dto.homeHubId !== null) {
      await this.hubs.getById(dto.homeHubId);
    }
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(vehicles)
        .set({
          updatedAt: sql`now()`,
          ...(dto.make === undefined ? {} : { make: dto.make }),
          ...(dto.model === undefined ? {} : { model: dto.model }),
          ...(dto.year === undefined ? {} : { year: dto.year }),
          ...(dto.capacityWeightGrams === undefined
            ? {}
            : { capacityWeightGrams: dto.capacityWeightGrams }),
          ...(dto.capacityVolumeCm3 === undefined
            ? {}
            : { capacityVolumeCm3: dto.capacityVolumeCm3 }),
          ...(dto.capacityParcels === undefined ? {} : { capacityParcels: dto.capacityParcels }),
          ...(dto.features === undefined ? {} : { features: dto.features }),
          ...(dto.homeHubId === undefined ? {} : { homeHubId: dto.homeHubId }),
          ...(dto.insuranceExpiryAt === undefined
            ? {}
            : { insuranceExpiryAt: dto.insuranceExpiryAt }),
          ...(dto.inspectionExpiryAt === undefined
            ? {}
            : { inspectionExpiryAt: dto.inspectionExpiryAt }),
        })
        .where(eq(vehicles.id, id))
        .returning();
      return requireFound(rows[0]);
    });
  }

  /** Moves a vehicle through its lifecycle and announces `vehicle.status_changed`. */
  async setStatus(id: string, status: VehicleStatus): Promise<Vehicle> {
    return this.database.withTenant(async (tx) => {
      const current = await this.requireById(tx, id);
      if (current.status === status) {
        return current;
      }
      const rows = await tx
        .update(vehicles)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(vehicles.id, id))
        .returning();
      const updated = requireFound(rows[0]);
      await this.outbox.publish(tx, {
        eventType: "vehicle.status_changed",
        aggregateType: "vehicle",
        aggregateId: id,
        payload: { vehicleId: id, from: current.status, to: status },
      });
      return updated;
    });
  }

  private async requireById(tx: TenantTransaction, id: string): Promise<Vehicle> {
    const rows = await tx.select().from(vehicles).where(eq(vehicles.id, id)).limit(1);
    return requireFound(rows[0]);
  }
}

function requireRow(rows: Vehicle[]): Vehicle {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Vehicle insert returned no row");
  }
  return row;
}

function requireFound(row: Vehicle | undefined): Vehicle {
  if (row === undefined) {
    throw new NotFoundError("Vehicle");
  }
  return row;
}
