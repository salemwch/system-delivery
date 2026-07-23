import { Injectable } from "@nestjs/common";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { endShiftSchema, startShiftSchema } from "../domain/dtos.js";
import { drivers, shifts, vehicles } from "../domain/schema.js";
import type { Shift } from "../domain/schema.js";

/**
 * Shifts — a driver's working period (docs/02-domain-model.md §3.3, §3.21).
 *
 * The OPEN shift is the platform's central PRIVACY control: {@link isWithinOpenShift}
 * is what `tracking` calls to accept or REJECT every location point server-side,
 * because the app cannot be trusted to gate itself (context-map §3.5). At most one
 * OPEN shift exists per driver and per vehicle, enforced by partial unique indexes
 * so a concurrent double-start is a database error, not a race.
 */
@Injectable()
export class ShiftService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  async start(input: unknown): Promise<Shift> {
    const dto = parseWithZod(startShiftSchema, input);
    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        await this.assertDriverStartable(tx, dto.driverId);
        await this.assertVehicleStartable(tx, dto.vehicleId);

        const inserted = await tx
          .insert(shifts)
          .values({
            tenantId,
            driverId: dto.driverId,
            vehicleId: dto.vehicleId,
            ...(dto.hubId === undefined ? {} : { hubId: dto.hubId }),
            ...(dto.startOdometer === undefined ? {} : { startOdometer: dto.startOdometer }),
            ...(dto.openingCashMinor === undefined
              ? {}
              : { openingCashMinor: dto.openingCashMinor }),
          })
          .returning();
        const shift = requireRow(inserted);

        await this.outbox.publish(tx, {
          eventType: "driver.shift_started",
          aggregateType: "driver",
          aggregateId: dto.driverId,
          payload: {
            shiftId: shift.id,
            driverId: dto.driverId,
            vehicleId: dto.vehicleId,
            hubId: dto.hubId ?? null,
            startedAt: shift.startedAt.toISOString(),
          },
        });
        return shift;
      });
    } catch (error) {
      if (isUniqueViolation(error, "shifts_one_open_per_driver_uq")) {
        throw new ConflictError("DRIVER_SHIFT_OPEN", "This driver already has an open shift.");
      }
      if (isUniqueViolation(error, "shifts_one_open_per_vehicle_uq")) {
        throw new ConflictError("VEHICLE_SHIFT_OPEN", "This vehicle is already on an open shift.");
      }
      throw error;
    }
  }

  async end(shiftId: string, input: unknown): Promise<Shift> {
    const dto = parseWithZod(endShiftSchema, input);
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .update(shifts)
        .set({
          status: "CLOSED",
          endedAt: sql`now()`,
          updatedAt: sql`now()`,
          ...(dto.endOdometer === undefined ? {} : { endOdometer: dto.endOdometer }),
          ...(dto.closingCashMinor === undefined ? {} : { closingCashMinor: dto.closingCashMinor }),
        })
        .where(and(eq(shifts.id, shiftId), eq(shifts.status, "OPEN")))
        .returning();
      const shift = rows[0];
      if (shift === undefined) {
        // Either it does not exist (or belongs to another tenant), or it is already
        // closed — distinguish so the caller gets the right error.
        const existing = await tx
          .select({ status: shifts.status })
          .from(shifts)
          .where(eq(shifts.id, shiftId))
          .limit(1);
        if (existing[0] === undefined) {
          throw new NotFoundError("Shift");
        }
        throw new BusinessRuleError("SHIFT_NOT_OPEN", "This shift is already closed.");
      }

      await this.outbox.publish(tx, {
        eventType: "driver.shift_ended",
        aggregateType: "driver",
        aggregateId: shift.driverId,
        payload: {
          shiftId: shift.id,
          driverId: shift.driverId,
          vehicleId: shift.vehicleId,
          endedAt: (shift.endedAt ?? new Date()).toISOString(),
        },
      });
      return shift;
    });
  }

  /**
   * THE privacy gate. True iff the driver had a shift covering `at` — an OPEN
   * shift, or a CLOSED one whose window still contained `at` (an offline point
   * captured earlier and synced after the shift ended). `tracking` rejects any
   * location for which this is false.
   */
  async isWithinOpenShift(driverId: string, at: Date = new Date()): Promise<boolean> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: shifts.id })
        .from(shifts)
        .where(
          and(
            eq(shifts.driverId, driverId),
            lte(shifts.startedAt, at),
            or(isNull(shifts.endedAt), gte(shifts.endedAt, at)),
          ),
        )
        .limit(1);
      return rows.length > 0;
    });
  }

  async getById(id: string): Promise<Shift> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(shifts).where(eq(shifts.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Shift");
      }
      return row;
    });
  }

  private async assertDriverStartable(tx: TenantTransaction, driverId: string): Promise<void> {
    const rows = await tx
      .select({ status: drivers.status })
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Driver");
    }
    if (row.status !== "ACTIVE") {
      throw new BusinessRuleError(
        "DRIVER_NOT_ACTIVE",
        `A ${row.status} driver cannot start a shift.`,
      );
    }
  }

  private async assertVehicleStartable(tx: TenantTransaction, vehicleId: string): Promise<void> {
    const rows = await tx
      .select({ status: vehicles.status })
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Vehicle");
    }
    if (row.status !== "ACTIVE") {
      throw new BusinessRuleError(
        "VEHICLE_NOT_ACTIVE",
        `A ${row.status} vehicle cannot be put on a shift.`,
      );
    }
  }
}

function requireRow(rows: Shift[]): Shift {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Shift insert returned no row");
  }
  return row;
}
