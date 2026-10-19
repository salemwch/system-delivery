import { Injectable } from "@nestjs/common";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { endShiftSchema, startShiftSchema } from "../domain/dtos.js";
import { drivers, shifts, vehicles } from "../domain/schema.js";
import type { Shift } from "../domain/schema.js";

/** Who is calling a shift command, from the signed token. */
export interface ShiftContext {
  readonly actorUserId: string;
  /**
   * Whether the caller holds the DRIVER role, from the signed role claim (never
   * the login channel, audit F1). Required, not optional: an absent flag must
   * never mean "not a driver".
   */
  readonly actorIsDriver: boolean;
}

/**
 * Shifts — a driver's working period (docs/02-domain-model.md §3.3, §3.21).
 *
 * The OPEN shift is the platform's central PRIVACY control: {@link isWithinOpenShift}
 * is what `tracking` calls to accept or REJECT every location point server-side,
 * because the app cannot be trusted to gate itself (context-map §3.5). At most one
 * OPEN shift exists per driver and per vehicle, enforced by partial unique indexes
 * so a concurrent double-start is a database error, not a race.
 *
 * A driver starts, reads and ends only their OWN shift (invariant I26 applied to
 * shifts, I28 for reads). ⚠️ `driverId` came from the request body and any shift
 * id was accepted, so a driver could open a colleague's shift (switching on
 * their location collection), close it, and read its cash figures. Found by the
 * release-candidate review of 9318622 (V5). The driver is resolved from the
 * login here, and RLS (migration 0049) hides a colleague's rows as well. Staff
 * holding `shift:start` / `shift:end` (the OWNER) still act on a driver's behalf.
 */
@Injectable()
export class ShiftService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  async start(input: unknown, ctx: ShiftContext): Promise<Shift> {
    const dto = parseWithZod(startShiftSchema, input);
    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        // Before any lookup of the named driver, so a driver learns nothing
        // about a colleague: not whether they exist, nor their status.
        await assertStartsOwnShift(tx, ctx, dto.driverId);
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

