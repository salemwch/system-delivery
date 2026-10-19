import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressCorrectionService } from "../src/modules/directory/application/address-correction.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  seedDriverLogin,
  withTenantContext,
} from "./database.harness.js";
import type { DriverLogin, TestDatabase } from "./database.harness.js";

/**
 * Driver geocode corrections (docs/01-mvp-scope.md 2.10; docs/03 command
 * `CorrectAddressGeocode`; migration 0051).
 *
 * Real PostgreSQL with the app role, so RLS, the column grants and the status
 * trigger are what is under test, not a mock of them.
 */
describe("address corrections", () => {
  let database: TestDatabase;
  let addresses: AddressService;
  let corrections: AddressCorrectionService;
  let created: string[] = [];

  // Tunis centre, and points at known distances from it.
  const TUNIS = { lat: 36.8, lng: 10.18 };
  const NEAR = { lat: 36.801, lng: 10.181 }; // ≈ 140 m
  const FAR = { lat: 36.85, lng: 10.18 }; // ≈ 5.6 km

  async function seedTenant(): Promise<string> {
    const id = await createTenant(database.migrator, `corr-${randomUUID().slice(0, 6)}`);
    created.push(id);
    return id;
  }

  async function seedStaff(tenantId: string): Promise<string> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${`staff-${randomUUID().slice(0, 8)}@test.tn`}, 'hash', 'Staff', 'ACTIVE')
        returning id`,
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("failed to seed staff");
    return id;
  }

  function asStaff<T>(tenantId: string, userId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId: userId },
      fn,
    );
  }

  function asDriver<T>(tenantId: string, login: DriverLogin, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      {
        tenantId: asTenantId(tenantId),
        actorType: "driver",
        actorId: login.userId,
        driverId: login.driverId,
      },
      fn,
    );
  }

  /** An address with a merchant's pin (or none), created as staff. */
  async function seedAddress(
    tenantId: string,
    staff: string,
    coordinates: { lat: number; lng: number } | null = TUNIS,
  ): Promise<string> {
    const resolved = await asStaff(tenantId, staff, () =>
      addresses.resolve({
        rawInput: "Rue de Marseille, Tunis",
        city: "Tunis",
        countryCode: "TN",
        ...(coordinates === null ? {} : { coordinates }),
      }),
    );
    return resolved.addressId;
  }

  function pin(
    to: { lat: number; lng: number },
    extra: Partial<{ occurredAt: Date; accessNotes: string; accuracyM: number }> = {},
  ) {
    return { idempotencyKey: randomUUID(), coordinates: to, occurredAt: new Date(), ...extra };
  }

  async function outbox(tenantId: string) {
    return withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ event_type: string; payload: Record<string, unknown> }[]>`
        select event_type, payload from outbox
         where tenant_id = ${tenantId} and event_type = 'address.geocode_corrected'
         order by seq`,
    );
  }

  async function trail(tenantId: string, action: string) {
    return withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ actor_id: string | null; context: Record<string, unknown> }[]>`
        select actor_id, context from audit_log where tenant_id = ${tenantId} and action = ${action}`,
    );
  }

  async function addressRow(tenantId: string, staff: string, id: string) {
    return asStaff(tenantId, staff, () => addresses.getById(id));
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const db = new DatabaseService(database.app);
    addresses = new AddressService(db, new ManualGeocodingProvider());
    corrections = new AddressCorrectionService(db, new OutboxService(), new AuditService(db));
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, created);
    created = [];
  });

  afterAll(async () => {
    await database.close();
  });

  describe("submit", () => {
    it("applies a small move, re-scores the address and announces it", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const author = await seedStaff(t);
      const id = await seedAddress(t, staff);

      const { correction, replayed } = await asStaff(t, author, () =>
        corrections.submit(id, pin(NEAR, { accessNotes: "Portail vert", accuracyM: 8 })),
      );

      expect(replayed).toBe(false);
      expect(correction).toMatchObject({
        status: "APPLIED",
        addressId: id,
        correctedByUserId: author,
        driverId: null,
        accuracyM: 8,
        confidenceBefore: 1,
        accessNotes: "Portail vert",
        reviewedByUserId: null,
        address: { rawInput: "Rue de Marseille, Tunis", city: "Tunis" },
      });
      expect(correction.from?.lat).toBeCloseTo(TUNIS.lat, 6);
      expect(correction.to.lat).toBeCloseTo(NEAR.lat, 6);
      expect(correction.distanceMovedM).toBeGreaterThan(100);
      expect(correction.distanceMovedM).toBeLessThan(200);

      const after = await addressRow(t, staff, id);
      expect(after).toMatchObject({
        geocodeSource: "driver_corrected",
        geocodeConfidence: 1,
        accessNotes: "Portail vert",
      });
      expect(after.latitude).toBeCloseTo(NEAR.lat, 6);

      // The documented payload (docs/03 address.geocode_corrected), self-contained.
      const events = await outbox(t);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        addressId: id,
        correctionId: correction.id,
        distanceMovedM: correction.distanceMovedM,
        confidenceAfter: 1,
        decision: "APPLIED",
      });
      expect(events[0]?.payload["oldLocation"]).toMatchObject({ lat: TUNIS.lat, lng: TUNIS.lng });

      const audited = await trail(t, "address.geocode_corrected");
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({
        actor_id: author,
        context: { correctionId: correction.id, decision: "APPLIED", accessNotesChanged: true },
      });
      // Seven-year trail: that the notes changed, never what they say.
      expect(JSON.stringify(audited[0])).not.toContain("Portail vert");
    });

    it("places the first pin on an address that had none", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff, null);

      const { correction } = await asStaff(t, staff, () => corrections.submit(id, pin(FAR)));

      // No pin to move, so no distance and nothing to review.
      expect(correction).toMatchObject({ status: "APPLIED", from: null, distanceMovedM: null });
      expect((await addressRow(t, staff, id)).latitude).toBeCloseTo(FAR.lat, 6);
      expect(await outbox(t)).toHaveLength(1);
    });

    it("holds a move over 2 km for review and leaves the address untouched", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff);
      const before = await addressRow(t, staff, id);

      const { correction } = await asStaff(t, staff, () => corrections.submit(id, pin(FAR)));

      expect(correction.status).toBe("PENDING_REVIEW");
      expect(correction.distanceMovedM).toBeGreaterThan(2000);
      expect(await addressRow(t, staff, id)).toEqual(before);
      expect(await outbox(t)).toEqual([]);
      expect(await trail(t, "address.geocode_corrected")).toEqual([]);
      expect(await asStaff(t, staff, () => corrections.pendingCount())).toBe(1);
      const queue = await asStaff(t, staff, () => corrections.list({ status: "PENDING_REVIEW" }));
      expect(queue.items.map((c) => c.id)).toEqual([correction.id]);
    });

    it("never lets a late offline sync put back an older pin", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff);
      const earlier = new Date(Date.now() - 60 * 60 * 1000);
      const later = new Date(Date.now() - 10 * 60 * 1000);

      // The newer observation arrives first; the older one syncs afterwards.
      await asStaff(t, staff, () => corrections.submit(id, pin(NEAR, { occurredAt: later })));
      const late = await asStaff(t, staff, () =>
        corrections.submit(id, pin({ lat: 36.8005, lng: 10.1805 }, { occurredAt: earlier })),
      );

      expect(late.correction.status).toBe("SUPERSEDED");
      expect((await addressRow(t, staff, id)).latitude).toBeCloseTo(NEAR.lat, 6);
      expect(await outbox(t)).toHaveLength(1);
    });

    it("refuses a device clock far ahead, and clamps one slightly ahead", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff);

      await expect(
        asStaff(t, staff, () =>
          corrections.submit(id, pin(NEAR, { occurredAt: new Date(Date.now() + 3_600_000) })),
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      const { correction } = await asStaff(t, staff, () =>
        corrections.submit(id, pin(NEAR, { occurredAt: new Date(Date.now() + 120_000) })),
      );
      expect(correction.occurredAt.getTime()).toBeLessThanOrEqual(
        correction.recordedAt.getTime() + 1000,
      );
    });

    it("requires a caller, and a well-formed request", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff);

      await expect(
        TenantContext.run({ tenantId: asTenantId(t), actorType: "system" }, () =>
          corrections.submit(id, pin(NEAR)),
        ),
      ).rejects.toBeInstanceOf(UnauthenticatedError);
      for (const body of [
        { coordinates: NEAR, occurredAt: new Date() }, // no key
        { idempotencyKey: randomUUID(), coordinates: NEAR }, // no device time
        { ...pin({ lat: 91, lng: 10 }) },
        { ...pin(NEAR), extra: true }, // strict: unknown fields rejected
      ]) {
        await expect(asStaff(t, staff, () => corrections.submit(id, body))).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      await expect(
        asStaff(t, staff, () => corrections.submit(randomUUID(), pin(NEAR))),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("idempotency", () => {
    it("replays the recorded outcome for the same request, once", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff);
      const request = pin(NEAR);

      const first = await asStaff(t, staff, () => corrections.submit(id, request));
      const again = await asStaff(t, staff, () => corrections.submit(id, request));

      expect(again).toEqual({ correction: first.correction, replayed: true });
      expect(await outbox(t)).toHaveLength(1);
      expect(await trail(t, "address.geocode_corrected")).toHaveLength(1);
    });

    it("answers an identical retry racing the original as a replay", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff);
      const request = pin(NEAR);

      const outcomes = await Promise.all([
        asStaff(t, staff, () => corrections.submit(id, request)),
        asStaff(t, staff, () => corrections.submit(id, request)),
      ]);

      expect(outcomes.map((o) => o.replayed).sort()).toEqual([false, true]);
      expect(outcomes[0]?.correction.id).toBe(outcomes[1]?.correction.id);
      expect(await outbox(t)).toHaveLength(1);
    });

    it("refuses a key reused for a different request or by someone else", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const other = await seedStaff(t);
      const a = await seedAddress(t, staff);
      const b = await seedAddress(t, staff);
      const request = pin(NEAR);
      await asStaff(t, staff, () => corrections.submit(a, request));

      const reused = { code: "IDEMPOTENCY_KEY_REUSED" };
      await expect(
        asStaff(t, staff, () => corrections.submit(a, { ...request, coordinates: TUNIS })),
      ).rejects.toMatchObject(reused);
      await expect(asStaff(t, staff, () => corrections.submit(b, request))).rejects.toMatchObject(
        reused,
      );
      await expect(asStaff(t, other, () => corrections.submit(a, request))).rejects.toBeInstanceOf(
        BusinessRuleError,
      );
      expect((await addressRow(t, staff, b)).geocodeSource).toBe("manual");
    });

    it("refuses a key a colleague used, though the driver cannot see their row", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const driver = await seedDriverLogin(database.migrator, t);
      const id = await seedAddress(t, staff);
      const request = pin(NEAR);
      await asStaff(t, staff, () => corrections.submit(id, request));

      // RLS hides staff's row from the driver, and the address too (it is on
      // none of their work): the address check answers first, 404.
      await expect(
        asDriver(t, driver, () => corrections.submit(id, request)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("review", () => {
    it("applies an approved move from the pin as it is now", async () => {
      const t = await seedTenant();
      const author = await seedStaff(t);
      const reviewer = await seedStaff(t);
      const id = await seedAddress(t, author);
      const held = await asStaff(t, author, () => corrections.submit(id, pin(FAR)));

      const approved = await asStaff(t, reviewer, () =>
        corrections.approve(held.correction.id, { note: "confirmed by phone" }),
      );

      expect(approved).toMatchObject({
        status: "APPROVED",
        reviewedByUserId: reviewer,
        reviewNote: "confirmed by phone",
      });
      expect((await addressRow(t, author, id)).latitude).toBeCloseTo(FAR.lat, 6);
      const events = await outbox(t);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ decision: "APPROVED" });
      expect(await trail(t, "address.geocode_corrected")).toMatchObject([
        { actor_id: reviewer, context: { decision: "APPROVED" } },
      ]);
      expect(await asStaff(t, reviewer, () => corrections.pendingCount())).toBe(0);

      // Re-approving is a no-op; rejecting a decided correction is a conflict.
      expect(await asStaff(t, reviewer, () => corrections.approve(held.correction.id, {}))).toEqual(
        approved,
      );
      await expect(
        asStaff(t, reviewer, () => corrections.reject(held.correction.id, {})),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await outbox(t)).toHaveLength(1);
    });

    it("rejects a held move without touching the address", async () => {
      const t = await seedTenant();
      const author = await seedStaff(t);
      const reviewer = await seedStaff(t);
      const id = await seedAddress(t, author);
      const before = await addressRow(t, author, id);
      const held = await asStaff(t, author, () => corrections.submit(id, pin(FAR)));

      const rejected = await asStaff(t, reviewer, () =>
        corrections.reject(held.correction.id, { note: "wrong parcel" }),
      );

      expect(rejected).toMatchObject({ status: "REJECTED", reviewedByUserId: reviewer });
      expect(await addressRow(t, author, id)).toEqual(before);
      expect(await outbox(t)).toEqual([]);
      expect(await trail(t, "address.geocode_correction_rejected")).toMatchObject([
        { actor_id: reviewer, context: { correctionId: held.correction.id } },
      ]);
      expect(await asStaff(t, reviewer, () => corrections.reject(held.correction.id, {}))).toEqual(
        rejected,
      );
      await expect(
        asStaff(t, reviewer, () => corrections.approve(held.correction.id, {})),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("is never decided by the person who made the correction", async () => {
      const t = await seedTenant();
      const author = await seedStaff(t);
      const id = await seedAddress(t, author);
      const held = await asStaff(t, author, () => corrections.submit(id, pin(FAR)));

      await expect(
        asStaff(t, author, () => corrections.approve(held.correction.id, {})),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        asStaff(t, author, () => corrections.reject(held.correction.id, {})),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("supersedes a held move when a newer pin was set while it waited", async () => {
      const t = await seedTenant();
      const author = await seedStaff(t);
      const reviewer = await seedStaff(t);
      const id = await seedAddress(t, author);
      const held = await asStaff(t, author, () =>
        corrections.submit(id, pin(FAR, { occurredAt: new Date(Date.now() - 60_000) })),
      );
      await asStaff(t, author, () => corrections.submit(id, pin(NEAR)));

      const decided = await asStaff(t, reviewer, () => corrections.approve(held.correction.id, {}));

      expect(decided).toMatchObject({ status: "SUPERSEDED", reviewedByUserId: reviewer });
      expect((await addressRow(t, author, id)).latitude).toBeCloseTo(NEAR.lat, 6);
    });

    it("pages the queue oldest first", async () => {
      const t = await seedTenant();
      const staff = await seedStaff(t);
      const id = await seedAddress(t, staff, null);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push((await asStaff(t, staff, () => corrections.submit(id, pin(NEAR)))).correction.id);
      }

      const first = await asStaff(t, staff, () => corrections.list({ limit: 2 }));
      expect(first.items.map((c) => c.id)).toEqual(ids.slice(0, 2));
      expect(first.nextCursor).toBe(ids[1]);
      const rest = await asStaff(t, staff, () =>
        corrections.list({ limit: 2, cursor: first.nextCursor ?? undefined }),
      );
      expect(rest.items.map((c) => c.id)).toEqual(ids.slice(2));
      expect(rest.nextCursor).toBeNull();
    });
  });

  describe("isolation (I28)", () => {
    it("shows a driver only their own corrections, and another tenant nothing", async () => {
      const t = await seedTenant();
      const away = await seedTenant();
      const staff = await seedStaff(t);
      const awayStaff = await seedStaff(away);
      const driver = await seedDriverLogin(database.migrator, t);
      const id = await seedAddress(t, staff);
      const held = await asStaff(t, staff, () => corrections.submit(id, pin(FAR)));

      await expect(
        asDriver(t, driver, () => corrections.getById(held.correction.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await asDriver(t, driver, () => corrections.list({}))).items).toEqual([]);
      await expect(
        asStaff(away, awayStaff, () => corrections.getById(held.correction.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        asStaff(away, awayStaff, () => corrections.approve(held.correction.id, {})),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("database guards (0051)", () => {
    it("keeps the observation immutable and a decision final, whatever the app does", async () => {
      const t = await seedTenant();
      const author = await seedStaff(t);
      const reviewer = await seedStaff(t);
      const id = await seedAddress(t, author);
      const held = await asStaff(t, author, () => corrections.submit(id, pin(FAR)));
      const cid = held.correction.id;

      const asApp = (fn: Parameters<typeof withTenantContext>[2]) =>
        withTenantContext(database.app, t, fn);

      // Column grants: the pin, the time and the author are not writable.
      await expect(
        asApp((tx) => tx`update address_corrections set occurred_at = now() where id = ${cid}`),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        asApp((tx) => tx`delete from address_corrections where id = ${cid}`),
      ).rejects.toThrow(/permission denied/iu);
      // A review without a reviewer violates the CHECK.
      await expect(
        asApp((tx) => tx`update address_corrections set status = 'APPROVED' where id = ${cid}`),
      ).rejects.toThrow(/check/iu);

      await asStaff(t, reviewer, () => corrections.reject(cid, {}));
      // Trigger: a decided correction does not move again, nor change its review.
      await expect(
        asApp(
          (tx) => tx`update address_corrections
                      set status = 'APPROVED', reviewed_at = now() where id = ${cid}`,
        ),
      ).rejects.toThrow(/cannot move/iu);
      await expect(
        asApp((tx) => tx`update address_corrections set review_note = 'x' where id = ${cid}`),
      ).rejects.toThrow(/final/iu);
    });
  });
});
