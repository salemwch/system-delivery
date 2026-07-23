import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, exists, gte, isNull, lt, lte, or, sql } from "drizzle-orm";

import { HubService } from "../../network/index.js";
import { OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import { FIELD_CIPHER, FieldCipher } from "../../../shared/crypto/index.js";
import {
  createDriverSchema,
  listAvailableSchema,
  listDriversSchema,
  updateDriverSchema,
} from "../domain/dtos.js";
import { drivers, shifts, vehicles } from "../domain/schema.js";

export type DriverStatus = "PENDING" | "ACTIVE" | "INACTIVE" | "SUSPENDED";

/**
 * A driver WITHOUT plaintext PII. `nationalId`/`licenceNumber` are never in a read
 * model — only booleans that say whether they are on file. Reveal is a separate,
 * authorised call (see {@link DriverService.revealPii}).
 */
export interface DriverView {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly employeeCode: string;
  readonly fullName: string;
  readonly phone: string;
  readonly hasNationalId: boolean;
  readonly hasLicence: boolean;
  readonly licenceExpiryAt: string | null;
  readonly status: string;
  readonly employmentType: string;
  readonly homeHubId: string | null;
  readonly defaultVehicleId: string | null;
  readonly skills: string[];
  readonly cashAccountId: string | null;
  readonly locale: string;
  readonly deviceId: string | null;
  readonly appVersion: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DriverPage {
  readonly items: DriverView[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Drivers — field couriers (docs/02-domain-model.md §3.3).
 *
 * `nationalId` and `licenceNumber` arrive as plaintext and are encrypted with the
 * shared {@link FieldCipher} before insert; the database never holds plaintext,
 * and read models expose only "is it on file" booleans. Deactivated, never
 * deleted. Emits `driver.created`. The DRIVER_CASH account (rule 1) and the
 * offboarding-with-cash guard (rule 3) attach when finance/dispatch exist.
 */
@Injectable()
export class DriverService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly hubs: HubService,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher,
  ) {}

  async create(input: unknown): Promise<DriverView> {
    const dto = parseWithZod(createDriverSchema, input);
    if (dto.homeHubId !== undefined) {
      await this.hubs.getById(dto.homeHubId); // clean NotFound for a bad hub
    }

    try {
      return await this.database.withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        if (dto.defaultVehicleId !== undefined) {
          await this.requireVehicle(tx, dto.defaultVehicleId);
        }

        const inserted = await tx
          .insert(drivers)
          .values({
            tenantId,
            employeeCode: dto.employeeCode,
            fullName: dto.fullName,
            phone: dto.phone,
            employmentType: dto.employmentType,
            ...(dto.nationalId === undefined
              ? {}
              : { nationalIdEncrypted: this.cipher.encrypt(dto.nationalId) }),
            ...(dto.licenceNumber === undefined
              ? {}
              : { licenceNumberEncrypted: this.cipher.encrypt(dto.licenceNumber) }),
            ...(dto.licenceExpiryAt === undefined ? {} : { licenceExpiryAt: dto.licenceExpiryAt }),
            ...(dto.homeHubId === undefined ? {} : { homeHubId: dto.homeHubId }),
            ...(dto.defaultVehicleId === undefined
              ? {}
              : { defaultVehicleId: dto.defaultVehicleId }),
            ...(dto.skills === undefined ? {} : { skills: dto.skills }),
            ...(dto.locale === undefined ? {} : { locale: dto.locale }),
            ...(dto.userId === undefined ? {} : { userId: dto.userId }),
            ...(dto.deviceId === undefined ? {} : { deviceId: dto.deviceId }),
            ...(dto.appVersion === undefined ? {} : { appVersion: dto.appVersion }),
          })
          .returning({ id: drivers.id });
        const id = requireId(inserted);

        await this.outbox.publish(tx, {
          eventType: "driver.created",
          aggregateType: "driver",
          aggregateId: id,
          payload: {
            driverId: id,
            employeeCode: dto.employeeCode,
            fullName: dto.fullName,
            employmentType: dto.employmentType,
          },
        });

        return this.viewById(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, "drivers_tenant_employee_uq")) {
        throw new ConflictError(
          "DRIVER_EMPLOYEE_CODE_TAKEN",
          `Employee code "${dto.employeeCode}" is already in use.`,
        );
      }
      if (isUniqueViolation(error, "drivers_tenant_phone_uq")) {
        throw new ConflictError(
          "DRIVER_PHONE_TAKEN",
          `A driver with phone ${dto.phone} already exists.`,
        );
      }
      throw error;
    }
  }

  async getById(id: string): Promise<DriverView> {
    return this.database.withTenant((tx) => this.viewById(tx, id));
  }

  /**
   * Decrypts a driver's PII for an authorised export (docs/07 §6, `pii:export`).
   * Deliberately separate from the read model so plaintext is fetched only on an
   * explicit, auditable call — never as a side effect of listing drivers.
   */
  async revealPii(
    id: string,
  ): Promise<{ nationalId: string | null; licenceNumber: string | null }> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({
          nationalId: drivers.nationalIdEncrypted,
          licence: drivers.licenceNumberEncrypted,
        })
        .from(drivers)
        .where(eq(drivers.id, id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Driver");
      }
      return {
        nationalId: this.cipher.decryptOptional(row.nationalId),
        licenceNumber: this.cipher.decryptOptional(row.licence),
      };
    });
  }

  async update(id: string, input: unknown): Promise<DriverView> {
    const dto = parseWithZod(updateDriverSchema, input);
    if (dto.homeHubId !== undefined && dto.homeHubId !== null) {
      await this.hubs.getById(dto.homeHubId);
    }
    try {
      return await this.database.withTenant(async (tx) => {
        if (dto.defaultVehicleId !== undefined && dto.defaultVehicleId !== null) {
          await this.requireVehicle(tx, dto.defaultVehicleId);
        }
        const updated = await tx
          .update(drivers)
          .set({
            updatedAt: sql`now()`,
            ...(dto.fullName === undefined ? {} : { fullName: dto.fullName }),
            ...(dto.phone === undefined ? {} : { phone: dto.phone }),
            ...(dto.nationalId === undefined
              ? {}
              : {
                  nationalIdEncrypted:
                    dto.nationalId === null ? null : this.cipher.encrypt(dto.nationalId),
                }),
            ...(dto.licenceNumber === undefined
              ? {}
              : {
                  licenceNumberEncrypted:
                    dto.licenceNumber === null ? null : this.cipher.encrypt(dto.licenceNumber),
                }),
            ...(dto.licenceExpiryAt === undefined ? {} : { licenceExpiryAt: dto.licenceExpiryAt }),
            ...(dto.homeHubId === undefined ? {} : { homeHubId: dto.homeHubId }),
            ...(dto.defaultVehicleId === undefined
              ? {}
              : { defaultVehicleId: dto.defaultVehicleId }),
            ...(dto.skills === undefined ? {} : { skills: dto.skills }),
            ...(dto.locale === undefined ? {} : { locale: dto.locale }),
            ...(dto.deviceId === undefined ? {} : { deviceId: dto.deviceId }),
            ...(dto.appVersion === undefined ? {} : { appVersion: dto.appVersion }),
          })
          .where(eq(drivers.id, id))
          .returning({ id: drivers.id });
        if (updated[0] === undefined) {
          throw new NotFoundError("Driver");
        }
        return this.viewById(tx, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, "drivers_tenant_phone_uq")) {
        throw new ConflictError("DRIVER_PHONE_TAKEN", "That phone number is already in use.");
      }
      throw error;
    }
  }

  async activate(id: string): Promise<DriverView> {
    return this.setStatus(id, "ACTIVE");
  }

  async suspend(id: string): Promise<DriverView> {
    return this.setStatus(id, "SUSPENDED");
  }

  /** The cross-module cash/route-stop guard (rule 3) attaches when finance/dispatch exist. */
  async deactivate(id: string): Promise<DriverView> {
    return this.setStatus(id, "INACTIVE");
  }

  async hasOpenShift(driverId: string): Promise<boolean> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: shifts.id })
        .from(shifts)
        .where(and(eq(shifts.driverId, driverId), eq(shifts.status, "OPEN")))
        .limit(1);
      return rows.length > 0;
    });
  }

  /**
   * Drivers that are ACTIVE, currently within an open shift covering `at`, and
   * hold every required skill — the dispatcher's assignable pool.
   */
  async listAvailable(input: unknown = {}): Promise<DriverView[]> {
    const dto = parseWithZod(listAvailableSchema, input);
    const at = dto.at ?? new Date();
    const requiredSkills = dto.skills ?? [];
    return this.database.withTenant(async (tx) => {
      // Correlated EXISTS built with drizzle comparators (not raw sql) so the
      // Date bind carries the timestamptz type; a raw `<= ${date}` mis-binds it.
      const openShiftCovering = exists(
        tx
          .select({ one: sql`1` })
          .from(shifts)
          .where(
            and(
              eq(shifts.driverId, drivers.id),
              lte(shifts.startedAt, at),
              or(isNull(shifts.endedAt), gte(shifts.endedAt, at)),
            ),
          ),
      );
      const conditions = [
        eq(drivers.status, "ACTIVE"),
        openShiftCovering,
        ...(requiredSkills.length === 0
          ? []
          : [
              sql`${drivers.skills} @> ARRAY[${sql.join(
                requiredSkills.map((s) => sql`${s}`),
                sql`, `,
              )}]::text[]`,
            ]),
      ];
      return selectDriverViews(tx, and(...conditions));
    });
  }

  async list(input: unknown = {}): Promise<DriverPage> {
    const dto = parseWithZod(listDriversSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(dto.status === undefined ? [] : [eq(drivers.status, dto.status)]),
        ...(dto.cursor === undefined ? [] : [lt(drivers.id, dto.cursor)]),
      ];
      const rows = await selectDriverViews(
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

  private async setStatus(id: string, status: DriverStatus): Promise<DriverView> {
    return this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(drivers)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(drivers.id, id))
        .returning({ id: drivers.id });
      if (updated[0] === undefined) {
        throw new NotFoundError("Driver");
      }
      return this.viewById(tx, id);
    });
  }

  private async requireVehicle(tx: TenantTransaction, vehicleId: string): Promise<void> {
    const rows = await tx
      .select({ id: vehicles.id })
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId))
      .limit(1);
    if (rows[0] === undefined) {
      throw new BusinessRuleError("VEHICLE_NOT_FOUND", "The default vehicle does not exist.");
    }
  }

  private async viewById(tx: TenantTransaction, id: string): Promise<DriverView> {
    const rows = await selectDriverViews(tx, eq(drivers.id, id), 1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Driver");
    }
    return row;
  }
}