  async end(shiftId: string, input: unknown, ctx: ShiftContext): Promise<Shift> {
    const dto = parseWithZod(endShiftSchema, input);
    return this.database.withTenant(async (tx) => {
      // Locked, then checked: ownership before status, so a colleague's closed
      // shift is a 404 like any other, not a "this shift is already closed".
      const current = await this.visibleShift(tx, shiftId, ctx, { lock: true });
      if (current.status !== "OPEN") {
        throw new BusinessRuleError("SHIFT_NOT_OPEN", "This shift is already closed.");
      }
      const rows = await tx
        .update(shifts)
        .set({
          status: "CLOSED",
          endedAt: sql`now()`,
          updatedAt: sql`now()`,
          ...(dto.endOdometer === undefined ? {} : { endOdometer: dto.endOdometer }),
          ...(dto.closingCashMinor === undefined ? {} : { closingCashMinor: dto.closingCashMinor }),
        })
        .where(eq(shifts.id, shiftId))
        .returning();
      const shift = requireRow(rows);

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

  /**
   * The privacy gate for an authenticated USER, resolving their driver identity
   * in the same query.
   *
   * ⚠️ A user id and a driver id are DIFFERENT things, and conflating them is
   * how GPS ingest was broken end-to-end: the telemetry controller passed
   * `principal.userId` where `isWithinOpenShift` expects `drivers.id`, so every
   * request from a real driver was refused with `TELEMETRY_OUTSIDE_SHIFT` and
   * any row that had been written would have carried a user id in
   * `driver_positions.driver_id`. The unit tests missed it by calling the
   * service directly with a driver id, bypassing the controller.
   *
   * ONE query, not two. This is the hottest path in the system (~40 req/s at
   * MVP, 10k positions/sec at Tier 3) and it already paid for a shift lookup;
   * resolving the driver through a separate `SELECT` would have doubled the
   * per-request database cost of the endpoint most sensitive to it. The join is
   * covered by `drivers.user_id` and the shift index.
   *
   * Returns null when the user is not a driver, or has no shift covering `at` —
   * both are "do not accept this location", and telling them apart would leak
   * whether a given account is a driver.
   */
  async openShiftForUser(
    userId: string,
    at: Date = new Date(),
  ): Promise<{ readonly driverId: string; readonly shiftId: string } | null> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ driverId: drivers.id, shiftId: shifts.id })
        .from(shifts)
        .innerJoin(drivers, eq(drivers.id, shifts.driverId))
        .where(
          and(
            eq(drivers.userId, userId),
            lte(shifts.startedAt, at),
            or(isNull(shifts.endedAt), gte(shifts.endedAt, at)),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
  }

  /**
   * The caller's own driver record and open shift, for the driver app.
   *
   * The app needs both and could learn neither: starting a shift takes the
   * driver's `drivers.id` (never the user id, see {@link openShiftForUser}),
   * and telemetry is refused without the open `shiftId`, so an app that cannot
   * read its shift cannot know whether it may collect location at all. A login
   * with no driver record is a 403, as it is for `start`.
   */
  async current(
    ctx: ShiftContext,
  ): Promise<{ readonly driverId: string; readonly shift: Shift | null }> {
    return this.database.withTenant(async (tx) => {
      const driverId = await callerDriverId(tx, ctx);
      if (driverId === null) {
        throw new ForbiddenError("This login is not linked to a driver.");
      }
      const rows = await tx
        .select()
        .from(shifts)
        .where(and(eq(shifts.driverId, driverId), eq(shifts.status, "OPEN")))
        .limit(1);
      return { driverId, shift: rows[0] ?? null };
    });
  }

  async getById(id: string, ctx: ShiftContext): Promise<Shift> {
    return this.database.withTenant((tx) => this.visibleShift(tx, id, ctx, { lock: false }));
  }

  /**
   * The shift, if the caller may see it: staff see the tenant's, a driver only
   * their own. Ownership is checked after retrieval (docs/07 §4.3), and another
   * driver's shift is a 404, not a 403, so its existence is not confirmed. RLS
   * (0049) already hides a colleague's row from a driver session; this check
   * still holds in a session that ran without the driver scope.
   */
  private async visibleShift(
    tx: TenantTransaction,
    id: string,
    ctx: ShiftContext,
    options: { readonly lock: boolean },
  ): Promise<Shift> {
    const query = tx.select().from(shifts).where(eq(shifts.id, id)).limit(1);
    const rows = options.lock ? await query.for("update") : await query;
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Shift");
    }
    if (ctx.actorIsDriver && row.driverId !== (await callerDriverId(tx, ctx))) {
      throw new NotFoundError("Shift");
    }
    return row;
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

/**
 * A driver starts only their OWN shift (invariant I26 applied to shifts).
 *
 * The body still names the driver, because staff (the OWNER) start a shift on a
 * driver's behalf. For a DRIVER caller the body is checked against the driver
 * record behind the login and never trusted on its own. The refusal is the same
 * whether or not the named driver exists, so it is not an existence oracle.
 */
async function assertStartsOwnShift(
  tx: TenantTransaction,
  ctx: ShiftContext,
  driverId: string,
): Promise<void> {
  if (!ctx.actorIsDriver) {
    return;
  }
  const own = await callerDriverId(tx, ctx);
  if (own === null) {
    throw new ForbiddenError("This login is not linked to a driver.");
  }
  if (own !== driverId) {
    throw new ForbiddenError("A driver may only start their own shift.");
  }
}

/**
 * The `drivers.id` behind the caller's login, or null if there is none. A user
 * id is not a driver id (see {@link ShiftService.openShiftForUser}); migration
 * 0043 makes `(tenant_id, user_id)` unique, so this matches at most one row.
 */
async function callerDriverId(tx: TenantTransaction, ctx: ShiftContext): Promise<string | null> {
  const rows = await tx
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.userId, ctx.actorUserId))
    .limit(1);
  return rows[0]?.id ?? null;
}

function requireRow(rows: Shift[]): Shift {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Shift write returned no row");
  }
  return row;
}
