import { Injectable } from "@nestjs/common";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { DatabaseService, TenantContext } from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  addWorkingHours,
  nextWorkingInstant,
  parseTimeToMinutes,
} from "../domain/working-calendar.js";
import type { IsoWeekday, WorkingCalendar } from "../domain/working-calendar.js";
import { failureReasons, holidays, slaTemplates, tenants, workingHours } from "../domain/schema.js";
import type { FailureReasonRow, SlaTemplateRow } from "../domain/schema.js";

/** What a driver's app needs to render the failure picker. */
export interface FailureReasonView {
  readonly code: string;
  readonly labels: Record<string, string>;
  readonly allowsReattempt: boolean;
  readonly fault: string;
  readonly displayOrder: number;
}

export interface ReattemptDecision {
  /** False → the shipment goes straight to RETURN_PENDING. */
  readonly allowed: boolean;
  /** When the next attempt may be made. Null when no further attempt is due. */
  readonly nextAttemptAt: Date | null;
  readonly reason: "ALLOWED" | "REASON_FORBIDS" | "ATTEMPTS_EXHAUSTED";
}

const upsertFailureReasonSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,48}$/u, "must be SCREAMING_SNAKE_CASE"),
  /**
   * Any SUBSET of the supported locales — a tenant that operates only in French
   * and Arabic should not have to invent an English label.
   *
   * Not `z.record(z.enum([...]), …)`: with an enum key Zod treats the key set as
   * exhaustive and demands every locale, which would reject exactly that case.
   * At least one is required, because a reason with no labels renders as a blank
   * row in the driver's picker.
   */
  labels: z
    .strictObject({
      ar: z.string().trim().min(1).max(200).optional(),
      fr: z.string().trim().min(1).max(200).optional(),
      en: z.string().trim().min(1).max(200).optional(),
    })
    .refine((value) => Object.values(value).some((label) => label !== undefined), {
      message: "at least one locale label is required",
    }),
  allowsReattempt: z.boolean(),
  fault: z.enum(["RECIPIENT", "COURIER", "MERCHANT", "EXTERNAL"]).optional(),
  displayOrder: z.coerce.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
});

const setWorkingHoursSchema = z.strictObject({
  days: z
    .array(
      z.strictObject({
        dayOfWeek: z.coerce.number().int().min(1).max(7),
        opensAt: z.string().regex(/^\d{2}:\d{2}$/u),
        closesAt: z.string().regex(/^\d{2}:\d{2}$/u),
        isWorking: z.boolean(),
      }),
    )
    .length(7, "all seven days must be supplied — a partial week is ambiguous"),
});

const setSlaTemplateSchema = z.strictObject({
  serviceLevel: z.enum(["STANDARD", "EXPRESS", "SAME_DAY"]),
  deliveryHours: z.coerce.number().int().min(1).max(8760),
  reattemptDelayHours: z.coerce.number().int().min(0).max(720),
  maxAttempts: z.coerce.number().int().min(1).max(10),
});

const holidaySchema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be YYYY-MM-DD"),
  label: z.string().trim().max(200).optional(),
});

/**
 * Per-tenant operating configuration and the scheduling it drives
 * (docs/01-mvp-scope.md §4.1 #1.8, §4.2 #2.7, §4.7 #7.7).
 *
 * Three things live here that were previously TypeScript constants, and each was
 * wrong as a constant:
 *
 *  - the FAILURE TAXONOMY, which DM5 wants confirmed against a real courier;
 *  - WORKING HOURS, hardcoded to a Saturday–Sunday weekend that is wrong for
 *    much of the region this platform targets;
 *  - SLA TEMPLATES, which did not exist at all.
 *
 * ⚠️ `decideReattempt` is the reason this module matters. `allowsReattempt` was
 * defined in the old constants and NEVER CONSULTED — a parcel the customer had
 * explicitly refused was driven out twice more before returning. In a COD market
 * each of those is a wasted trip plus a return leg.
 */
@Injectable()
export class OperatingConfigService {
  constructor(private readonly database: DatabaseService) {}

  // ── Failure reasons (#7.7) ────────────────────────────────────────────────

