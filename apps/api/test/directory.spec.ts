import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import type {
  GeocodeResult,
  GeocodingProvider,
} from "../src/modules/directory/domain/geocoding.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Directory module: merchants, recipients, and the address-quality pipeline.
 *
 * Runs the real services against a real PostgreSQL through the dp_app role, so
 * Row-Level Security, the (tenant, phone) unique constraint, and PostGIS
 * geography round-tripping are all exercised exactly as they run in production.
 */
describe("directory", () => {
  let database: TestDatabase;
  let dbService: DatabaseService;
  let merchants: MerchantService;
  let recipients: RecipientService;
  let addresses: AddressService;
  let createdTenants: string[] = [];

  /** Runs `fn` with a tenant bound, the way the request interceptor would. */
  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function outboxEventTypes(tenantId: string): Promise<string[]> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<
          { event_type: string }[]
        >`select event_type from outbox where tenant_id = ${tenantId} order by seq`,
    );
    return rows.map((r) => r.event_type);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    dbService = new DatabaseService(database.app);
    const outbox = new OutboxService();
    merchants = new MerchantService(dbService, outbox, new AuditService(dbService));
    recipients = new RecipientService(dbService);
    addresses = new AddressService(dbService, outbox, new ManualGeocodingProvider());
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Merchants ────────────────────────────────────────────────────────────

  describe("merchants", () => {
    it("creates a merchant and emits merchant.created", async () => {
      const tenantId = await seedTenant("dir-merch");
      const merchant = await asTenant(tenantId, () =>
        merchants.create({ name: "Boutique Farah", code: "FARAH", contactPhone: "+21620123456" }),
      );

      expect(merchant.name).toBe("Boutique Farah");
      expect(merchant.status).toBe("ACTIVE");
      expect(await outboxEventTypes(tenantId)).toEqual(["merchant.created"]);
    });

    it("rejects a duplicate code within a tenant", async () => {
      const tenantId = await seedTenant("dir-merch-dup");
      await asTenant(tenantId, () => merchants.create({ name: "A", code: "DUP" }));
      await expect(
        asTenant(tenantId, () => merchants.create({ name: "B", code: "DUP" })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows the same code in a different tenant", async () => {
      const tenantA = await seedTenant("dir-merch-a");
      const tenantB = await seedTenant("dir-merch-b");
      await asTenant(tenantA, () => merchants.create({ name: "A", code: "SHARED" }));
      await expect(
        asTenant(tenantB, () => merchants.create({ name: "B", code: "SHARED" })),
      ).resolves.toBeDefined();
    });

    it("suspends and reactivates a merchant", async () => {
      const tenantId = await seedTenant("dir-merch-status");
      const created = await asTenant(tenantId, () => merchants.create({ name: "Suspendable" }));
      const suspended = await asTenant(tenantId, () =>
        merchants.suspend(created.id, "unpaid invoices"),
      );
      expect(suspended.status).toBe("SUSPENDED");
      expect(suspended.blockReason).toBe("unpaid invoices");
      const active = await asTenant(tenantId, () => merchants.activate(created.id));
      expect(active.status).toBe("ACTIVE");
      expect(active.blockReason).toBeNull();
    });

    it("paginates the list by cursor", async () => {
      const tenantId = await seedTenant("dir-merch-page");
      for (let i = 0; i < 3; i += 1) {
        await asTenant(tenantId, () => merchants.create({ name: `M${i}` }));
      }
      const first = await asTenant(tenantId, () => merchants.list({ limit: 2 }));
      expect(first.items).toHaveLength(2);
      const cursor = first.nextCursor;
      expect(cursor).not.toBeNull();
      const second = await asTenant(tenantId, () =>
        merchants.list(cursor === null ? { limit: 2 } : { limit: 2, cursor }),
      );
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    });

    it("hides another tenant's merchant (RLS) as NotFound", async () => {
      const tenantA = await seedTenant("dir-merch-iso-a");
      const tenantB = await seedTenant("dir-merch-iso-b");
      const merchant = await asTenant(tenantA, () => merchants.create({ name: "Private" }));
      await expect(asTenant(tenantB, () => merchants.getById(merchant.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // ── Recipients ───────────────────────────────────────────────────────────

  describe("recipients", () => {
    it("creates a recipient and finds it by phone", async () => {
      const tenantId = await seedTenant("dir-rec");
      const created = await asTenant(tenantId, () =>
        recipients.create({
          fullName: "Sonia Gharbi",
          phone: "+21620987654",
          preferredLanguage: "ar",
        }),
      );
      expect(created.totalShipments).toBe(0);
      const found = await asTenant(tenantId, () => recipients.findByPhone("+21620987654"));
      expect(found?.id).toBe(created.id);
    });

    it("enforces unique (tenant, phone) — invariant I19", async () => {
      const tenantId = await seedTenant("dir-rec-dup");
      await asTenant(tenantId, () => recipients.create({ fullName: "One", phone: "+21620111222" }));
      await expect(
        asTenant(tenantId, () => recipients.create({ fullName: "Two", phone: "+21620111222" })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects a non-E.164 phone with a validation error", async () => {
      const tenantId = await seedTenant("dir-rec-bad");
      await expect(
        asTenant(tenantId, () => recipients.create({ fullName: "Bad", phone: "20123456" })),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("blocks and unblocks a recipient", async () => {
      const tenantId = await seedTenant("dir-rec-block");
      const created = await asTenant(tenantId, () =>
        recipients.create({ fullName: "Refuser", phone: "+21620333444" }),
      );
      const blocked = await asTenant(tenantId, () =>
        recipients.block(created.id, { reason: "repeat refusal" }),
      );
      expect(blocked.isBlocked).toBe(true);
      expect(blocked.blockReason).toBe("repeat refusal");
      const unblocked = await asTenant(tenantId, () => recipients.unblock(created.id));
      expect(unblocked.isBlocked).toBe(false);
    });

    it("keeps the same phone separate across tenants", async () => {
      const tenantA = await seedTenant("dir-rec-iso-a");
      const tenantB = await seedTenant("dir-rec-iso-b");
      await asTenant(tenantA, () => recipients.create({ fullName: "A", phone: "+21620555666" }));
      await expect(
        asTenant(tenantB, () => recipients.create({ fullName: "B", phone: "+21620555666" })),
      ).resolves.toBeDefined();
    });
  });

  // ── Addresses ──────────────────────────────────────────────────────────────

  describe("addresses", () => {
    it("resolves a pinned address at full confidence and round-trips the location", async () => {
      const tenantId = await seedTenant("dir-addr-pin");
      const resolved = await asTenant(tenantId, () =>
        addresses.resolve({
          rawInput: "Rue de la Liberté, Ariana",
          city: "Ariana",
          countryCode: "tn",
          coordinates: { lat: 36.8625, lng: 10.1956 },
        }),
      );
      expect(resolved.confidence).toBe(1);
      expect(resolved.requiresReview).toBe(false);

      const view = await asTenant(tenantId, () => addresses.getById(resolved.addressId));
      expect(view.geocodeSource).toBe("manual");
      expect(view.countryCode).toBe("TN");
      expect(view.latitude ?? 0).toBeCloseTo(36.8625, 4);
      expect(view.longitude ?? 0).toBeCloseTo(10.1956, 4);
    });

    it("stores an ungeocodable address with zero confidence and flags it for review", async () => {
      const tenantId = await seedTenant("dir-addr-lowconf");
      const resolved = await asTenant(tenantId, () =>
        addresses.resolve({ rawInput: "somewhere vague", countryCode: "TN" }),
      );
      expect(resolved.confidence).toBe(0);
      expect(resolved.requiresReview).toBe(true);

      const view = await asTenant(tenantId, () => addresses.getById(resolved.addressId));
      expect(view.geocodeSource).toBe("none");
      expect(view.latitude).toBeNull();
    });

    it("applies a driver correction and emits address.geocode_corrected", async () => {
      const tenantId = await seedTenant("dir-addr-correct");
      const resolved = await asTenant(tenantId, () =>
        addresses.resolve({ rawInput: "Immeuble Yasmine", countryCode: "TN" }),
      );
      const corrected = await asTenant(tenantId, () =>
        addresses.applyDriverCorrection(resolved.addressId, {
          coordinates: { lat: 36.8, lng: 10.18 },
          accessNotes: "actual entrance is on the side street",
        }),
      );
      expect(corrected.geocodeSource).toBe("driver_corrected");
      expect(corrected.geocodeConfidence).toBe(1);
      expect(corrected.latitude ?? 0).toBeCloseTo(36.8, 4);
      expect(corrected.accessNotes).toBe("actual entrance is on the side street");
      expect(await outboxEventTypes(tenantId)).toContain("address.geocode_corrected");
    });

    it("uses the geocoding provider when one returns a match", async () => {
      const tenantId = await seedTenant("dir-addr-geo");
      const stub: GeocodingProvider = {
        geocode: (): Promise<GeocodeResult> =>
          Promise.resolve({
            location: { lat: 36.81, lng: 10.17 },
            confidence: 0.92,
            source: "mapbox",
          }),
      };
      const withGeocoder = new AddressService(dbService, new OutboxService(), stub);
      const resolved = await asTenant(tenantId, () =>
        withGeocoder.resolve({ rawInput: "Avenue Habib Bourguiba, Tunis", countryCode: "TN" }),
      );
      expect(resolved.confidence).toBeCloseTo(0.92, 3);
      expect(resolved.requiresReview).toBe(false);
      const view = await asTenant(tenantId, () => addresses.getById(resolved.addressId));
      expect(view.geocodeSource).toBe("mapbox");
    });

    it("rejects a bad country code with a validation error", async () => {
      const tenantId = await seedTenant("dir-addr-bad");
      await expect(
        asTenant(tenantId, () => addresses.resolve({ rawInput: "x", countryCode: "TUN" })),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
