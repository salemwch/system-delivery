import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AddressService, MerchantService } from "../src/modules/directory/index.js";
import { MerchantApplicationService } from "../src/modules/directory/application/merchant-application.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { AuditService, OutboxService } from "../src/modules/platform/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, NotFoundError, ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Nouveaux clients — the queue of shippers asking to be taken on.
 *
 * ⚠️ `submit` IS AN UNAUTHENTICATED WRITE PATH, and most of what is tested here
 * is about that: that a duplicate is indistinguishable from a first submission,
 * that a flood is capped, and that nothing about the response varies with what
 * the courier already knows. A functional test that only checked "an application
 * is stored" would pass against an endpoint that answers "that number already
 * applied" — which is a way to test a phone book you do not own.
 */
describe("merchant applications", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let applications: MerchantApplicationService;
  let merchants: MerchantService;
  let createdTenants: string[] = [];

  const ACTOR_ID = randomUUID();

  function asStaff<T>(tenantId: string, fn: () => Promise<T>, actorId = ACTOR_ID): Promise<T> {
    return TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "user", actorId },
      fn,
    );
  }

  /** What the public endpoint does: a tenant, no user. */
  function asAnonymous<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "api_client" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedUser(tenantId: string): Promise<string> {
    const email = `staff-${Math.random().toString(36).slice(2, 8)}@test.tn`;
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${email}, 'hash', 'Décideur', 'ACTIVE')
        returning id`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed user");
    return row.id;
  }

  function application(overrides: Record<string, unknown> = {}) {
    return {
      businessName: "Boutique Yasmine",
      contactName: "Yasmine Ben Ali",
      contactPhone: `+2162${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      ...overrides,
    };
  }

  /** The one PENDING application of a tenant, for tests that made exactly one. */
  async function onlyPending(tenantId: string) {
    const page = await asStaff(tenantId, () => applications.list({ status: "PENDING" }));
    const first = page.items[0];
    if (first === undefined) throw new Error("expected a pending application");
    return first;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const audit = new AuditService(db);
    merchants = new MerchantService(
      db,
      outbox,
      audit,
      new AddressService(db, outbox, new ManualGeocodingProvider()),
    );
    applications = new MerchantApplicationService(db, audit, merchants);
  }, 240_000);

  afterAll(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    await database.close();
  });

  // ── Intake ─────────────────────────────────────────────────────────────────
  describe("submit", () => {
    let tenantId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("app-submit");
    });

    it("records what the applicant told us, as PENDING", async () => {
      await asAnonymous(tenantId, () =>
        applications.submit(
          application({
            contactPhone: "+21624201314",
            contactEmail: "y@boutique.tn",
            city: "Ariana",
            expectedVolume: 250,
            message: "Je livre du prêt-à-porter",
          }),
        ),
      );

      const row = await onlyPending(tenantId);
      expect(row.status).toBe("PENDING");
      expect(row.source).toBe("PUBLIC_FORM");
      expect(row.contactPhone).toBe("+21624201314");
      expect(row.expectedVolume).toBe(250);
      // A pending row carries no decision — the CHECK constraint enforces it.
      expect(row.merchantId).toBeNull();
      expect(row.decidedAt).toBeNull();
    });

    it("marks a staff-logged lead as such", async () => {
      await asStaff(tenantId, () => applications.submit(application(), "STAFF"));
      expect((await onlyPending(tenantId)).source).toBe("STAFF");
    });

    it("⚠️ treats a DUPLICATE as success — it must not be an oracle", async () => {
      const phone = "+21624201314";
      await asAnonymous(tenantId, () => applications.submit(application({ contactPhone: phone })));

      // The second submission must be indistinguishable from the first. If this
      // ever throws, an anonymous caller can test whether a phone number is
      // known to this courier by watching which requests fail.
      await expect(
        asAnonymous(tenantId, () =>
          applications.submit(application({ contactPhone: phone, businessName: "Autre nom" })),
        ),
      ).resolves.toBeUndefined();

      // And it did not create a second row.
      const page = await asStaff(tenantId, () => applications.list({ status: "PENDING" }));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.businessName).toBe("Boutique Yasmine");
    });

    it("lets a REJECTED applicant apply again", async () => {
      const phone = "+21624201314";
      const userId = await seedUser(tenantId);
      await asAnonymous(tenantId, () => applications.submit(application({ contactPhone: phone })));
      const first = await onlyPending(tenantId);
      await asStaff(tenantId, () =>
        applications.reject(first.id, { reason: "Zone non desservie" }, userId),
      );

      // The unique index is PARTIAL on status = 'PENDING' precisely so this
      // works: turned away in January, welcome in June.
      await asAnonymous(tenantId, () => applications.submit(application({ contactPhone: phone })));
      expect((await onlyPending(tenantId)).contactPhone).toBe(phone);
    });

    it("caps a flood from the public form", async () => {
      // 30 distinct numbers is the ceiling; the 31st is refused. Distinct, so
      // the per-phone index is not what is being measured.
      for (let i = 0; i < 30; i += 1) {
        await asAnonymous(tenantId, () =>
          applications.submit(application({ contactPhone: `+2162400${String(1000 + i)}` })),
        );
      }

      await expect(
        asAnonymous(tenantId, () =>
          applications.submit(application({ contactPhone: "+21624009999" })),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("does NOT cap a signed-in salesperson logging leads", async () => {
      for (let i = 0; i < 30; i += 1) {
        await asAnonymous(tenantId, () =>
          applications.submit(application({ contactPhone: `+2162400${String(1000 + i)}` })),
        );
      }

      // The cap exists to stop an anonymous script. A commercial back from a
      // market with thirty cards is the feature working.
      await expect(
        asStaff(tenantId, () =>
          applications.submit(application({ contactPhone: "+21624009999" }), "STAFF"),
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects a phone that is not E.164", async () => {
      // Tunisians type 24201314; normalisation belongs in the UI, and the API
      // stays strict so a bad number can never reach a manifest.
      await expect(
        asAnonymous(tenantId, () => applications.submit(application({ contactPhone: "24201314" }))),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects unknown fields rather than silently dropping them", async () => {
      await expect(
        asAnonymous(tenantId, () => applications.submit(application({ isAdmin: true }))),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── Approval ───────────────────────────────────────────────────────────────
  describe("approve", () => {
    let tenantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("app-approve");
      userId = await seedUser(tenantId);
      await asAnonymous(tenantId, () =>
        applications.submit(
          application({ contactPhone: "+21624201314", contactEmail: "y@boutique.tn" }),
        ),
      );
    });

    it("creates the merchant and links it", async () => {
      const pending = await onlyPending(tenantId);

      const decided = await asStaff(
        tenantId,
        () => applications.approve(pending.id, { code: "BY-01" }, userId),
        userId,
      );

      expect(decided.status).toBe("APPROVED");
      expect(decided.merchantId).not.toBeNull();
      expect(decided.decidedByUserId).toBe(userId);
      expect(decided.decidedAt).not.toBeNull();

      const merchant = await asStaff(tenantId, () =>
        merchants.getById(decided.merchantId ?? ""),
      );
      // Copied, not retyped — a second chance to get the phone wrong is a second
      // chance for a parcel to go undelivered.
      expect(merchant.name).toBe("Boutique Yasmine");
      expect(merchant.code).toBe("BY-01");
      expect(merchant.contactPhone).toBe("+21624201314");
      expect(merchant.contactEmail).toBe("y@boutique.tn");
    });

    it("uses the legal name when it differs from the one applied under", async () => {
      const pending = await onlyPending(tenantId);
      const decided = await asStaff(
        tenantId,
        () => applications.approve(pending.id, { name: "SARL Yasmine Distribution" }, userId),
        userId,
      );
      const merchant = await asStaff(tenantId, () => merchants.getById(decided.merchantId ?? ""));
      expect(merchant.name).toBe("SARL Yasmine Distribution");
    });

    it("makes the approving COMMERCIAL the account manager (I25)", async () => {
      const commercialId = await seedUser(tenantId);
      const pending = await onlyPending(tenantId);

      const decided = await TenantContext.run(
        {
          tenantId: asTenantId(tenantId),
          actorType: "user",
          actorId: commercialId,
          accountManagerId: commercialId,
        },
        () => applications.approve(pending.id, {}, commercialId),
      );

      // Taking a lead IS taking the account. The merchant is created under the
      // approver's ambient context, so nothing extra has to be remembered.
      const merchant = await asStaff(tenantId, () => merchants.getById(decided.merchantId ?? ""));
      expect(merchant.accountManagerId).toBe(commercialId);
    });

    it("refuses to approve twice", async () => {
      const pending = await onlyPending(tenantId);
      await asStaff(tenantId, () => applications.approve(pending.id, {}, userId), userId);

      await expect(
        asStaff(tenantId, () => applications.approve(pending.id, {}, userId), userId),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("records the decision on the audit trail", async () => {
      const pending = await onlyPending(tenantId);
      await asStaff(tenantId, () => applications.approve(pending.id, {}, userId), userId);

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string; context: Record<string, unknown> }[]>`
          select action, context from audit_log where resource_id = ${pending.id}`,
      );
      expect(rows[0]?.action).toBe("merchant.application_approved");
      expect(rows[0]?.context).toMatchObject({ businessName: "Boutique Yasmine" });
    });

    it("404s on an unknown id", async () => {
      await expect(
        asStaff(tenantId, () => applications.approve(randomUUID(), {}, userId), userId),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Rejection ──────────────────────────────────────────────────────────────
  describe("reject", () => {
    let tenantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("app-reject");
      userId = await seedUser(tenantId);
      await asAnonymous(tenantId, () => applications.submit(application()));
    });

    it("stores the reason, and creates no merchant", async () => {
      const pending = await onlyPending(tenantId);

      const decided = await asStaff(
        tenantId,
        () => applications.reject(pending.id, { reason: "Zone non desservie" }, userId),
        userId,
      );

      expect(decided.status).toBe("REJECTED");
      expect(decided.decisionReason).toBe("Zone non desservie");
      expect(decided.merchantId).toBeNull();
    });

    it("requires a reason", async () => {
      const pending = await onlyPending(tenantId);
      await expect(
        asStaff(tenantId, () => applications.reject(pending.id, { reason: "  " }, userId), userId),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses to decide an already-decided application", async () => {
      const pending = await onlyPending(tenantId);
      await asStaff(tenantId, () => applications.reject(pending.id, { reason: "non" }, userId), userId);

      await expect(
        asStaff(tenantId, () => applications.approve(pending.id, {}, userId), userId),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  // ── The database refuses impossible rows ───────────────────────────────────
  describe("decision constraint", () => {
    it("refuses an APPROVED row with no merchant, from direct SQL", async () => {
      const tenantId = await seedTenant("app-chk");
      await asAnonymous(tenantId, () => applications.submit(application()));
      const pending = await onlyPending(tenantId);

      // The service cannot produce this. The constraint is what guarantees the
      // UI never has to render "approved, but into what?".
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update merchant_applications set status = 'APPROVED' where id = ${pending.id}`,
        ),
      ).rejects.toThrow(/merchant_applications_decision_chk/u);
    });

    it("refuses a REJECTED row with no reason", async () => {
      const tenantId = await seedTenant("app-chk2");
      const userId = await seedUser(tenantId);
      await asAnonymous(tenantId, () => applications.submit(application()));
      const pending = await onlyPending(tenantId);

      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`
            update merchant_applications
               set status = 'REJECTED', decided_at = now(), decided_by_user_id = ${userId}
             where id = ${pending.id}`,
        ),
      ).rejects.toThrow(/merchant_applications_decision_chk/u);
    });
  });

  // ── Reading ────────────────────────────────────────────────────────────────
  describe("list", () => {
    let tenantId: string;
    let userId: string;

    beforeEach(async () => {
      tenantId = await seedTenant("app-list");
      userId = await seedUser(tenantId);
      for (let i = 0; i < 3; i += 1) {
        await asAnonymous(tenantId, () =>
          applications.submit(
            application({ businessName: `Client ${String(i)}`, contactPhone: `+2162420131${String(i)}` }),
          ),
        );
      }
    });

    it("defaults to PENDING, oldest first — the one waiting longest", async () => {
      const page = await asStaff(tenantId, () => applications.list());
      expect(page.items.map((a) => a.businessName)).toEqual(["Client 0", "Client 1", "Client 2"]);
    });

    it("reads history newest first", async () => {
      const pending = await asStaff(tenantId, () => applications.list());
      for (const item of pending.items) {
        await asStaff(tenantId, () => applications.reject(item.id, { reason: "non" }, userId), userId);
      }

      const history = await asStaff(tenantId, () => applications.list({ status: "REJECTED" }));
      expect(history.items.map((a) => a.businessName)).toEqual([
        "Client 2",
        "Client 1",
        "Client 0",
      ]);
    });

    it("counts what is waiting, and stops counting once decided", async () => {
      expect(await asStaff(tenantId, () => applications.pendingCount())).toBe(3);

      const first = await onlyPending(tenantId);
      await asStaff(tenantId, () => applications.reject(first.id, { reason: "non" }, userId), userId);

      expect(await asStaff(tenantId, () => applications.pendingCount())).toBe(2);
    });

    it("pages forward without repeating a row", async () => {
      const first = await asStaff(tenantId, () => applications.list({ limit: 2 }));
      expect(first.items).toHaveLength(2);

      const second = await asStaff(tenantId, () =>
        applications.list({ limit: 2, cursor: first.nextCursor ?? undefined }),
      );
      const ids = new Set([...first.items, ...second.items].map((a) => a.id));
      expect(ids.size).toBe(3);
    });
  });

  // ── Isolation ──────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("keeps one courier's leads away from another", async () => {
      const alpha = await seedTenant("app-iso-a");
      const beta = await seedTenant("app-iso-b");

      await asAnonymous(alpha, () => applications.submit(application({ businessName: "Chez A" })));

      expect((await asStaff(beta, () => applications.list())).items).toHaveLength(0);
      expect(await asStaff(beta, () => applications.pendingCount())).toBe(0);

      const mine = await onlyPending(alpha);
      await expect(asStaff(beta, () => applications.getById(mine.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("lets the same phone apply to two couriers independently", async () => {
      const alpha = await seedTenant("app-iso-c");
      const beta = await seedTenant("app-iso-d");
      const phone = "+21624201314";

      // The unique index is per tenant. A shipper shopping around for a courier
      // is normal commercial behaviour, not a duplicate.
      await asAnonymous(alpha, () => applications.submit(application({ contactPhone: phone })));
      await asAnonymous(beta, () => applications.submit(application({ contactPhone: phone })));

      expect((await asStaff(alpha, () => applications.list())).items).toHaveLength(1);
      expect((await asStaff(beta, () => applications.list())).items).toHaveLength(1);
    });
  });
});