  async listFailureReasons(includeInactive = false): Promise<readonly FailureReasonView[]> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(failureReasons)
        .where(includeInactive ? undefined : eq(failureReasons.active, true))
        .orderBy(asc(failureReasons.displayOrder), asc(failureReasons.code));
      return rows.map(toReasonView);
    });
  }

  async upsertFailureReason(input: unknown): Promise<FailureReasonView> {
    const dto = parseWithZod(upsertFailureReasonSchema, input);

    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const inserted = await tx
        .insert(failureReasons)
        .values({
          tenantId,
          code: dto.code,
          labels: dto.labels,
          allowsReattempt: dto.allowsReattempt,
          fault: dto.fault ?? "RECIPIENT",
          displayOrder: dto.displayOrder ?? 100,
          active: dto.active ?? true,
        })
        .onConflictDoUpdate({
          target: [failureReasons.tenantId, failureReasons.code],
          set: {
            labels: dto.labels,
            allowsReattempt: dto.allowsReattempt,
            fault: dto.fault ?? "RECIPIENT",
            displayOrder: dto.displayOrder ?? 100,
            active: dto.active ?? true,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) {
        throw new Error("Failure reason upsert returned no row");
      }
      return toReasonView(row);
    });
  }

  /**
   * Retires a reason without deleting it.
   *
   * ⚠️ Deactivated, never removed. `code` is written to `shipment_events`, so a
   * deleted reason would leave every past attempt referring to something that no
   * longer exists — and a failure report from last quarter would silently lose
   * rows.
   */
  async deactivateFailureReason(code: string): Promise<void> {
    await this.database.withTenant(async (tx) => {
      const updated = await tx
        .update(failureReasons)
        .set({ active: false, updatedAt: sql`now()` })
        .where(eq(failureReasons.code, code))
        .returning({ id: failureReasons.id });

      if (updated[0] === undefined) {
        throw new NotFoundError("Failure reason");
      }
    });
  }

  // ── Working hours and holidays (#1.8) ─────────────────────────────────────

  async setWorkingHours(input: unknown): Promise<void> {
    const dto = parseWithZod(setWorkingHoursSchema, input);

    // Validated before any write: a day that closes before it opens makes every
    // scheduling call return nothing, and finding out at the fourth row leaves a
    // half-written week.
    for (const day of dto.days) {
      if (parseTimeToMinutes(day.closesAt) <= parseTimeToMinutes(day.opensAt)) {
        throw new NotFoundError(
          `Working day ${String(day.dayOfWeek)} closes at or before it opens`,
        );
      }
    }

    await this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      for (const day of dto.days) {
        await tx
          .insert(workingHours)
          .values({
            tenantId,
            dayOfWeek: day.dayOfWeek,
            opensAt: day.opensAt,
            closesAt: day.closesAt,
            isWorking: day.isWorking,
          })
          .onConflictDoUpdate({
            target: [workingHours.tenantId, workingHours.dayOfWeek],
            set: {
              opensAt: day.opensAt,
              closesAt: day.closesAt,
              isWorking: day.isWorking,
              updatedAt: sql`now()`,
            },
          });
      }
    });
  }

  async addHoliday(input: unknown): Promise<void> {
    const dto = parseWithZod(holidaySchema, input);
    await this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      await tx
        .insert(holidays)
        .values({ tenantId, day: dto.day, label: dto.label ?? "" })
        .onConflictDoNothing();
    });
  }

  async removeHoliday(day: string): Promise<void> {
    await this.database.withTenant(async (tx) => {
      await tx.delete(holidays).where(eq(holidays.day, day));
    });
  }

  // ── SLA templates (#1.8) ──────────────────────────────────────────────────

  async setSlaTemplate(input: unknown): Promise<void> {
    const dto = parseWithZod(setSlaTemplateSchema, input);
    await this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      await tx
        .insert(slaTemplates)
        .values({
          tenantId,
          serviceLevel: dto.serviceLevel,
          deliveryHours: dto.deliveryHours,
          reattemptDelayHours: dto.reattemptDelayHours,
          maxAttempts: dto.maxAttempts,
        })
        .onConflictDoUpdate({
          target: [slaTemplates.tenantId, slaTemplates.serviceLevel],
          set: {
            deliveryHours: dto.deliveryHours,
            reattemptDelayHours: dto.reattemptDelayHours,
            maxAttempts: dto.maxAttempts,
            updatedAt: sql`now()`,
          },
        });
    });
  }

  async listSlaTemplates(): Promise<readonly SlaTemplateRow[]> {
    return this.database.withTenant(async (tx) =>
      tx.select().from(slaTemplates).orderBy(asc(slaTemplates.serviceLevel)),
    );
  }

  // ── The scheduling this configuration exists for ──────────────────────────

  /**
   * The promised delivery instant for a shipment accepted now.
   *
   * Measured in WORKING hours: a parcel accepted at 17:00 on Friday with a
   * 24-hour promise is due Monday, not Saturday evening.
   */
  async promisedBy(
    tx: TenantTransaction,
    serviceLevel: string,
    from: Date = new Date(),
  ): Promise<Date | null> {
    const template = await this.slaFor(tx, serviceLevel);
    if (template === null) {
      return null;
    }
    const calendar = await this.calendarFor(tx);
    return addWorkingHours(from, template.deliveryHours, calendar);
  }

  /**
   * Whether a failed delivery may be re-attempted, and when.
   *
   * ⚠️ Consults the REASON first, and that is the fix this module exists for.
   * `allowsReattempt` was defined in the old constants and never read, so a
   * `CUSTOMER_REFUSED` parcel consumed its remaining attempts — each one a
   * wasted trip to a customer who had already said no, plus the return leg
   * afterwards.
   */
  async decideReattempt(
    tx: TenantTransaction,
    input: {
      readonly reasonCode: string;
      readonly attemptNumber: number;
      readonly maxAttempts: number;
      readonly serviceLevel: string;
      readonly failedAt?: Date;
    },
  ): Promise<ReattemptDecision> {
    const reasonRows = await tx
      .select({ allowsReattempt: failureReasons.allowsReattempt })
      .from(failureReasons)
      .where(eq(failureReasons.code, input.reasonCode))
      .limit(1);

    const reason = reasonRows[0];
    // An unknown code is treated as re-attemptable. Fail OPEN here on purpose:
    // refusing to retry because a tenant mistyped a code would strand a
    // deliverable parcel, and the attempt cap still bounds the damage.
    if (reason !== undefined && !reason.allowsReattempt) {
      return { allowed: false, nextAttemptAt: null, reason: "REASON_FORBIDS" };
    }

    if (input.attemptNumber >= input.maxAttempts) {
      return { allowed: false, nextAttemptAt: null, reason: "ATTEMPTS_EXHAUSTED" };
    }

    const template = await this.slaFor(tx, input.serviceLevel);
    const delayHours = template?.reattemptDelayHours ?? DEFAULT_REATTEMPT_DELAY_HOURS;
    const calendar = await this.calendarFor(tx);
    const failedAt = input.failedAt ?? new Date();

    // Delay measured in working hours, then landed on a working instant: a parcel
    // that fails at 17:55 on Saturday is due Monday at opening, not Sunday.
    const earliest =
      delayHours === 0
        ? nextWorkingInstant(failedAt, calendar)
        : addWorkingHours(failedAt, delayHours, calendar);

    return { allowed: true, nextAttemptAt: earliest, reason: "ALLOWED" };
  }

  /** The tenant's working calendar, assembled from its own rows. */
  async calendarFor(tx: TenantTransaction): Promise<WorkingCalendar> {
    const tenantId = TenantContext.requireTenantId();

    const [tenantRow] = await tx
      .select({ timezone: tenants.defaultTimezone })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const dayRows = await tx.select().from(workingHours).orderBy(asc(workingHours.dayOfWeek));
    const holidayRows = await tx.select({ day: holidays.day }).from(holidays);

    return {
      timezone: tenantRow?.timezone ?? "Africa/Tunis",
      // A tenant with no configured week falls back to Monday–Saturday. Not a
      // silent guess: 0026 seeds every tenant, so an empty set means someone
      // deleted the rows, and a courier that can never schedule anything is a
      // worse failure than a sensible default.
      days:
        dayRows.length > 0
          ? dayRows.map((row) => ({
              dayOfWeek: row.dayOfWeek as IsoWeekday,
              opensAtMinutes: parseTimeToMinutes(row.opensAt),
              closesAtMinutes: parseTimeToMinutes(row.closesAt),
              isWorking: row.isWorking,
            }))
          : FALLBACK_WEEK,
      holidays: new Set(holidayRows.map((row) => row.day)),
    };
  }

  private async slaFor(
    tx: TenantTransaction,
    serviceLevel: string,
  ): Promise<SlaTemplateRow | null> {
    const rows = await tx
      .select()
      .from(slaTemplates)
      .where(eq(slaTemplates.serviceLevel, serviceLevel))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** Used only when a tenant's `working_hours` rows are missing entirely. */
const FALLBACK_WEEK: readonly {
  dayOfWeek: IsoWeekday;
  opensAtMinutes: number;
  closesAtMinutes: number;
  isWorking: boolean;
}[] = [
  { dayOfWeek: 1, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
  { dayOfWeek: 2, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
  { dayOfWeek: 3, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
  { dayOfWeek: 4, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
  { dayOfWeek: 5, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
  { dayOfWeek: 6, opensAtMinutes: 480, closesAtMinutes: 780, isWorking: true },
  { dayOfWeek: 7, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: false },
];

const DEFAULT_REATTEMPT_DELAY_HOURS = 24;

function toReasonView(row: FailureReasonRow): FailureReasonView {
  return {
    code: row.code,
    // JSONB comes back as unknown; a malformed labels blob renders as no labels
    // rather than crashing a driver's picker.
    labels:
      typeof row.labels === "object" && row.labels !== null
        ? (row.labels as Record<string, string>)
        : {},
    allowsReattempt: row.allowsReattempt,
    fault: row.fault,
    displayOrder: row.displayOrder,
  };
}