async function selectDriverViews(
  tx: TenantTransaction,
  where: ReturnType<typeof eq> | undefined,
  limit?: number,
): Promise<DriverView[]> {
  const base = tx
    .select({
      id: drivers.id,
      tenantId: drivers.tenantId,
      userId: drivers.userId,
      employeeCode: drivers.employeeCode,
      fullName: drivers.fullName,
      phone: drivers.phone,
      hasNationalId: sql<boolean>`${drivers.nationalIdEncrypted} IS NOT NULL`,
      hasLicence: sql<boolean>`${drivers.licenceNumberEncrypted} IS NOT NULL`,
      licenceExpiryAt: drivers.licenceExpiryAt,
      status: drivers.status,
      employmentType: drivers.employmentType,
      homeHubId: drivers.homeHubId,
      defaultVehicleId: drivers.defaultVehicleId,
      skills: drivers.skills,
      cashAccountId: drivers.cashAccountId,
      locale: drivers.locale,
      deviceId: drivers.deviceId,
      appVersion: drivers.appVersion,
      createdAt: drivers.createdAt,
      updatedAt: drivers.updatedAt,
    })
    .from(drivers)
    .where(where)
    .orderBy(desc(drivers.id));
  return limit === undefined ? base : base.limit(limit);
}

function requireId(rows: { id: string }[]): string {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Driver insert returned no row");
  }
  return row.id;
}
