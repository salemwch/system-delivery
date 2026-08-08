import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { HubScanService } from "../src/modules/custody/application/hub-scan.service.js";
import { ManifestService } from "../src/modules/custody/application/manifest.service.js";
import {
  MANIFEST_STATUSES,
  MANIFEST_TYPES,
  TERMINAL_MANIFEST_STATUSES,
  canManifestTransition,
  originatesAtHub,
  toManifestStatus,
  toManifestType,
  travelsInTransit,
} from "../src/modules/custody/domain/manifest-status.js";
import type { ManifestStatus } from "../src/modules/custody/domain/manifest-status.js";
import {
  formatManifestCode,
  normaliseHubCode,
} from "../src/modules/custody/domain/manifest-code.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { HubService } from "../src/modules/network/application/hub.service.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { ConflictError, NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

interface SeededShipment {
  readonly id: string;
  readonly trackingNumber: string;
}

describe("custody", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let manifestsSvc: ManifestService;
  let hubScans: HubScanService;
  let hubsSvc: HubService;
  let shipmentsSvc: ShipmentService;
  let createdTenants: string[] = [];

  const actorId = randomUUID();
  const ctx = { actorId };

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  /** Features default to OFF when no row exists, so every hub test seeds them. */
  async function enableFeature(tenantId: string, key: string, enabled = true): Promise<void> {
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx`
        insert into tenant_features (tenant_id, feature_key, enabled, source)
        values (${tenantId}, ${key}, ${enabled}, 'PLAN')
        on conflict (tenant_id, feature_key) do update set enabled = ${enabled}
      `,
    );
  }

  async function seedTenant(label: string, features = true): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    if (features) {
      await enableFeature(id, "MULTI_HUB_ENABLED");
      await enableFeature(id, "LINEHAUL_ENABLED");
    }
    return id;
  }

  async function seedHub(tenantId: string, code: string): Promise<{ id: string; code: string }> {
    return asTenant(tenantId, async () => {
      const hub = await hubsSvc.create({
        code,
        name: `Hub ${code}`,
        type: "SORTING_CENTER",
        address: {
          rawInput: `Zone Industrielle ${code}, Tunis`,
          countryCode: "TN",
          coordinates: { lat: 36.8, lng: 10.18 },
        },
        timezone: "Africa/Tunis",
      });
      return { id: hub.id, code: hub.code };
    });
  }

  async function seedMerchant(tenantId: string): Promise<string> {
    return asTenant(tenantId, async () => {
      const merchants = new MerchantService(db, new OutboxService(), new AuditService(db), new AddressService(db, new OutboxService(), new ManualGeocodingProvider()));
      const m = await merchants.create({
        name: `Merchant ${Math.random().toString(36).slice(2, 8)}`,
      });
      return m.id;
    });
  }

  /**
   * Seeds a shipment directly at the status under test.
   *
   * Driving one through its whole lifecycle for every case would make these
   * tests about the shipment module rather than about custody. The status column
   * is a projection, so setting it is the same thing the event pipeline would
   * have produced.
   */
  async function seedShipment(
    tenantId: string,
    merchantId: string,
    status = "AT_HUB",
  ): Promise<SeededShipment> {
    const trackingNumber = `SD-CUST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const addressId = await asTenant(tenantId, async () => {
      const addresses = new AddressService(db, new OutboxService(), new ManualGeocodingProvider());
      const resolved = await addresses.resolve({
        rawInput: "12 Avenue Habib Bourguiba, Tunis",
        countryCode: "TN",
        coordinates: { lat: 36.8008, lng: 10.1817 },
      });
      return resolved.addressId;
    });

    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<{ id: string }[]>`
        insert into shipments (
          tenant_id, tracking_number, merchant_id, status,
          sender_name, sender_phone, origin_address_id,
          recipient_name, recipient_phone, destination_address_id, currency
        ) values (
          ${tenantId}, ${trackingNumber}, ${merchantId}, ${status},
          'Sender SA', '+21620000001', ${addressId},
          'Recipient SA', '+21620000002', ${addressId}, 'TND'
        )
        returning id
      `,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("failed to seed test shipment");
    return { id: row.id, trackingNumber };
  }

  async function seedShipments(
    tenantId: string,
    merchantId: string,
    count: number,
    status = "AT_HUB",
  ): Promise<SeededShipment[]> {
    const out: SeededShipment[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(await seedShipment(tenantId, merchantId, status));
    }
    return out;
  }

  async function shipmentStatus(tenantId: string, shipmentId: string): Promise<string> {
    const shipment = await asTenant(tenantId, () => shipmentsSvc.getById(shipmentId));
    return shipment.status;
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

  async function payloadFor(
    tenantId: string,
    eventType: string,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<
          { payload: Record<string, unknown> }[]
        >`select payload from outbox where tenant_id = ${tenantId} and event_type = ${eventType} order by seq`,
    );
    return rows[0]?.payload;
  }

  /** Builds a manifest of `count` parcels, driven to SEALED. */
  async function sealedManifest(
    tenantId: string,
    merchantId: string,
    from: { id: string },
    to: { id: string },
    count = 3,
  ): Promise<{ id: string; shipments: SeededShipment[] }> {
    const shipments = await seedShipments(tenantId, merchantId, count);
    const manifest = await asTenant(tenantId, () =>
      manifestsSvc.open(
        { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
        ctx,
      ),
    );
    for (const s of shipments) {
      await asTenant(tenantId, () =>
        manifestsSvc.addItem(manifest.id, { idempotencyKey: randomUUID(), shipmentId: s.id }),
      );
    }
    await asTenant(tenantId, () =>
      manifestsSvc.seal(manifest.id, { idempotencyKey: randomUUID() }, ctx),
    );
    return { id: manifest.id, shipments };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    const merchants = new MerchantService(db, outbox, new AuditService(db), new AddressService(db, outbox, new ManualGeocodingProvider()));
    const recipients = new RecipientService(db);
    const features = new FeatureService(db, new AuditService(db));
    hubsSvc = new HubService(db, outbox, addresses);
    const events = new ShipmentEventService(outbox);
    const operatingConfig = new OperatingConfigService(db);
    shipmentsSvc = new ShipmentService(
      db,
      events,
      outbox,
      merchants,
      recipients,
      addresses,
      operatingConfig,
    );
    manifestsSvc = new ManifestService(db, outbox, shipmentsSvc, hubsSvc, features);
    hubScans = new HubScanService(shipmentsSvc, hubsSvc, features);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Pure domain ────────────────────────────────────────────────────────────

  describe("domain: manifest state machine", () => {
    it("allows the forward chain", () => {
      expect(canManifestTransition("OPEN", "SEALED")).toBe(true);
      expect(canManifestTransition("SEALED", "IN_TRANSIT")).toBe(true);
      expect(canManifestTransition("IN_TRANSIT", "RECEIVED")).toBe(true);
      expect(canManifestTransition("RECEIVED", "RECONCILED")).toBe(true);
    });

    it("allows SEALED → RECEIVED, skipping transit for a local handover", () => {
      expect(canManifestTransition("SEALED", "RECEIVED")).toBe(true);
    });

    it("rejects every backward transition", () => {
      expect(canManifestTransition("SEALED", "OPEN")).toBe(false);
      expect(canManifestTransition("IN_TRANSIT", "SEALED")).toBe(false);
      expect(canManifestTransition("RECEIVED", "IN_TRANSIT")).toBe(false);
      expect(canManifestTransition("RECONCILED", "RECEIVED")).toBe(false);
    });

    it("rejects skipping steps", () => {
      expect(canManifestTransition("OPEN", "IN_TRANSIT")).toBe(false);
      expect(canManifestTransition("OPEN", "RECEIVED")).toBe(false);
      expect(canManifestTransition("OPEN", "RECONCILED")).toBe(false);
      expect(canManifestTransition("SEALED", "RECONCILED")).toBe(false);
      expect(canManifestTransition("IN_TRANSIT", "RECONCILED")).toBe(false);
    });

    it("rejects every transition out of RECONCILED", () => {
      const targets: ManifestStatus[] = [...MANIFEST_STATUSES];
      for (const target of targets) {
        expect(canManifestTransition("RECONCILED", target)).toBe(false);
      }
    });

    it("treats RECONCILED as the only terminal status", () => {
      expect(TERMINAL_MANIFEST_STATUSES.size).toBe(1);
      expect(TERMINAL_MANIFEST_STATUSES.has("RECONCILED")).toBe(true);
    });

    it("parses every valid status and type, rejecting anything else", () => {
      for (const s of MANIFEST_STATUSES) expect(toManifestStatus(s)).toBe(s);
      for (const t of MANIFEST_TYPES) expect(toManifestType(t)).toBe(t);
      expect(() => toManifestStatus("INVALID")).toThrow(/unknown manifest status/iu);
      expect(() => toManifestType("PIGEON")).toThrow(/unknown manifest type/iu);
      expect(() => toManifestStatus("open")).toThrow();
    });

    it("knows which handovers start at a hub", () => {
      expect(originatesAtHub("LINEHAUL")).toBe(true);
      expect(originatesAtHub("DISPATCH")).toBe(true);
      expect(originatesAtHub("TRANSFER")).toBe(true);
      // Sealed by a driver in the field — its parcels are not at a hub.
      expect(originatesAtHub("RETURN")).toBe(false);
    });

    it("knows which handovers pass through IN_TRANSIT", () => {
      expect(travelsInTransit("LINEHAUL")).toBe(true);
      expect(travelsInTransit("TRANSFER")).toBe(true);
      // The last mile is OUT_FOR_DELIVERY, owned by RouteService.
      expect(travelsInTransit("DISPATCH")).toBe(false);
      expect(travelsInTransit("RETURN")).toBe(false);
    });
  });

  describe("domain: manifest code", () => {
    it("formats a hub-anchored, zero-padded code", () => {
      const date = new Date("2026-07-28T15:00:00Z");
      expect(formatManifestCode("TUN-01", date, 1)).toBe("MF-TUN01-20260728-001");
      expect(formatManifestCode("TUN-01", date, 42)).toBe("MF-TUN01-20260728-042");
      expect(formatManifestCode("TUN-01", date, 999)).toBe("MF-TUN01-20260728-999");
    });

    it("normalises operator-entered hub codes to one scannable token", () => {
      expect(normaliseHubCode("TUN-01")).toBe("TUN01");
      expect(normaliseHubCode("sfax 2")).toBe("SFAX2");
      expect(normaliseHubCode("a-b_c 3")).toBe("ABC3");
    });

    it("rejects a hub code with no alphanumerics", () => {
      expect(() => normaliseHubCode("---")).toThrow(/alphanumeric/iu);
      expect(() => normaliseHubCode("")).toThrow();
    });

    it("keeps codes from different hubs distinct on the same day", () => {
      const date = new Date("2026-07-28T00:00:00Z");
      expect(formatManifestCode("TUN-01", date, 1)).not.toBe(formatManifestCode("SFA-02", date, 1));
    });

    it("handles ordinals beyond 999 without truncating", () => {
      expect(formatManifestCode("TUN01", new Date("2026-07-28T00:00:00Z"), 1234)).toBe(
        "MF-TUN01-20260728-1234",
      );
    });

    it("rejects zero, negative, and fractional ordinals", () => {
      const date = new Date();
      expect(() => formatManifestCode("TUN01", date, 0)).toThrow();
      expect(() => formatManifestCode("TUN01", date, -1)).toThrow();
      expect(() => formatManifestCode("TUN01", date, 1.5)).toThrow();
    });
  });

  // ── Opening ────────────────────────────────────────────────────────────────

  describe("open", () => {
    it("opens a LINEHAUL manifest with a hub-anchored code", async () => {
      const tenantId = await seedTenant("cu-open");
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );

      expect(manifest.status).toBe("OPEN");
      expect(manifest.type).toBe("LINEHAUL");
      expect(manifest.code).toMatch(/^MF-TUN01-\d{8}-\d{3,}$/u);
      expect(manifest.itemCount).toBe(0);
      expect(manifest.discrepancyCount).toBe(0);
      expect(manifest.sealedAt).toBeNull();
      expect(manifest.createdByUserId).toBe(actorId);
    });

    it("increments the ordinal per hub per day", async () => {
      const tenantId = await seedTenant("cu-ordinal");
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");

      const first = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );
      const second = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );
      expect(second.code).not.toBe(first.code);
      expect(Number.parseInt(second.code.split("-")[3] ?? "", 10)).toBeGreaterThan(
        Number.parseInt(first.code.split("-")[3] ?? "", 10),
      );
    });

    it("keeps two hubs' sequences independent", async () => {
      const tenantId = await seedTenant("cu-ordinal-hubs");
      const a = await seedHub(tenantId, "TUN-01");
      const b = await seedHub(tenantId, "SFA-02");

      const fromA = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: a.id, toHubId: b.id },
          ctx,
        ),
      );
      const fromB = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: b.id, toHubId: a.id },
          ctx,
        ),
      );
      // Both are their hub's first manifest of the day — no contention.
      expect(fromA.code).toMatch(/-001$/u);
      expect(fromB.code).toMatch(/-001$/u);
    });

    it.each([
      ["LINEHAUL", "fromHubId and toHubId"],
      ["DISPATCH", "fromHubId and toDriverId"],
      ["RETURN", "fromDriverId and toHubId"],
    ])("rejects a %s manifest missing its endpoints", async (type) => {
      const tenantId = await seedTenant(`cu-endpoints-${type.toLowerCase()}`);
      const hub = await seedHub(tenantId, "TUN-01");

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.open(
            {
              idempotencyKey: randomUUID(),
              type,
              ...(type === "RETURN" ? {} : { fromHubId: hub.id }),
            },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_ENDPOINTS_INVALID" });
    });

    it("opens each of the four types with correct endpoints", async () => {
      const tenantId = await seedTenant("cu-all-types");
      const a = await seedHub(tenantId, "TUN-01");
      const b = await seedHub(tenantId, "SFA-02");
      const driverId = randomUUID();

      const cases = [
        { type: "LINEHAUL", fromHubId: a.id, toHubId: b.id },
        { type: "DISPATCH", fromHubId: a.id, toDriverId: driverId },
        { type: "RETURN", fromDriverId: driverId, toHubId: a.id },
        { type: "TRANSFER", fromHubId: a.id },
      ];

      for (const input of cases) {
        const manifest = await asTenant(tenantId, () =>
          manifestsSvc.open({ idempotencyKey: randomUUID(), ...input }, ctx),
        );
        expect(manifest.type).toBe(input.type);
        expect(manifest.status).toBe("OPEN");
      }
    });

    it("rejects a manifest from a hub to itself", async () => {
      const tenantId = await seedTenant("cu-selfhub");
      const hub = await seedHub(tenantId, "TUN-01");

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.open(
            {
              idempotencyKey: randomUUID(),
              type: "LINEHAUL",
              fromHubId: hub.id,
              toHubId: hub.id,
            },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_ENDPOINTS_INVALID" });
    });

    it("throws NotFoundError for an unknown hub", async () => {
      const tenantId = await seedTenant("cu-nohub");
      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.open(
            {
              idempotencyKey: randomUUID(),
              type: "LINEHAUL",
              fromHubId: randomUUID(),
              toHubId: randomUUID(),
            },
            ctx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects unknown fields and bad types (strict schema)", async () => {
      const tenantId = await seedTenant("cu-strict");
      const hub = await seedHub(tenantId, "TUN-01");

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.open(
            { idempotencyKey: randomUUID(), type: "TRANSFER", fromHubId: hub.id, oops: 1 },
            ctx,
          ),
        ),
      ).rejects.toThrow();

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.open(
            { idempotencyKey: randomUUID(), type: "PIGEON", fromHubId: hub.id },
            ctx,
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ── Feature gating ─────────────────────────────────────────────────────────

  describe("feature gates", () => {
    it("rejects all hub operations when MULTI_HUB_ENABLED is off", async () => {
      const tenantId = await seedTenant("cu-nomultihub", false);
      await enableFeature(tenantId, "MULTI_HUB_ENABLED", false);
      const hub = await seedHub(tenantId, "TUN-01");

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.open(
            { idempotencyKey: randomUUID(), type: "TRANSFER", fromHubId: hub.id },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    });

    it("rejects LINEHAUL only, when LINEHAUL_ENABLED is off", async () => {
      const tenantId = await seedTenant("cu-nolinehaul", false);
      await enableFeature(tenantId, "MULTI_HUB_ENABLED");
      await enableFeature(tenantId, "LINEHAUL_ENABLED", false);
      const a = await seedHub(tenantId, "TUN-01");
      const b = await seedHub(tenantId, "SFA-02");

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.open(
            { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: a.id, toHubId: b.id },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });

      // A non-linehaul handover is unaffected.
      const transfer = await asTenant(tenantId, () =>
        manifestsSvc.open({ idempotencyKey: randomUUID(), type: "TRANSFER", fromHubId: a.id }, ctx),
      );
      expect(transfer.status).toBe("OPEN");
    });

    it("rejects hub inbound scanning when MULTI_HUB_ENABLED is off", async () => {
      const tenantId = await seedTenant("cu-inbound-gate", false);
      await enableFeature(tenantId, "MULTI_HUB_ENABLED", false);
      const hub = await seedHub(tenantId, "TUN-01");

      await expect(
        asTenant(tenantId, () =>
          hubScans.scan(hub.id, { idempotencyKey: randomUUID(), trackingNumber: "SD-X" }, ctx),
        ),
      ).rejects.toMatchObject({ code: "FEATURE_NOT_ENTITLED" });
    });
  });

  // ── Contents and immutability (invariant I14) ──────────────────────────────

  describe("contents", () => {
    it("adds items and counts them", async () => {
      const tenantId = await seedTenant("cu-add");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const shipments = await seedShipments(tenantId, merchantId, 2);

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );
      for (const s of shipments) {
        const item = await asTenant(tenantId, () =>
          manifestsSvc.addItem(manifest.id, { idempotencyKey: randomUUID(), shipmentId: s.id }),
        );
        expect(item.scanStatus).toBe("EXPECTED");
        expect(item.trackingNumber).toBe(s.trackingNumber);
      }

      const reloaded = await asTenant(tenantId, () => manifestsSvc.getById(manifest.id));
      expect(reloaded.itemCount).toBe(2);
      const items = await asTenant(tenantId, () => manifestsSvc.getItems(manifest.id));
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.scanStatus === "EXPECTED")).toBe(true);
    });

    it("rejects the same shipment twice on one manifest", async () => {
      const tenantId = await seedTenant("cu-dupe");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const shipment = await seedShipment(tenantId, merchantId);

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.addItem(manifest.id, {
          idempotencyKey: randomUUID(),
          shipmentId: shipment.id,
        }),
      );

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.addItem(manifest.id, {
            idempotencyKey: randomUUID(),
            shipmentId: shipment.id,
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("rejects a shipment that cannot legally join this manifest", async () => {
      const tenantId = await seedTenant("cu-ineligible");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      // DELIVERED is terminal — it cannot be loaded onto anything.
      const delivered = await seedShipment(tenantId, merchantId, "DELIVERED");

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.addItem(manifest.id, {
            idempotencyKey: randomUUID(),
            shipmentId: delivered.id,
          }),
        ),
      ).rejects.toMatchObject({ code: "SHIPMENT_NOT_ELIGIBLE_FOR_MANIFEST" });
    });

    it("refuses to add an item after seal — service level (I14)", async () => {
      const tenantId = await seedTenant("cu-i14-service");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);
      const late = await seedShipment(tenantId, merchantId);

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.addItem(id, { idempotencyKey: randomUUID(), shipmentId: late.id }),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_NOT_OPEN" });
    });

    it("refuses to add an item after seal — database trigger (I14)", async () => {
      const tenantId = await seedTenant("cu-i14-trigger");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);
      const late = await seedShipment(tenantId, merchantId);

      // Bypassing the service entirely: the invariant must hold in the database,
      // not merely in the code path we happen to remember to use.
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`
            insert into manifest_items (tenant_id, manifest_id, shipment_id, tracking_number)
            values (${tenantId}, ${id}, ${late.id}, ${late.trackingNumber})
          `,
        ),
      ).rejects.toThrow(/immutable|invariant I14/iu);
    });

    it("refuses to delete an item after seal — database trigger (I14)", async () => {
      const tenantId = await seedTenant("cu-i14-delete");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);

      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`delete from manifest_items where manifest_id = ${id}`,
        ),
      ).rejects.toThrow(/immutable|invariant I14/iu);
    });

    it("still allows receipt scanning to UPDATE a sealed manifest's items", async () => {
      const tenantId = await seedTenant("cu-i14-update-ok");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 1);

      // The trigger guards INSERT/DELETE only — guarding UPDATE would make
      // receipt impossible, since scanning writes scan_status on a sealed row.
      const result = await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: shipments[0]?.trackingNumber ?? "" },
          ctx,
        ),
      );
      expect(result.scanStatus).toBe("SCANNED");
    });
  });

  // ── Sealing ────────────────────────────────────────────────────────────────

  describe("seal", () => {
    it("rejects an empty manifest (rule 2)", async () => {
      const tenantId = await seedTenant("cu-seal-empty");
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );
      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.seal(manifest.id, { idempotencyKey: randomUUID() }, ctx),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_EMPTY" });
    });

    it("records loaded for a hub-origin manifest but does NOT move custody", async () => {
      const tenantId = await seedTenant("cu-seal-loaded");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);

      expect(await outboxEventTypes(tenantId)).toContain("shipment.loaded");
      // Rule 5: the sender stays responsible until receipt. `loaded` is an
      // annotation — the parcel is still AT_HUB, not yet handed over.
      for (const s of shipments) {
        expect(await shipmentStatus(tenantId, s.id)).toBe("AT_HUB");
      }
    });

    it("records NO loaded event for a RETURN manifest sealed in the field", async () => {
      const tenantId = await seedTenant("cu-seal-return");
      const merchantId = await seedMerchant(tenantId);
      const hub = await seedHub(tenantId, "TUN-01");
      const driverId = randomUUID();
      // A driver's undelivered parcels: OUT_FOR_DELIVERY, not at any hub.
      const shipment = await seedShipment(tenantId, merchantId, "OUT_FOR_DELIVERY");

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          {
            idempotencyKey: randomUUID(),
            type: "RETURN",
            fromDriverId: driverId,
            toHubId: hub.id,
          },
          ctx,
        ),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.addItem(manifest.id, {
          idempotencyKey: randomUUID(),
          shipmentId: shipment.id,
        }),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.seal(manifest.id, { idempotencyKey: randomUUID() }, ctx),
      );

      // `loaded` is only legal from AT_HUB — emitting it here would be a lie.
      expect(await outboxEventTypes(tenantId)).not.toContain("shipment.loaded");
      expect(await shipmentStatus(tenantId, shipment.id)).toBe("OUT_FOR_DELIVERY");
    });

    it("publishes manifest.sealed with the frozen contents", async () => {
      const tenantId = await seedTenant("cu-seal-event");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { shipments } = await sealedManifest(tenantId, merchantId, from, to, 3);

      const payload = await payloadFor(tenantId, "manifest.sealed");
      expect(payload).toBeDefined();
      expect(payload?.["itemCount"]).toBe(3);
      expect(payload?.["fromHubId"]).toBe(from.id);
      expect(payload?.["toHubId"]).toBe(to.id);
      expect(payload?.["sealedByUserId"]).toBe(actorId);
      expect(new Set(payload?.["shipmentIds"] as string[])).toEqual(
        new Set(shipments.map((s) => s.id)),
      );
    });

    it("cannot be sealed twice", async () => {
      const tenantId = await seedTenant("cu-seal-twice");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);

      await expect(
        asTenant(tenantId, () => manifestsSvc.seal(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toMatchObject({ code: "MANIFEST_INVALID_TRANSITION" });
    });
  });

  // ── Dispatch ───────────────────────────────────────────────────────────────

  describe("dispatch", () => {
    it("moves every parcel to IN_TRANSIT", async () => {
      const tenantId = await seedTenant("cu-dispatch");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);

      const dispatched = await asTenant(tenantId, () =>
        manifestsSvc.dispatch(id, { idempotencyKey: randomUUID(), vehicleId: randomUUID() }, ctx),
      );
      expect(dispatched.status).toBe("IN_TRANSIT");
      expect(dispatched.dispatchedAt).not.toBeNull();

      for (const s of shipments) {
        expect(await shipmentStatus(tenantId, s.id)).toBe("IN_TRANSIT");
      }
      expect(await outboxEventTypes(tenantId)).toContain("shipment.departed");
      expect(await payloadFor(tenantId, "manifest.dispatched")).toBeDefined();
    });

    it("refuses to dispatch a DISPATCH manifest — the last mile is a route", async () => {
      const tenantId = await seedTenant("cu-dispatch-lastmile");
      const merchantId = await seedMerchant(tenantId);
      const hub = await seedHub(tenantId, "TUN-01");
      const shipment = await seedShipment(tenantId, merchantId);

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          {
            idempotencyKey: randomUUID(),
            type: "DISPATCH",
            fromHubId: hub.id,
            toDriverId: randomUUID(),
          },
          ctx,
        ),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.addItem(manifest.id, {
          idempotencyKey: randomUUID(),
          shipmentId: shipment.id,
        }),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.seal(manifest.id, { idempotencyKey: randomUUID() }, ctx),
      );

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.dispatch(manifest.id, { idempotencyKey: randomUUID() }, ctx),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_NOT_DISPATCHABLE" });
    });

    it("cannot dispatch before sealing", async () => {
      const tenantId = await seedTenant("cu-dispatch-open");
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");

      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );
      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.dispatch(manifest.id, { idempotencyKey: randomUUID() }, ctx),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_INVALID_TRANSITION" });
    });
  });

  // ── Receipt — where custody actually moves ─────────────────────────────────

  describe("receive", () => {
    it("transfers custody to the destination hub on scan (rule 5)", async () => {
      const tenantId = await seedTenant("cu-receive");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);
      await asTenant(tenantId, () =>
        manifestsSvc.dispatch(id, { idempotencyKey: randomUUID() }, ctx),
      );

      const parcel = shipments[0];
      const result = await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: parcel?.trackingNumber ?? "" },
          ctx,
        ),
      );

      expect(result.scanStatus).toBe("SCANNED");
      expect(result.summary).toEqual({ total: 2, scanned: 1, outstanding: 1 });
      expect(await shipmentStatus(tenantId, parcel?.id ?? "")).toBe("AT_HUB");
      // The unscanned one is still in transit — custody is per parcel.
      expect(await shipmentStatus(tenantId, shipments[1]?.id ?? "")).toBe("IN_TRANSIT");
    });

    it("stores device time and server time separately", async () => {
      const tenantId = await seedTenant("cu-receive-times");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 1);

      const deviceTime = new Date(Date.now() - 3 * 3600_000);
      await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          {
            idempotencyKey: randomUUID(),
            trackingNumber: shipments[0]?.trackingNumber ?? "",
            scannedAt: deviceTime.toISOString(),
          },
          ctx,
        ),
      );

      const items = await asTenant(tenantId, () => manifestsSvc.getItems(id));
      expect(items[0]?.scannedAt?.getTime()).toBe(deviceTime.getTime());
      expect(items[0]?.recordedAt?.getTime()).toBeGreaterThan(deviceTime.getTime());
    });

    it("is idempotent when the same operator re-scans", async () => {
      const tenantId = await seedTenant("cu-receive-replay");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 1);
      // Dispatch first: only a parcel in transit can *arrive* somewhere.
      await asTenant(tenantId, () =>
        manifestsSvc.dispatch(id, { idempotencyKey: randomUUID() }, ctx),
      );
      const tracking = shipments[0]?.trackingNumber ?? "";

      const first = await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: tracking },
          ctx,
        ),
      );
      const second = await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: tracking },
          ctx,
        ),
      );

      expect(second.scannedAt.getTime()).toBe(first.scannedAt.getTime());
      expect(second.summary).toEqual({ total: 1, scanned: 1, outstanding: 0 });
      const arrivals = (await outboxEventTypes(tenantId)).filter(
        (e) => e === "shipment.arrived_at_hub",
      );
      expect(arrivals).toHaveLength(1);
    });

    it("rejects a parcel already received by a different operator", async () => {
      const tenantId = await seedTenant("cu-receive-conflict");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 1);
      const tracking = shipments[0]?.trackingNumber ?? "";

      await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: tracking },
          ctx,
        ),
      );
      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.receiveScan(
            id,
            { idempotencyKey: randomUUID(), trackingNumber: tracking },
            { actorId: randomUUID() },
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("records an UNEXPECTED discrepancy for a barcode not on the manifest", async () => {
      const tenantId = await seedTenant("cu-receive-unexpected");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);
      const stray = await seedShipment(tenantId, merchantId);

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.receiveScan(
            id,
            { idempotencyKey: randomUUID(), trackingNumber: stray.trackingNumber },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "BARCODE_NOT_ON_MANIFEST" });

      // The throw must NOT have rolled back the discrepancy: the parcel is
      // physically here and nothing else would remember it.
      const report = await asTenant(tenantId, () => manifestsSvc.getDiscrepancies(id));
      expect(report.unexpected).toHaveLength(1);
      expect(report.unexpected[0]?.trackingNumber).toBe(stray.trackingNumber);
      expect(report.unexpected[0]?.shipmentId).toBe(stray.id);
    });

    it("records an UNEXPECTED discrepancy for a barcode matching no shipment", async () => {
      const tenantId = await seedTenant("cu-receive-ghost");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.receiveScan(
            id,
            { idempotencyKey: randomUUID(), trackingNumber: "SD-GHOST-999" },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "BARCODE_NOT_ON_MANIFEST" });

      const report = await asTenant(tenantId, () => manifestsSvc.getDiscrepancies(id));
      expect(report.unexpected[0]?.trackingNumber).toBe("SD-GHOST-999");
      expect(report.unexpected[0]?.shipmentId).toBeNull();
    });

    it("rejects receiving an OPEN manifest", async () => {
      const tenantId = await seedTenant("cu-receive-open");
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.receiveScan(
            manifest.id,
            { idempotencyKey: randomUUID(), trackingNumber: "SD-X" },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_NOT_RECEIVABLE" });
    });
  });

  // ── Offline batch receipt ──────────────────────────────────────────────────

  describe("receive: offline batch sync", () => {
    function queued(trackingNumber: string, minutesAgo: number): Record<string, unknown> {
      return {
        idempotencyKey: randomUUID(),
        trackingNumber,
        scannedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      };
    }

    it("accepts a full pallet and reports one summary", async () => {
      const tenantId = await seedTenant("cu-batch-ok");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 3);

      const result = await asTenant(tenantId, () =>
        manifestsSvc.receiveScanBatch(
          id,
          { scans: shipments.map((s, i) => queued(s.trackingNumber, 30 - i)) },
          ctx,
        ),
      );

      expect(result.accepted).toBe(3);
      expect(result.rejected).toBe(0);
      expect(result.summary).toEqual({ total: 3, scanned: 3, outstanding: 0 });
      expect(result.results.every((r) => r.status === "ACCEPTED")).toBe(true);
      for (const s of shipments) {
        expect(await shipmentStatus(tenantId, s.id)).toBe("AT_HUB");
      }
    });

    it("keeps good scans when one barcode is unknown — never all-or-nothing", async () => {
      const tenantId = await seedTenant("cu-batch-partial");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);

      const result = await asTenant(tenantId, () =>
        manifestsSvc.receiveScanBatch(
          id,
          {
            scans: [
              queued(shipments[0]?.trackingNumber ?? "", 20),
              queued("SD-GHOST-001", 19),
              queued(shipments[1]?.trackingNumber ?? "", 18),
            ],
          },
          ctx,
        ),
      );

      expect(result.accepted).toBe(2);
      expect(result.rejected).toBe(1);
      expect(result.summary).toEqual({ total: 2, scanned: 2, outstanding: 0 });
      expect(result.results[1]?.status).toBe("REJECTED");
      expect(result.results[1]?.action).toBe("ESCALATE_TO_DISPATCHER");

      // The stray was recorded, not silently dropped.
      const report = await asTenant(tenantId, () => manifestsSvc.getDiscrepancies(id));
      expect(report.unexpected).toHaveLength(1);
    });

    it("flags a parcel taken by another operator as CONFLICT", async () => {
      const tenantId = await seedTenant("cu-batch-conflict");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);
      const contested = shipments[0]?.trackingNumber ?? "";

      await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: contested },
          { actorId: randomUUID() },
        ),
      );

      const result = await asTenant(tenantId, () =>
        manifestsSvc.receiveScanBatch(
          id,
          { scans: [queued(contested, 45), queued(shipments[1]?.trackingNumber ?? "", 44)] },
          ctx,
        ),
      );

      expect(result.results[0]?.status).toBe("CONFLICT");
      expect(result.results[0]?.action).toBe("DISCARD_AND_REFRESH");
      expect(result.results[1]?.status).toBe("ACCEPTED");
    });

    it("is a clean no-op when the device replays the whole batch", async () => {
      const tenantId = await seedTenant("cu-batch-replay");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);
      await asTenant(tenantId, () =>
        manifestsSvc.dispatch(id, { idempotencyKey: randomUUID() }, ctx),
      );

      const batch = { scans: shipments.map((s, i) => queued(s.trackingNumber, 60 - i)) };
      const first = await asTenant(tenantId, () => manifestsSvc.receiveScanBatch(id, batch, ctx));
      const replay = await asTenant(tenantId, () => manifestsSvc.receiveScanBatch(id, batch, ctx));

      expect(first.accepted).toBe(2);
      expect(replay.accepted).toBe(2);
      const arrivals = (await outboxEventTypes(tenantId)).filter(
        (e) => e === "shipment.arrived_at_hub",
      );
      expect(arrivals).toHaveLength(2);
    });

    it("rejects an empty batch and one over 200", async () => {
      const tenantId = await seedTenant("cu-batch-bounds");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);

      await expect(
        asTenant(tenantId, () => manifestsSvc.receiveScanBatch(id, { scans: [] }, ctx)),
      ).rejects.toThrow();
      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.receiveScanBatch(
            id,
            { scans: Array.from({ length: 201 }, () => queued("SD-X", 1)) },
            ctx,
          ),
        ),
      ).rejects.toThrow();
    });

    it("requires a device timestamp on every queued scan", async () => {
      const tenantId = await seedTenant("cu-batch-notime");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 1);

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.receiveScanBatch(
            id,
            {
              scans: [
                {
                  idempotencyKey: randomUUID(),
                  trackingNumber: shipments[0]?.trackingNumber ?? "",
                },
              ],
            },
            ctx,
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ── Discrepancies and reconciliation ───────────────────────────────────────

  describe("discrepancies", () => {
    it("raises MISSING for every parcel that never arrived", async () => {
      const tenantId = await seedTenant("cu-missing");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 3);

      await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: shipments[0]?.trackingNumber ?? "" },
          ctx,
        ),
      );
      const report = await asTenant(tenantId, () =>
        manifestsSvc.finaliseReceipt(id, { idempotencyKey: randomUUID() }, ctx),
      );

      expect(report.expectedCount).toBe(3);
      expect(report.scannedCount).toBe(1);
      expect(report.missing).toHaveLength(2);
      expect(report.discrepancyCount).toBe(2);
      expect(new Set(report.missing.map((m) => m.shipmentId))).toEqual(
        new Set(shipments.slice(1).map((s) => s.id)),
      );

      const manifest = await asTenant(tenantId, () => manifestsSvc.getById(id));
      expect(manifest.status).toBe("RECEIVED");
      expect(manifest.discrepancyCount).toBe(2);
      expect(await outboxEventTypes(tenantId)).toContain("manifest.discrepancy_raised");
    });

    it("reports a clean receipt with no discrepancies", async () => {
      const tenantId = await seedTenant("cu-clean");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);

      for (const s of shipments) {
        await asTenant(tenantId, () =>
          manifestsSvc.receiveScan(
            id,
            { idempotencyKey: randomUUID(), trackingNumber: s.trackingNumber },
            ctx,
          ),
        );
      }
      const report = await asTenant(tenantId, () =>
        manifestsSvc.finaliseReceipt(id, { idempotencyKey: randomUUID() }, ctx),
      );

      expect(report.discrepancyCount).toBe(0);
      expect(report.missing).toHaveLength(0);
      expect(await outboxEventTypes(tenantId)).toContain("manifest.received");
      expect(await outboxEventTypes(tenantId)).not.toContain("manifest.discrepancy_raised");
    });

    it("blocks RECONCILED until every discrepancy is explained (rule 4)", async () => {
      const tenantId = await seedTenant("cu-reconcile-block");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 2);

      await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          id,
          { idempotencyKey: randomUUID(), trackingNumber: shipments[0]?.trackingNumber ?? "" },
          ctx,
        ),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.finaliseReceipt(id, { idempotencyKey: randomUUID() }, ctx),
      );

      await expect(asTenant(tenantId, () => manifestsSvc.reconcile(id, ctx))).rejects.toMatchObject(
        { code: "MANIFEST_HAS_UNRESOLVED_DISCREPANCIES" },
      );

      const resolved = await asTenant(tenantId, () =>
        manifestsSvc.resolveDiscrepancy(
          id,
          {
            idempotencyKey: randomUUID(),
            trackingNumber: shipments[1]?.trackingNumber ?? "",
            reason: "Found behind the roller cage; rescanned next morning",
          },
          ctx,
        ),
      );
      expect(resolved.resolutionReason).toContain("roller cage");
      expect(resolved.resolvedByUserId).toBe(actorId);
      expect(resolved.resolvedAt).not.toBeNull();

      const reconciled = await asTenant(tenantId, () => manifestsSvc.reconcile(id, ctx));
      expect(reconciled.status).toBe("RECONCILED");
      expect(reconciled.reconciledAt).not.toBeNull();
    });

    it("does not duplicate rows when finaliseReceipt is re-run", async () => {
      const tenantId = await seedTenant("cu-finalise-twice");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 2);

      const first = await asTenant(tenantId, () =>
        manifestsSvc.finaliseReceipt(id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(first.missing).toHaveLength(2);

      // RECEIVED → RECEIVED is not a legal transition, so a second call is
      // refused outright rather than writing a second set of rows.
      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.finaliseReceipt(id, { idempotencyKey: randomUUID() }, ctx),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_INVALID_TRANSITION" });

      const report = await asTenant(tenantId, () => manifestsSvc.getDiscrepancies(id));
      expect(report.missing).toHaveLength(2);
    });

    it("rejects resolving a discrepancy that does not exist", async () => {
      const tenantId = await seedTenant("cu-resolve-missing");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id } = await sealedManifest(tenantId, merchantId, from, to, 1);
      await asTenant(tenantId, () =>
        manifestsSvc.finaliseReceipt(id, { idempotencyKey: randomUUID() }, ctx),
      );

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.resolveDiscrepancy(
            id,
            { idempotencyKey: randomUUID(), trackingNumber: "SD-NOPE", reason: "n/a" },
            ctx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects resolving before the manifest is RECEIVED", async () => {
      const tenantId = await seedTenant("cu-resolve-early");
      const merchantId = await seedMerchant(tenantId);
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantId, merchantId, from, to, 1);

      await expect(
        asTenant(tenantId, () =>
          manifestsSvc.resolveDiscrepancy(
            id,
            {
              idempotencyKey: randomUUID(),
              trackingNumber: shipments[0]?.trackingNumber ?? "",
              reason: "too early",
            },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "MANIFEST_NOT_RECEIVED" });
    });
  });

  // ── Hub inbound scanning ───────────────────────────────────────────────────

  describe("hub inbound scan", () => {
    it("books a picked-up parcel into hub custody", async () => {
      const tenantId = await seedTenant("cu-inbound");
      const merchantId = await seedMerchant(tenantId);
      const hub = await seedHub(tenantId, "TUN-01");
      const parcel = await seedShipment(tenantId, merchantId, "PICKED_UP");

      const result = await asTenant(tenantId, () =>
        hubScans.scan(
          hub.id,
          { idempotencyKey: randomUUID(), trackingNumber: parcel.trackingNumber },
          ctx,
        ),
      );

      expect(result.status).toBe("ACCEPTED");
      expect(result.shipmentId).toBe(parcel.id);
      expect(result.shipmentStatus).toBe("AT_HUB");
      expect(await shipmentStatus(tenantId, parcel.id)).toBe("AT_HUB");
      expect(await outboxEventTypes(tenantId)).toContain("shipment.arrived_at_hub");
    });

    it("is idempotent on re-scan at the same hub", async () => {
      const tenantId = await seedTenant("cu-inbound-replay");
      const merchantId = await seedMerchant(tenantId);
      const hub = await seedHub(tenantId, "TUN-01");
      const parcel = await seedShipment(tenantId, merchantId, "PICKED_UP");

      await asTenant(tenantId, () =>
        hubScans.scan(
          hub.id,
          { idempotencyKey: randomUUID(), trackingNumber: parcel.trackingNumber },
          ctx,
        ),
      );
      const second = await asTenant(tenantId, () =>
        hubScans.scan(
          hub.id,
          { idempotencyKey: randomUUID(), trackingNumber: parcel.trackingNumber },
          ctx,
        ),
      );

      expect(second.status).toBe("ACCEPTED");
      const arrivals = (await outboxEventTypes(tenantId)).filter(
        (e) => e === "shipment.arrived_at_hub",
      );
      expect(arrivals).toHaveLength(1);
    });

    it("rejects an unknown barcode without throwing", async () => {
      const tenantId = await seedTenant("cu-inbound-ghost");
      const hub = await seedHub(tenantId, "TUN-01");

      const result = await asTenant(tenantId, () =>
        hubScans.scan(
          hub.id,
          { idempotencyKey: randomUUID(), trackingNumber: "SD-GHOST-777" },
          ctx,
        ),
      );
      expect(result.status).toBe("REJECTED");
      expect(result.action).toBe("ESCALATE_TO_DISPATCHER");
      expect(result.shipmentId).toBeNull();
      expect(result.shipmentStatus).toBe("UNKNOWN");
    });

    it("rejects a parcel in a status that cannot enter a hub", async () => {
      const tenantId = await seedTenant("cu-inbound-terminal");
      const merchantId = await seedMerchant(tenantId);
      const hub = await seedHub(tenantId, "TUN-01");
      const delivered = await seedShipment(tenantId, merchantId, "DELIVERED");

      const result = await asTenant(tenantId, () =>
        hubScans.scan(
          hub.id,
          { idempotencyKey: randomUUID(), trackingNumber: delivered.trackingNumber },
          ctx,
        ),
      );
      expect(result.status).toBe("REJECTED");
      expect(result.shipmentStatus).toBe("DELIVERED");
    });

    it("syncs a van-load offline, with per-item verdicts", async () => {
      const tenantId = await seedTenant("cu-inbound-batch");
      const merchantId = await seedMerchant(tenantId);
      const hub = await seedHub(tenantId, "TUN-01");
      const parcels = await seedShipments(tenantId, merchantId, 3, "PICKED_UP");

      const result = await asTenant(tenantId, () =>
        hubScans.scanBatch(
          hub.id,
          {
            scans: [
              ...parcels.map((p, i) => ({
                idempotencyKey: randomUUID(),
                trackingNumber: p.trackingNumber,
                scannedAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
              })),
              {
                idempotencyKey: randomUUID(),
                trackingNumber: "SD-UNREADABLE",
                scannedAt: new Date().toISOString(),
              },
            ],
          },
          ctx,
        ),
      );

      expect(result.total).toBe(4);
      expect(result.accepted).toBe(3);
      expect(result.rejected).toBe(1);
      expect(result.results.map((r) => r.index)).toEqual([0, 1, 2, 3]);
      for (const p of parcels) {
        expect(await shipmentStatus(tenantId, p.id)).toBe("AT_HUB");
      }
    });

    it("throws NotFoundError for an unknown hub", async () => {
      const tenantId = await seedTenant("cu-inbound-nohub");
      await expect(
        asTenant(tenantId, () =>
          hubScans.scan(
            randomUUID(),
            { idempotencyKey: randomUUID(), trackingNumber: "SD-X" },
            ctx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── The full chain ─────────────────────────────────────────────────────────

  describe("end-to-end custody chain", () => {
    it("carries a parcel PICKED_UP → AT_HUB → IN_TRANSIT → AT_HUB", async () => {
      const tenantId = await seedTenant("cu-chain");
      const merchantId = await seedMerchant(tenantId);
      const origin = await seedHub(tenantId, "TUN-01");
      const destination = await seedHub(tenantId, "SFA-02");
      const parcel = await seedShipment(tenantId, merchantId, "PICKED_UP");

      // 1. The driver hands it in at the origin hub.
      await asTenant(tenantId, () =>
        hubScans.scan(
          origin.id,
          { idempotencyKey: randomUUID(), trackingNumber: parcel.trackingNumber },
          ctx,
        ),
      );
      expect(await shipmentStatus(tenantId, parcel.id)).toBe("AT_HUB");

      // 2. It is loaded onto a linehaul manifest and sealed.
      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          {
            idempotencyKey: randomUUID(),
            type: "LINEHAUL",
            fromHubId: origin.id,
            toHubId: destination.id,
          },
          ctx,
        ),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.addItem(manifest.id, {
          idempotencyKey: randomUUID(),
          shipmentId: parcel.id,
        }),
      );
      await asTenant(tenantId, () =>
        manifestsSvc.seal(manifest.id, { idempotencyKey: randomUUID() }, ctx),
      );
      // Sealing does not move custody — the origin hub still holds it.
      expect(await shipmentStatus(tenantId, parcel.id)).toBe("AT_HUB");

      // 3. The truck leaves.
      await asTenant(tenantId, () =>
        manifestsSvc.dispatch(manifest.id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(await shipmentStatus(tenantId, parcel.id)).toBe("IN_TRANSIT");

      // 4. The destination hub signs for it — custody moves here (rule 5).
      await asTenant(tenantId, () =>
        manifestsSvc.receiveScan(
          manifest.id,
          { idempotencyKey: randomUUID(), trackingNumber: parcel.trackingNumber },
          ctx,
        ),
      );
      expect(await shipmentStatus(tenantId, parcel.id)).toBe("AT_HUB");

      const report = await asTenant(tenantId, () =>
        manifestsSvc.finaliseReceipt(manifest.id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(report.discrepancyCount).toBe(0);

      const closed = await asTenant(tenantId, () => manifestsSvc.reconcile(manifest.id, ctx));
      expect(closed.status).toBe("RECONCILED");

      const events = await outboxEventTypes(tenantId);
      expect(events).toContain("shipment.arrived_at_hub");
      expect(events).toContain("shipment.loaded");
      expect(events).toContain("shipment.departed");
      expect(events).toContain("manifest.sealed");
      expect(events).toContain("manifest.dispatched");
      expect(events).toContain("manifest.received");
      expect(events).toContain("manifest.reconciled");
    });
  });

  // ── Reads and pagination ───────────────────────────────────────────────────

  describe("queries", () => {
    it("finds a manifest by code and by id", async () => {
      const tenantId = await seedTenant("cu-read");
      const from = await seedHub(tenantId, "TUN-01");
      const to = await seedHub(tenantId, "SFA-02");
      const manifest = await asTenant(tenantId, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );

      expect((await asTenant(tenantId, () => manifestsSvc.getById(manifest.id))).id).toBe(
        manifest.id,
      );
      expect((await asTenant(tenantId, () => manifestsSvc.getByCode(manifest.code))).id).toBe(
        manifest.id,
      );
    });

    it("throws NotFoundError for unknown ids and codes", async () => {
      const tenantId = await seedTenant("cu-read-miss");
      await expect(
        asTenant(tenantId, () => manifestsSvc.getById(randomUUID())),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        asTenant(tenantId, () => manifestsSvc.getByCode("MF-NOPE-20260101-001")),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        asTenant(tenantId, () => manifestsSvc.getItems(randomUUID())),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        asTenant(tenantId, () => manifestsSvc.getDiscrepancies(randomUUID())),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("paginates and filters", async () => {
      const tenantId = await seedTenant("cu-list");
      const a = await seedHub(tenantId, "TUN-01");
      const b = await seedHub(tenantId, "SFA-02");

      for (let i = 0; i < 3; i += 1) {
        await asTenant(tenantId, () =>
          manifestsSvc.open(
            { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: a.id, toHubId: b.id },
            ctx,
          ),
        );
      }
      await asTenant(tenantId, () =>
        manifestsSvc.open({ idempotencyKey: randomUUID(), type: "TRANSFER", fromHubId: b.id }, ctx),
      );

      const page1 = await asTenant(tenantId, () => manifestsSvc.list({ limit: 2 }));
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await asTenant(tenantId, () =>
        manifestsSvc.list({ limit: 2, cursor: page1.nextCursor ?? "" }),
      );
      expect(page2.items).toHaveLength(2);

      const linehauls = await asTenant(tenantId, () => manifestsSvc.list({ type: "LINEHAUL" }));
      expect(linehauls.items).toHaveLength(3);

      const fromB = await asTenant(tenantId, () => manifestsSvc.list({ fromHubId: b.id }));
      expect(fromB.items).toHaveLength(1);

      const open = await asTenant(tenantId, () => manifestsSvc.list({ status: "OPEN" }));
      expect(open.items).toHaveLength(4);
    });
  });

  // ── Tenant isolation (RLS) ─────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("hides another tenant's manifest", async () => {
      const tenantA = await seedTenant("cu-iso-a");
      const tenantB = await seedTenant("cu-iso-b");
      const from = await seedHub(tenantA, "TUN-01");
      const to = await seedHub(tenantA, "SFA-02");
      const manifest = await asTenant(tenantA, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );

      await expect(
        asTenant(tenantB, () => manifestsSvc.getById(manifest.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        asTenant(tenantB, () => manifestsSvc.getByCode(manifest.code)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        asTenant(tenantB, () => manifestsSvc.getItems(manifest.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses to add an item across tenants", async () => {
      const tenantA = await seedTenant("cu-iso-add-a");
      const tenantB = await seedTenant("cu-iso-add-b");
      const merchantB = await seedMerchant(tenantB);
      const from = await seedHub(tenantA, "TUN-01");
      const to = await seedHub(tenantA, "SFA-02");
      const manifest = await asTenant(tenantA, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: from.id, toHubId: to.id },
          ctx,
        ),
      );
      const theirParcel = await seedShipment(tenantB, merchantB);

      await expect(
        asTenant(tenantB, () =>
          manifestsSvc.addItem(manifest.id, {
            idempotencyKey: randomUUID(),
            shipmentId: theirParcel.id,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses to receive against another tenant's manifest", async () => {
      const tenantA = await seedTenant("cu-iso-recv-a");
      const tenantB = await seedTenant("cu-iso-recv-b");
      const merchantA = await seedMerchant(tenantA);
      const from = await seedHub(tenantA, "TUN-01");
      const to = await seedHub(tenantA, "SFA-02");
      const { id, shipments } = await sealedManifest(tenantA, merchantA, from, to, 1);

      await expect(
        asTenant(tenantB, () =>
          manifestsSvc.receiveScan(
            id,
            { idempotencyKey: randomUUID(), trackingNumber: shipments[0]?.trackingNumber ?? "" },
            ctx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("lists only the current tenant's manifests", async () => {
      const tenantA = await seedTenant("cu-iso-list-a");
      const tenantB = await seedTenant("cu-iso-list-b");
      const a1 = await seedHub(tenantA, "TUN-01");
      const a2 = await seedHub(tenantA, "SFA-02");
      const b1 = await seedHub(tenantB, "TUN-01");

      await asTenant(tenantA, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "LINEHAUL", fromHubId: a1.id, toHubId: a2.id },
          ctx,
        ),
      );
      await asTenant(tenantB, () =>
        manifestsSvc.open(
          { idempotencyKey: randomUUID(), type: "TRANSFER", fromHubId: b1.id },
          ctx,
        ),
      );

      expect((await asTenant(tenantA, () => manifestsSvc.list({}))).items).toHaveLength(1);
      expect((await asTenant(tenantB, () => manifestsSvc.list({}))).items).toHaveLength(1);
    });
  });
});
