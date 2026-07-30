import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import {
  addWorkingHours,
  instantAtLocalTime,
  localPartsOf,
  nextWorkingInstant,
  parseTimeToMinutes,
} from "../src/modules/platform/domain/working-calendar.js";
import type { WorkingCalendar } from "../src/modules/platform/domain/working-calendar.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { ValidationError } from "../src/shared/errors/index.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Per-tenant operating configuration (docs/01 §4.1 #1.8, §4.2 #2.7, §4.7 #7.7).
 *
 * ⚠️ The most important test here is `refuses to re-attempt a REFUSED parcel`.
 * `allowsReattempt` existed in the old hardcoded taxonomy and was never
 * consulted, so a parcel the customer had explicitly refused was driven out
 * twice more before returning — each one a wasted trip plus a return leg, which
 * is the most expensive ordinary mistake in a COD market.
 */
describe("operating config", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let config: OperatingConfigService;
  let shipments: ShipmentService;
  let merchants: MerchantService;
  let createdTenants: string[] = [];

  async function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  /**
   * Runs `fn` in a tenant-scoped transaction AND under ambient tenant context.
   *
   * Both are needed, and they are not the same thing: the argument to
   * `withTenant` sets the Postgres GUC that RLS reads, while services call
   * `TenantContext.requireTenantId()` for the id itself. A real request always
   * has both, because the interceptor binds the context before any query runs.
   */
  async function inTenantTx<T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof db.withTenant>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return asStaff(tenantId, () => db.withTenant(fn, asTenantId(tenantId)));
  }

  /**
   * A tenant with the operating configuration provisioning gives it.
   *
   * The defaults used to be re-typed here, which is why this suite kept asserting
   * against a `SAME_DAY` SLA level no shipment can ever have. `createTenant` now
   * seeds from the same constants `TenantService.provision` uses, so a default
   * these tests rely on cannot differ from the one a real courier gets.
   */
  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    config = new OperatingConfigService(db);

    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    merchants = new MerchantService(db, outbox);
    const recipients = new RecipientService(db);
    const events = new ShipmentEventService(outbox);
    shipments = new ShipmentService(db, events, outbox, merchants, recipients, addresses, config);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── The calendar arithmetic, in isolation ──────────────────────────────────

  describe("working calendar", () => {
    /** Mon–Fri 08:00–18:00, Sat 08:00–13:00, Sun closed. Africa/Tunis. */
    const tunis: WorkingCalendar = {
      timezone: "Africa/Tunis",
      days: [
        { dayOfWeek: 1, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
        { dayOfWeek: 2, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
        { dayOfWeek: 3, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
        { dayOfWeek: 4, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
        { dayOfWeek: 5, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
        { dayOfWeek: 6, opensAtMinutes: 480, closesAtMinutes: 780, isWorking: true },
        { dayOfWeek: 7, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: false },
      ],
      holidays: new Set(["2026-08-13"]),
    };

    it("parses times and rejects nonsense", () => {
      expect(parseTimeToMinutes("08:00")).toBe(480);
      expect(parseTimeToMinutes("13:30")).toBe(810);
      expect(parseTimeToMinutes("18:00:00")).toBe(1080);
      expect(() => parseTimeToMinutes("25:00")).toThrow();
      expect(() => parseTimeToMinutes("8:00")).toThrow();
    });

    it("reads local parts in the tenant's timezone, not UTC", () => {
      // 2026-07-30 is a Thursday. 21:30 UTC is 22:30 in Tunis (UTC+1).
      const parts = localPartsOf(new Date("2026-07-30T21:30:00Z"), "Africa/Tunis");
      expect(parts.dateKey).toBe("2026-07-30");
      expect(parts.weekday).toBe(4);
      expect(parts.minutes).toBe(22 * 60 + 30);
    });

    it("round-trips a local wall-clock time back to the same instant", () => {
      const instant = instantAtLocalTime(2026, 7, 30, 8 * 60, "Africa/Tunis");
      const parts = localPartsOf(instant, "Africa/Tunis");
      expect(parts.dateKey).toBe("2026-07-30");
      expect(parts.minutes).toBe(480);
    });

    it("returns NOW when already inside working hours", () => {
      // Thursday 10:00 local.
      const inside = instantAtLocalTime(2026, 7, 30, 600, "Africa/Tunis");
      expect(nextWorkingInstant(inside, tunis).getTime()).toBe(inside.getTime());
    });

    it("waits for opening when called before the doors open", () => {
      const early = instantAtLocalTime(2026, 7, 30, 6 * 60, "Africa/Tunis");
      const parts = localPartsOf(nextWorkingInstant(early, tunis), "Africa/Tunis");
      expect(parts.dateKey).toBe("2026-07-30");
      expect(parts.minutes).toBe(480);
    });

    it("SKIPS SUNDAY — a Saturday-evening failure is due Monday", () => {
      // Saturday 2026-08-01, 17:55 local — after the 13:00 Saturday close.
      const saturdayEvening = instantAtLocalTime(2026, 8, 1, 17 * 60 + 55, "Africa/Tunis");
      const parts = localPartsOf(nextWorkingInstant(saturdayEvening, tunis), "Africa/Tunis");

      // Monday the 3rd at opening. Promising a customer a delivery on a day
      // nobody works is worse than promising nothing.
      expect(parts.dateKey).toBe("2026-08-03");
      expect(parts.weekday).toBe(1);
      expect(parts.minutes).toBe(480);
    });

    it("skips a configured holiday", () => {
      // 2026-08-13 is a Thursday, marked a holiday above.
      const onHoliday = instantAtLocalTime(2026, 8, 13, 9 * 60, "Africa/Tunis");
      const parts = localPartsOf(nextWorkingInstant(onHoliday, tunis), "Africa/Tunis");
      expect(parts.dateKey).toBe("2026-08-14");
    });

    it("adds WORKING hours, not elapsed hours", () => {
      // Friday 2026-07-31 at 17:00, plus 24 working hours.
      const fridayEvening = instantAtLocalTime(2026, 7, 31, 17 * 60, "Africa/Tunis");
      const due = addWorkingHours(fridayEvening, 24, tunis);
      const parts = localPartsOf(due, "Africa/Tunis");

      // 1h Friday + 5h Saturday + 10h Monday + 8h Tuesday = 24. Measured in
      // wall-clock time it would be due Saturday evening — marked late before
      // anyone could have delivered it, on a day the courier is shut.
      expect(parts.weekday).toBe(2);
      expect(parts.dateKey).toBe("2026-08-04");
    });

    it("adding zero hours still lands on a working instant", () => {
      const sunday = instantAtLocalTime(2026, 8, 2, 12 * 60, "Africa/Tunis");
      const parts = localPartsOf(addWorkingHours(sunday, 0, tunis), "Africa/Tunis");
      expect(parts.dateKey).toBe("2026-08-03");
    });

    it("refuses a negative duration", () => {
      expect(() => addWorkingHours(new Date(), -1, tunis)).toThrow(/negative/u);
    });

    it("throws rather than hanging when no day is a working day", () => {
      const closed: WorkingCalendar = {
        timezone: "Africa/Tunis",
        days: tunis.days.map((d) => ({ ...d, isWorking: false })),
        holidays: new Set(),
      };
      // A tenant that can never schedule anything is a configuration error that
      // must surface, not an infinite search.
      expect(() => nextWorkingInstant(new Date(), closed)).toThrow(/no open days/u);
    });

    it("handles a Friday–Saturday weekend, which much of the region uses", () => {
      const gulf: WorkingCalendar = {
        timezone: "Asia/Dubai",
        days: [
          { dayOfWeek: 1, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
          { dayOfWeek: 2, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
          { dayOfWeek: 3, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
          { dayOfWeek: 4, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
          { dayOfWeek: 5, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: false },
          { dayOfWeek: 6, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: false },
          { dayOfWeek: 7, opensAtMinutes: 480, closesAtMinutes: 1080, isWorking: true },
        ],
        holidays: new Set(),
      };

      // Thursday evening → Sunday. The old hardcoded [6,7] weekend would have
      // said Friday, which is the weekend there.
      const thursdayLate = instantAtLocalTime(2026, 7, 30, 19 * 60, "Asia/Dubai");
      const parts = localPartsOf(nextWorkingInstant(thursdayLate, gulf), "Asia/Dubai");
      expect(parts.weekday).toBe(7);
    });
  });

  // ── Failure reasons as data ────────────────────────────────────────────────

  describe("failure reasons", () => {
    it("seeds a taxonomy a driver can render in their own language", async () => {
      const tenantId = await seedTenant("opcfg");
      const reasons = await asStaff(tenantId, () => config.listFailureReasons());

      expect(reasons.length).toBeGreaterThan(0);
      const refused = reasons.find((r) => r.code === "CUSTOMER_REFUSED");
      expect(refused?.allowsReattempt).toBe(false);
      expect(refused?.labels["fr"]).toBe("Refus du client");
    });

    it("lets a tenant add its own reason", async () => {
      const tenantId = await seedTenant("opcfg");
      await asStaff(tenantId, () =>
        config.upsertFailureReason({
          code: "RAMADAN_HOURS",
          labels: { fr: "Horaires Ramadan", ar: "توقيت رمضان" },
          allowsReattempt: true,
          fault: "EXTERNAL",
          displayOrder: 15,
        }),
      );

      const reasons = await asStaff(tenantId, () => config.listFailureReasons());
      // DM5 wants the taxonomy confirmed with a real courier — impossible if
      // changing it is a deploy.
      expect(reasons.some((r) => r.code === "RAMADAN_HOURS")).toBe(true);
    });

    it("rejects a code that is not a stable identifier", async () => {
      const tenantId = await seedTenant("opcfg");
      await expect(
        asStaff(tenantId, () =>
          config.upsertFailureReason({
            code: "customer refused",
            labels: { fr: "x" },
            allowsReattempt: true,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("DEACTIVATES rather than deletes, so past attempts keep their reason", async () => {
      const tenantId = await seedTenant("opcfg");
      await asStaff(tenantId, () => config.deactivateFailureReason("INSUFFICIENT_CASH"));

      const active = await asStaff(tenantId, () => config.listFailureReasons());
      expect(active.some((r) => r.code === "INSUFFICIENT_CASH")).toBe(false);

      // Still there. `code` is written to shipment_events, so deleting it would
      // orphan every past attempt and silently shrink last quarter's report.
      const all = await asStaff(tenantId, () => config.listFailureReasons(true));
      expect(all.some((r) => r.code === "INSUFFICIENT_CASH")).toBe(true);
    });

    it("never shows one tenant another's taxonomy", async () => {
      const tenantA = await seedTenant("opcfg-a");
      const tenantB = await seedTenant("opcfg-b");
      await asStaff(tenantA, () =>
        config.upsertFailureReason({
          code: "TENANT_A_ONLY",
          labels: { fr: "x" },
          allowsReattempt: true,
        }),
      );

      const forB = await asStaff(tenantB, () => config.listFailureReasons());
      expect(forB.some((r) => r.code === "TENANT_A_ONLY")).toBe(false);
    });
  });

  // ── The re-attempt decision ────────────────────────────────────────────────

  describe("re-attempt decision", () => {
    it("REFUSES to re-attempt a REFUSED parcel, whatever the attempt count", async () => {
      const tenantId = await seedTenant("opcfg");

      const decision = await inTenantTx(tenantId, (tx) =>
        config.decideReattempt(tx, {
          reasonCode: "CUSTOMER_REFUSED",
          // First attempt of three. Under the old code this would have been
          // driven out twice more.
          attemptNumber: 1,
          maxAttempts: 3,
          serviceLevel: "STANDARD",
        }),
      );

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("REASON_FORBIDS");
      expect(decision.nextAttemptAt).toBeNull();
    });

    it("allows a re-attempt when the customer was merely absent", async () => {
      const tenantId = await seedTenant("opcfg");

      const decision = await inTenantTx(tenantId, (tx) =>
        config.decideReattempt(tx, {
          reasonCode: "CUSTOMER_UNAVAILABLE",
          attemptNumber: 1,
          maxAttempts: 3,
          serviceLevel: "STANDARD",
        }),
      );

      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe("ALLOWED");
      expect(decision.nextAttemptAt).not.toBeNull();
    });

    it("stops at the attempt cap even for a re-attemptable reason", async () => {
      const tenantId = await seedTenant("opcfg");

      const decision = await inTenantTx(tenantId, (tx) =>
        config.decideReattempt(tx, {
          reasonCode: "CUSTOMER_UNAVAILABLE",
          attemptNumber: 3,
          maxAttempts: 3,
          serviceLevel: "STANDARD",
        }),
      );

      // Domain rule 9.
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("ATTEMPTS_EXHAUSTED");
    });

    it("fails OPEN on an unknown reason code", async () => {
      const tenantId = await seedTenant("opcfg");

      const decision = await inTenantTx(tenantId, (tx) =>
        config.decideReattempt(tx, {
          reasonCode: "SOMETHING_A_TENANT_MISTYPED",
          attemptNumber: 1,
          maxAttempts: 3,
          serviceLevel: "STANDARD",
        }),
      );

      // Refusing to retry because of a typo would strand a deliverable parcel,
      // and the attempt cap still bounds the damage.
      expect(decision.allowed).toBe(true);
    });

    it("schedules the next attempt on a WORKING instant", async () => {
      const tenantId = await seedTenant("opcfg");

      const decision = await inTenantTx(tenantId, (tx) =>
        config.decideReattempt(tx, {
          reasonCode: "CUSTOMER_UNAVAILABLE",
          attemptNumber: 1,
          maxAttempts: 3,
          serviceLevel: "STANDARD",
          // Saturday 17:55 — after the Saturday close.
          failedAt: instantAtLocalTime(2026, 8, 1, 17 * 60 + 55, "Africa/Tunis"),
        }),
      );

      expect(decision.nextAttemptAt).not.toBeNull();
      if (decision.nextAttemptAt === null) throw new Error("unreachable");
      const parts = localPartsOf(decision.nextAttemptAt, "Africa/Tunis");
      // Never a Sunday.
      expect(parts.weekday).not.toBe(7);
    });
  });

  // ── End to end through the shipment ────────────────────────────────────────

  describe("shipment integration", () => {
    async function createShipment(tenantId: string): Promise<string> {
      const merchantId = await asStaff(
        tenantId,
        async () => (await merchants.create({ name: "Boutique" })).id,
      );
      const created = await asStaff(tenantId, () =>
        shipments.create(
          {
            idempotencyKey: randomUUID(),
            merchantId,
            senderName: "Boutique",
            senderPhone: "+21620000001",
            origin: {
              rawInput: "Tunis",
              countryCode: "TN",
              coordinates: { lat: 36.8, lng: 10.18 },
            },
            recipientName: "Ahmed Ben Ali",
            recipientPhone: "+21620000002",
            destination: {
              rawInput: "Sfax",
              countryCode: "TN",
              coordinates: { lat: 34.74, lng: 10.76 },
            },
            currency: "TND",
            codAmountMinor: 45_000,
          },
          { actor: { actorType: "API_CLIENT" } },
        ),
      );
      return created.id;
    }

    it("sets a promised date from the SLA template", async () => {
      const tenantId = await seedTenant("opcfg");
      const shipmentId = await createShipment(tenantId);

      const shipment = await asStaff(tenantId, () => shipments.getById(shipmentId));
      // Previously nothing computed this, so on-time reporting had nothing to
      // measure against.
      expect(shipment.promisedTo).not.toBeNull();
      if (shipment.promisedTo === null) throw new Error("unreachable");
      const parts = localPartsOf(shipment.promisedTo, "Africa/Tunis");
      expect(parts.weekday).not.toBe(7);
    });

    it("stores the taxonomy and calendar per tenant", async () => {
      const tenantId = await seedTenant("opcfg");
      const templates = await asStaff(tenantId, () => config.listSlaTemplates());
      // ⚠️ Exactly the three `shipments.service_level` allows. It used to read
      // SAME_DAY, which no shipment can ever be — so those rows could never
      // apply, while a SCHEDULED shipment had no template at all and silently
      // fell back to a hardcoded re-attempt delay instead of its tenant's own.
      expect(templates.map((t) => t.serviceLevel).sort()).toEqual([
        "EXPRESS",
        "SCHEDULED",
        "STANDARD",
      ]);
      expect(await createShipment(tenantId)).toBeDefined();
    });
  });

  // ── Configuration writes ───────────────────────────────────────────────────

  describe("configuration", () => {
    it("sets a whole working week at once", async () => {
      const tenantId = await seedTenant("opcfg");
      await asStaff(tenantId, () =>
        config.setWorkingHours({
          days: [
            { dayOfWeek: 1, opensAt: "09:00", closesAt: "17:00", isWorking: true },
            { dayOfWeek: 2, opensAt: "09:00", closesAt: "17:00", isWorking: true },
            { dayOfWeek: 3, opensAt: "09:00", closesAt: "17:00", isWorking: true },
            { dayOfWeek: 4, opensAt: "09:00", closesAt: "17:00", isWorking: true },
            { dayOfWeek: 5, opensAt: "09:00", closesAt: "17:00", isWorking: false },
            { dayOfWeek: 6, opensAt: "09:00", closesAt: "17:00", isWorking: false },
            { dayOfWeek: 7, opensAt: "09:00", closesAt: "17:00", isWorking: true },
          ],
        }),
      );

      const calendar = await inTenantTx(tenantId, (tx) => config.calendarFor(tx));
      expect(calendar.days.find((d) => d.dayOfWeek === 5)?.isWorking).toBe(false);
      expect(calendar.days.find((d) => d.dayOfWeek === 7)?.isWorking).toBe(true);
    });

    it("refuses a partial week", async () => {
      const tenantId = await seedTenant("opcfg");
      await expect(
        asStaff(tenantId, () =>
          config.setWorkingHours({
            days: [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "17:00", isWorking: true }],
          }),
        ),
        // A partial week leaves the other days ambiguous, and every scheduling
        // call would silently use whatever was there before.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("adds and removes a holiday", async () => {
      const tenantId = await seedTenant("opcfg");
      await asStaff(tenantId, () =>
        config.addHoliday({ day: "2026-08-13", label: "Fête de la Femme" }),
      );

      let calendar = await inTenantTx(tenantId, (tx) => config.calendarFor(tx));
      expect(calendar.holidays.has("2026-08-13")).toBe(true);

      await asStaff(tenantId, () => config.removeHoliday("2026-08-13"));
      calendar = await inTenantTx(tenantId, (tx) => config.calendarFor(tx));
      expect(calendar.holidays.has("2026-08-13")).toBe(false);
    });

    it("updates an SLA template rather than duplicating it", async () => {
      const tenantId = await seedTenant("opcfg");
      await asStaff(tenantId, () =>
        config.setSlaTemplate({
          serviceLevel: "EXPRESS",
          deliveryHours: 6,
          reattemptDelayHours: 3,
          maxAttempts: 2,
        }),
      );

      const templates = await asStaff(tenantId, () => config.listSlaTemplates());
      const express = templates.filter((t) => t.serviceLevel === "EXPRESS");
      expect(express).toHaveLength(1);
      expect(express[0]?.deliveryHours).toBe(6);
    });
  });
});
