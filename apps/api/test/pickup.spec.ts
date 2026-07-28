import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PickupService } from "../src/modules/pickup/application/pickup.service.js";
import {
  canPickupTransition,
  toPickupStatus,
  PICKUP_STATUSES,
  TERMINAL_PICKUP_STATUSES,
} from "../src/modules/pickup/domain/pickup-status.js";
import type { PickupStatus } from "../src/modules/pickup/domain/pickup-status.js";
import { formatPickupCode } from "../src/modules/pickup/domain/pickup-code.js";
import { OUTCOME_REASONS } from "../src/modules/pickup/domain/dtos.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
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

/** A pickup driven to ASSIGNED, with its expected parcels already linked. */
interface ReadyPickup {
  readonly id: string;
  readonly driverId: string;
  readonly shipments: readonly SeededShipment[];
}

describe("pickup", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let pickups: PickupService;
  let merchantsSvc: MerchantService;
  let addressesSvc: AddressService;
  let createdTenants: string[] = [];

  const actorId = randomUUID();
  const ctx = { actorId };

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedMerchant(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return asTenant(tenantId, async () => {
      const m = await merchantsSvc.create({
        name: `Merchant ${Math.random().toString(36).slice(2, 8)}`,
        ...overrides,
      });
      return m.id;
    });
  }

  async function seedAddress(tenantId: string): Promise<string> {
    return asTenant(tenantId, async () => {
      const resolved = await addressesSvc.resolve({
        rawInput: "123 Rue de la République, Tunis",
        city: "Tunis",
        countryCode: "TN",
        coordinates: { lat: 36.8008, lng: 10.1817 },
      });
      return resolved.addressId;
    });
  }

  /**
   * Seeds a shipment by raw SQL rather than through ShipmentService.
   *
   * Deliberate: pickup and shipment are both Layer 2 and may not import each
   * other, so the test exercises pickup exactly the way production does — reading
   * the `shipments` table across the boundary, never the other module's API.
   */
  async function seedShipment(
    tenantId: string,
    merchantId: string,
    addressId: string,
    status = "CREATED",
  ): Promise<SeededShipment> {
    const trackingNumber = `SD-TEST-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<{ id: string }[]>`
        insert into shipments (
          tenant_id, tracking_number, merchant_id, status,
          sender_name, sender_phone, origin_address_id,
          recipient_name, recipient_phone, destination_address_id,
          currency
        ) values (
          ${tenantId}, ${trackingNumber}, ${merchantId}, ${status},
          'Sender SA', '+21620000001', ${addressId},
          'Recipient SA', '+21620000002', ${addressId},
          'TND'
        )
        returning id
      `,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("failed to seed test shipment");
    }
    return { id: row.id, trackingNumber };
  }

  async function seedShipments(
    tenantId: string,
    merchantId: string,
    addressId: string,
    count: number,
    status = "CREATED",
  ): Promise<SeededShipment[]> {
    const created: SeededShipment[] = [];
    for (let i = 0; i < count; i += 1) {
      created.push(await seedShipment(tenantId, merchantId, addressId, status));
    }
    return created;
  }

  async function suspendMerchant(tenantId: string, merchantId: string): Promise<void> {
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx`update merchants set status = 'SUSPENDED', updated_at = now() where id = ${merchantId}`,
    );
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

  async function outboxPayloads(
    tenantId: string,
    eventType: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<
          { payload: Record<string, unknown> }[]
        >`select payload from outbox where tenant_id = ${tenantId} and event_type = ${eventType} order by seq`,
    );
    return rows.map((r) => r.payload);
  }

  /** The single event published for a pickup, or undefined when none was. */
  async function payloadFor(
    tenantId: string,
    eventType: string,
    pickupRequestId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const payloads = await outboxPayloads(tenantId, eventType);
    return payloads.find((p) => p["pickupRequestId"] === pickupRequestId);
  }

  async function scanRows(
    tenantId: string,
    pickupRequestId: string,
  ): Promise<
    {
      shipment_id: string;
      tracking_number: string;
      scan_status: string;
      scanned_at: Date | null;
      recorded_at: Date | null;
      scanned_by_driver_id: string | null;
      idempotency_key: string | null;
    }[]
  > {
    return withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx`select shipment_id, tracking_number, scan_status, scanned_at, recorded_at,
                  scanned_by_driver_id, idempotency_key
             from pickup_shipments
            where pickup_request_id = ${pickupRequestId}
            order by created_at`,
    );
  }

  function window(hoursFromNow = 1, durationHours = 2): { from: Date; to: Date } {
    const from = new Date(Date.now() + hoursFromNow * 3600_000);
    const to = new Date(from.getTime() + durationHours * 3600_000);
    return { from, to };
  }

  function createInput(
    merchantId: string,
    addressId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const w = window();
    return {
      idempotencyKey: randomUUID(),
      merchantId,
      pickupAddressId: addressId,
      contactName: "Farah Ben Salah",
      contactPhone: "+21620123456",
      requestedWindowFrom: w.from.toISOString(),
      requestedWindowTo: w.to.toISOString(),
      ...overrides,
    };
  }

  async function requestPickup(
    tenantId: string,
    merchantId: string,
    addressId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string }> {
    return asTenant(tenantId, async () => {
      const pickup = await pickups.request(createInput(merchantId, addressId, overrides), ctx);
      return { id: pickup.id, code: pickup.code };
    });
  }

  /** request → accept → assign, seeding `parcelCount` expected shipments first. */
  async function readyPickup(
    tenantId: string,
    merchantId: string,
    addressId: string,
    parcelCount = 3,
  ): Promise<ReadyPickup> {
    const shipments = await seedShipments(tenantId, merchantId, addressId, parcelCount);
    const { id } = await requestPickup(tenantId, merchantId, addressId, {
      ...(parcelCount === 0 ? {} : { shipmentIds: shipments.map((s) => s.id) }),
    });
    await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
    const driverId = randomUUID();
    await asTenant(tenantId, () =>
      pickups.assign(id, { idempotencyKey: randomUUID(), driverId }, ctx),
    );
    return { id, driverId, shipments };
  }

  async function scanOne(
    tenantId: string,
    pickupId: string,
    driverId: string,
    trackingNumber: string,
    overrides: Record<string, unknown> = {},
  ): ReturnType<PickupService["scan"]> {
    return asTenant(tenantId, () =>
      pickups.scan(
        pickupId,
        { idempotencyKey: randomUUID(), trackingNumber, ...overrides },
        { actorId: driverId },
      ),
    );
  }

  async function fullLifecycle(
    tenantId: string,
    merchantId: string,
    addressId: string,
    parcelCount = 3,
  ): Promise<string> {
    const ready = await readyPickup(tenantId, merchantId, addressId, parcelCount);
    for (const s of ready.shipments) {
      await scanOne(tenantId, ready.id, ready.driverId, s.trackingNumber);
    }
    await asTenant(tenantId, () =>
      pickups.collect(
        ready.id,
        {
          idempotencyKey: randomUUID(),
          ...(parcelCount === 0 ? { outcomeReason: "NO_PARCELS_AVAILABLE" } : {}),
        },
        ctx,
      ),
    );
    await asTenant(tenantId, () =>
      pickups.complete(ready.id, { idempotencyKey: randomUUID() }, ctx),
    );
    return ready.id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    addressesSvc = new AddressService(db, outbox, new ManualGeocodingProvider());
    merchantsSvc = new MerchantService(db, outbox);
    pickups = new PickupService(db, outbox);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Pure domain unit tests ──────────────────────────────────────────────────

  describe("domain: state machine", () => {
    it("allows the happy-path forward chain", () => {
      expect(canPickupTransition("REQUESTED", "ACCEPTED")).toBe(true);
      expect(canPickupTransition("ACCEPTED", "ASSIGNED")).toBe(true);
      expect(canPickupTransition("ASSIGNED", "COLLECTED")).toBe(true);
      expect(canPickupTransition("COLLECTED", "COMPLETED")).toBe(true);
    });

    it("allows cancellation from REQUESTED, ACCEPTED, ASSIGNED", () => {
      expect(canPickupTransition("REQUESTED", "CANCELLED")).toBe(true);
      expect(canPickupTransition("ACCEPTED", "CANCELLED")).toBe(true);
      expect(canPickupTransition("ASSIGNED", "CANCELLED")).toBe(true);
    });

    it("rejects cancellation after COLLECTED (invariant I21)", () => {
      expect(canPickupTransition("COLLECTED", "CANCELLED")).toBe(false);
    });

    it("rejects transitions from terminal states", () => {
      const targets: PickupStatus[] = [
        "REQUESTED",
        "ACCEPTED",
        "ASSIGNED",
        "COLLECTED",
        "COMPLETED",
        "CANCELLED",
      ];
      for (const target of targets) {
        expect(canPickupTransition("COMPLETED", target)).toBe(false);
        expect(canPickupTransition("CANCELLED", target)).toBe(false);
      }
    });

    it("rejects backward transitions", () => {
      expect(canPickupTransition("ACCEPTED", "REQUESTED")).toBe(false);
      expect(canPickupTransition("ASSIGNED", "ACCEPTED")).toBe(false);
      expect(canPickupTransition("COLLECTED", "ASSIGNED")).toBe(false);
      expect(canPickupTransition("COMPLETED", "COLLECTED")).toBe(false);
    });

    it("rejects skipping steps", () => {
      expect(canPickupTransition("REQUESTED", "ASSIGNED")).toBe(false);
      expect(canPickupTransition("REQUESTED", "COLLECTED")).toBe(false);
      expect(canPickupTransition("REQUESTED", "COMPLETED")).toBe(false);
      expect(canPickupTransition("ACCEPTED", "COLLECTED")).toBe(false);
      expect(canPickupTransition("ACCEPTED", "COMPLETED")).toBe(false);
      expect(canPickupTransition("ASSIGNED", "COMPLETED")).toBe(false);
    });

    it("TERMINAL_PICKUP_STATUSES contains only COMPLETED and CANCELLED", () => {
      expect(TERMINAL_PICKUP_STATUSES.size).toBe(2);
      expect(TERMINAL_PICKUP_STATUSES.has("COMPLETED")).toBe(true);
      expect(TERMINAL_PICKUP_STATUSES.has("CANCELLED")).toBe(true);
    });

    it("PICKUP_STATUSES enumerates all six", () => {
      expect(PICKUP_STATUSES).toHaveLength(6);
      expect(PICKUP_STATUSES).toContain("REQUESTED");
      expect(PICKUP_STATUSES).toContain("ACCEPTED");
      expect(PICKUP_STATUSES).toContain("ASSIGNED");
      expect(PICKUP_STATUSES).toContain("COLLECTED");
      expect(PICKUP_STATUSES).toContain("COMPLETED");
      expect(PICKUP_STATUSES).toContain("CANCELLED");
    });
  });

  describe("domain: toPickupStatus", () => {
    it("parses every valid status", () => {
      for (const s of PICKUP_STATUSES) {
        expect(toPickupStatus(s)).toBe(s);
      }
    });

    it("throws for an unknown status", () => {
      expect(() => toPickupStatus("INVALID")).toThrow(/unknown pickup status/iu);
      expect(() => toPickupStatus("")).toThrow();
      expect(() => toPickupStatus("requested")).toThrow();
    });
  });

  describe("domain: formatPickupCode", () => {
    it("formats correctly for a given date and ordinal", () => {
      const date = new Date("2026-07-26T15:00:00Z");
      expect(formatPickupCode(date, 1)).toBe("PR-20260726-001");
      expect(formatPickupCode(date, 42)).toBe("PR-20260726-042");
      expect(formatPickupCode(date, 999)).toBe("PR-20260726-999");
    });

    it("pads ordinal with leading zeros", () => {
      const date = new Date("2026-01-01T00:00:00Z");
      expect(formatPickupCode(date, 1)).toBe("PR-20260101-001");
      expect(formatPickupCode(date, 10)).toBe("PR-20260101-010");
      expect(formatPickupCode(date, 100)).toBe("PR-20260101-100");
    });

    it("handles ordinals beyond 999", () => {
      const date = new Date("2026-07-01T00:00:00Z");
      expect(formatPickupCode(date, 1234)).toBe("PR-20260701-1234");
    });

    it("rejects zero and negative ordinals", () => {
      const date = new Date();
      expect(() => formatPickupCode(date, 0)).toThrow();
      expect(() => formatPickupCode(date, -1)).toThrow();
    });

    it("rejects non-integer ordinals", () => {
      const date = new Date();
      expect(() => formatPickupCode(date, 1.5)).toThrow();
    });
  });

  // ── Shipment selection ─────────────────────────────────────────────────────

  describe("shipment selection: EXPLICIT", () => {
    it("links the named shipments and derives estimatedParcelCount", async () => {
      const tenantId = await seedTenant("pk-sel-exp");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 3);

      const pickup = await asTenant(tenantId, () =>
        pickups.request(
          createInput(merchantId, addressId, { shipmentIds: seeded.map((s) => s.id) }),
          ctx,
        ),
      );

      expect(pickup.selectionMode).toBe("EXPLICIT");
      expect(pickup.estimatedParcelCount).toBe(3);

      const rows = await scanRows(tenantId, pickup.id);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.scan_status === "EXPECTED")).toBe(true);
      expect(rows.every((r) => r.scanned_at === null)).toBe(true);
      expect(new Set(rows.map((r) => r.tracking_number))).toEqual(
        new Set(seeded.map((s) => s.trackingNumber)),
      );
    });

    it("selects a strict subset when the merchant names only some shipments", async () => {
      const tenantId = await seedTenant("pk-sel-subset");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 4);

      const chosen = seeded.slice(0, 2);
      const pickup = await asTenant(tenantId, () =>
        pickups.request(
          createInput(merchantId, addressId, { shipmentIds: chosen.map((s) => s.id) }),
          ctx,
        ),
      );

      expect(pickup.estimatedParcelCount).toBe(2);
      const rows = await scanRows(tenantId, pickup.id);
      expect(new Set(rows.map((r) => r.shipment_id))).toEqual(new Set(chosen.map((s) => s.id)));
    });

    it("rejects a shipment id that does not exist", async () => {
      const tenantId = await seedTenant("pk-sel-missing");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { shipmentIds: [randomUUID()] }), ctx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects a shipment that is not CREATED", async () => {
      const tenantId = await seedTenant("pk-sel-noteligible");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const shipped = await seedShipment(tenantId, merchantId, addressId, "PICKED_UP");

      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { shipmentIds: [shipped.id] }), ctx),
        ),
      ).rejects.toMatchObject({ code: "SHIPMENT_NOT_ELIGIBLE" });
    });

    it("rejects a shipment already linked to an active pickup", async () => {
      const tenantId = await seedTenant("pk-sel-dupe");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipment(tenantId, merchantId, addressId);

      await requestPickup(tenantId, merchantId, addressId, { shipmentIds: [seeded.id] });

      await expect(
        requestPickup(tenantId, merchantId, addressId, { shipmentIds: [seeded.id] }),
      ).rejects.toMatchObject({ code: "SHIPMENT_ALREADY_IN_PICKUP" });
    });

    it("allows re-linking a shipment once the earlier pickup is CANCELLED", async () => {
      const tenantId = await seedTenant("pk-sel-relink");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipment(tenantId, merchantId, addressId);

      const first = await requestPickup(tenantId, merchantId, addressId, {
        shipmentIds: [seeded.id],
      });
      await asTenant(tenantId, () =>
        pickups.cancel(first.id, { idempotencyKey: randomUUID(), reason: "Driver no-show" }, ctx),
      );

      const second = await requestPickup(tenantId, merchantId, addressId, {
        shipmentIds: [seeded.id],
      });
      expect(second.id).not.toBe(first.id);
    });

    it("publishes the selected shipmentIds and mode on pickup.requested", async () => {
      const tenantId = await seedTenant("pk-sel-event");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 2);

      const { id } = await requestPickup(tenantId, merchantId, addressId, {
        shipmentIds: seeded.map((s) => s.id),
      });

      const payload = await payloadFor(tenantId, "pickup.requested", id);
      expect(payload).toBeDefined();
      expect(payload?.["selectionMode"]).toBe("EXPLICIT");
      expect(payload?.["estimatedParcelCount"]).toBe(2);
      expect(new Set(payload?.["shipmentIds"] as string[])).toEqual(
        new Set(seeded.map((s) => s.id)),
      );
    });
  });

  describe("shipment selection: MERCHANT_READY", () => {
    it("auto-selects every CREATED shipment for the merchant", async () => {
      const tenantId = await seedTenant("pk-sel-ready");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 4);

      const pickup = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );

      expect(pickup.selectionMode).toBe("MERCHANT_READY");
      expect(pickup.estimatedParcelCount).toBe(4);
      const rows = await scanRows(tenantId, pickup.id);
      expect(new Set(rows.map((r) => r.shipment_id))).toEqual(new Set(seeded.map((s) => s.id)));
    });

    it("ignores shipments that have moved past CREATED", async () => {
      const tenantId = await seedTenant("pk-sel-ready-filter");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await seedShipments(tenantId, merchantId, addressId, 2);
      await seedShipment(tenantId, merchantId, addressId, "DELIVERED");
      await seedShipment(tenantId, merchantId, addressId, "CANCELLED");

      const pickup = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );

      expect(pickup.estimatedParcelCount).toBe(2);
      const rows = await scanRows(tenantId, pickup.id);
      expect(new Set(rows.map((r) => r.shipment_id))).toEqual(new Set(ready.map((s) => s.id)));
    });

    it("ignores another merchant's shipments", async () => {
      const tenantId = await seedTenant("pk-sel-ready-other");
      const mine = await seedMerchant(tenantId);
      const theirs = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      await seedShipments(tenantId, mine, addressId, 2);
      await seedShipments(tenantId, theirs, addressId, 3);

      const pickup = await asTenant(tenantId, () =>
        pickups.request(createInput(mine, addressId), ctx),
      );
      expect(pickup.estimatedParcelCount).toBe(2);
    });

    it("accepts a request when nothing is ready (estimatedParcelCount = 0)", async () => {
      const tenantId = await seedTenant("pk-sel-ready-none");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const pickup = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );

      expect(pickup.selectionMode).toBe("MERCHANT_READY");
      expect(pickup.estimatedParcelCount).toBe(0);
      expect(await scanRows(tenantId, pickup.id)).toHaveLength(0);
    });

    it("skips shipments already committed to a live pickup", async () => {
      const tenantId = await seedTenant("pk-sel-ready-dupe");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      await seedShipments(tenantId, merchantId, addressId, 2);

      const first = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );
      expect(first.estimatedParcelCount).toBe(2);

      // Nothing new packed since — a second automatic request is empty, not an error.
      const second = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );
      expect(second.estimatedParcelCount).toBe(0);
    });

    it("picks up only what the merchant packed after the previous request", async () => {
      const tenantId = await seedTenant("pk-sel-ready-incr");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      await seedShipments(tenantId, merchantId, addressId, 2);

      await requestPickup(tenantId, merchantId, addressId);
      const later = await seedShipments(tenantId, merchantId, addressId, 3);

      const second = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );
      expect(second.estimatedParcelCount).toBe(3);
      const rows = await scanRows(tenantId, second.id);
      expect(new Set(rows.map((r) => r.shipment_id))).toEqual(new Set(later.map((s) => s.id)));
    });

    it("re-selects a shipment once its earlier pickup closed", async () => {
      const tenantId = await seedTenant("pk-sel-ready-reopen");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      await seedShipments(tenantId, merchantId, addressId, 2);

      const first = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () =>
        pickups.cancel(first.id, { idempotencyKey: randomUUID(), reason: "Driver no-show" }, ctx),
      );

      const second = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );
      expect(second.estimatedParcelCount).toBe(2);
    });
  });

  // ── Integration tests — request (creation) ─────────────────────────────────

  describe("request", () => {
    it("creates a pickup request in REQUESTED status with a generated code", async () => {
      const tenantId = await seedTenant("pk-create");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 5);

      const pickup = await asTenant(tenantId, () =>
        pickups.request(
          createInput(merchantId, addressId, { shipmentIds: seeded.map((s) => s.id) }),
          ctx,
        ),
      );

      expect(pickup.status).toBe("REQUESTED");
      expect(pickup.code).toMatch(/^PR-\d{8}-\d{3,}$/u);
      expect(pickup.merchantId).toBe(merchantId);
      expect(pickup.pickupAddressId).toBe(addressId);
      expect(pickup.contactName).toBe("Farah Ben Salah");
      expect(pickup.contactPhone).toBe("+21620123456");
      expect(pickup.estimatedParcelCount).toBe(5);
      expect(pickup.actualParcelCount).toBeNull();
      expect(pickup.outcomeReason).toBeNull();
      expect(pickup.requestedByUserId).toBe(actorId);
      expect(pickup.acceptedAt).toBeNull();
      expect(pickup.assignedDriverId).toBeNull();
      expect(pickup.collectedAt).toBeNull();
      expect(pickup.completedAt).toBeNull();
      expect(pickup.cancelledAt).toBeNull();
    });

    it("increments the code ordinal for the same day", async () => {
      const tenantId = await seedTenant("pk-ordinal");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const first = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );
      const second = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );

      const firstOrdinal = Number.parseInt(first.code.split("-")[2] ?? "", 10);
      const secondOrdinal = Number.parseInt(second.code.split("-")[2] ?? "", 10);
      expect(secondOrdinal).toBeGreaterThan(firstOrdinal);
    });

    it("publishes pickup.requested event to outbox", async () => {
      const tenantId = await seedTenant("pk-event");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await requestPickup(tenantId, merchantId, addressId);

      const events = await outboxEventTypes(tenantId);
      expect(events).toContain("pickup.requested");
    });

    it("includes all required fields in the pickup.requested event payload", async () => {
      const tenantId = await seedTenant("pk-ev-payload");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      await seedShipments(tenantId, merchantId, addressId, 5);

      const { id } = await requestPickup(tenantId, merchantId, addressId);

      const payload = await payloadFor(tenantId, "pickup.requested", id);
      expect(payload).toBeDefined();
      expect(payload?.["code"]).toMatch(/^PR-/u);
      expect(payload?.["merchantId"]).toBe(merchantId);
      expect(payload?.["pickupAddressId"]).toBe(addressId);
      expect(payload?.["estimatedParcelCount"]).toBe(5);
      expect(payload?.["requestedWindowFrom"]).toBeDefined();
      expect(payload?.["requestedWindowTo"]).toBeDefined();
    });

    it("stores notes when provided", async () => {
      const tenantId = await seedTenant("pk-notes");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const pickup = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId, { notes: "Ring doorbell twice" }), ctx),
      );
      expect(pickup.notes).toBe("Ring doorbell twice");
    });

    it("defaults notes to null", async () => {
      const tenantId = await seedTenant("pk-no-notes");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const pickup = await asTenant(tenantId, () =>
        pickups.request(createInput(merchantId, addressId), ctx),
      );
      expect(pickup.notes).toBeNull();
    });
  });

  // ── Merchant validation ───────────────────────────────────────────────────

  describe("merchant validation", () => {
    it("rejects a request for a non-existent merchant", async () => {
      const tenantId = await seedTenant("pk-no-merchant");
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () => pickups.request(createInput(randomUUID(), addressId), ctx)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects a request for a SUSPENDED merchant", async () => {
      const tenantId = await seedTenant("pk-suspended");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await suspendMerchant(tenantId, merchantId);

      await expect(
        asTenant(tenantId, () => pickups.request(createInput(merchantId, addressId), ctx)),
      ).rejects.toMatchObject({ code: "MERCHANT_SUSPENDED" });
    });
  });

  // ── Window validation ──────────────────────────────────────────────────────

  describe("window validation", () => {
    it("rejects window where to <= from", async () => {
      const tenantId = await seedTenant("pk-window-eq");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const now = new Date();

      await expect(
        asTenant(tenantId, () =>
          pickups.request(
            createInput(merchantId, addressId, {
              requestedWindowFrom: now.toISOString(),
              requestedWindowTo: now.toISOString(),
            }),
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "PICKUP_WINDOW_INVALID" });
    });

    it("rejects window where to < from", async () => {
      const tenantId = await seedTenant("pk-window-rev");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const now = new Date();
      const past = new Date(now.getTime() - 3600_000);

      await expect(
        asTenant(tenantId, () =>
          pickups.request(
            createInput(merchantId, addressId, {
              requestedWindowFrom: now.toISOString(),
              requestedWindowTo: past.toISOString(),
            }),
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "PICKUP_WINDOW_INVALID" });
    });
  });

  // ── Single barcode scan ────────────────────────────────────────────────────

  describe("scan: single", () => {
    it("marks an expected parcel SCANNED and returns the running summary", async () => {
      const tenantId = await seedTenant("pk-scan-ok");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);
      const first = ready.shipments[0];
      expect(first).toBeDefined();

      const result = await scanOne(tenantId, ready.id, ready.driverId, first?.trackingNumber ?? "");

      expect(result.shipmentId).toBe(first?.id);
      expect(result.scanStatus).toBe("SCANNED");
      expect(result.summary).toEqual({ total: 3, scanned: 1, missing: 0 });

      const rows = await scanRows(tenantId, ready.id);
      const scanned = rows.filter((r) => r.scan_status === "SCANNED");
      expect(scanned).toHaveLength(1);
      expect(scanned[0]?.scanned_by_driver_id).toBe(ready.driverId);
    });

    it("stores the device scan time and the server receipt time separately", async () => {
      const tenantId = await seedTenant("pk-scan-times");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);
      const parcel = ready.shipments[0];

      // Two hours of no signal before the scan reached us.
      const deviceTime = new Date(Date.now() - 2 * 3600_000);
      await scanOne(tenantId, ready.id, ready.driverId, parcel?.trackingNumber ?? "", {
        scannedAt: deviceTime.toISOString(),
      });

      const rows = await scanRows(tenantId, ready.id);
      const row = rows[0];
      expect(row?.scanned_at?.getTime()).toBe(deviceTime.getTime());
      expect(row?.recorded_at).not.toBeNull();
      expect(row?.recorded_at?.getTime()).toBeGreaterThan(deviceTime.getTime());
    });

    it("defaults scannedAt to now when the driver is online", async () => {
      const tenantId = await seedTenant("pk-scan-now");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      const before = Date.now();
      await scanOne(tenantId, ready.id, ready.driverId, ready.shipments[0]?.trackingNumber ?? "");

      const rows = await scanRows(tenantId, ready.id);
      expect(rows[0]?.scanned_at?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it("publishes pickup.parcel_scanned with a self-contained payload", async () => {
      const tenantId = await seedTenant("pk-scan-event");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);
      const parcel = ready.shipments[0];

      await scanOne(tenantId, ready.id, ready.driverId, parcel?.trackingNumber ?? "");

      const payload = await payloadFor(tenantId, "pickup.parcel_scanned", ready.id);
      expect(payload).toBeDefined();
      expect(payload?.["shipmentId"]).toBe(parcel?.id);
      expect(payload?.["trackingNumber"]).toBe(parcel?.trackingNumber);
      expect(payload?.["driverId"]).toBe(ready.driverId);
      expect(payload?.["scannedAt"]).toEqual(expect.any(String));
    });

    it("rejects a barcode that is not in this pickup", async () => {
      const tenantId = await seedTenant("pk-scan-unknown");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(
        scanOne(tenantId, ready.id, ready.driverId, "SD-TEST-NOTHERE"),
      ).rejects.toMatchObject({ code: "BARCODE_NOT_IN_PICKUP" });
    });

    it("rejects a barcode belonging to a different pickup", async () => {
      const tenantId = await seedTenant("pk-scan-crossed");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const mine = await readyPickup(tenantId, merchantId, addressId, 1);
      const other = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(
        scanOne(tenantId, mine.id, mine.driverId, other.shipments[0]?.trackingNumber ?? ""),
      ).rejects.toMatchObject({ code: "BARCODE_NOT_IN_PICKUP" });
    });

    it("is idempotent when the same driver re-scans the same parcel", async () => {
      const tenantId = await seedTenant("pk-scan-replay");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 2);
      const tracking = ready.shipments[0]?.trackingNumber ?? "";

      const first = await scanOne(tenantId, ready.id, ready.driverId, tracking);
      const second = await scanOne(tenantId, ready.id, ready.driverId, tracking);

      expect(second.scanStatus).toBe("SCANNED");
      expect(second.scannedAt.getTime()).toBe(first.scannedAt.getTime());
      expect(second.summary).toEqual({ total: 2, scanned: 1, missing: 0 });

      // One physical scan is exactly one custody event, however many replays land.
      const events = await outboxPayloads(tenantId, "pickup.parcel_scanned");
      expect(events).toHaveLength(1);
    });

    it("rejects a parcel already scanned by a different driver", async () => {
      const tenantId = await seedTenant("pk-scan-conflict");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);
      const tracking = ready.shipments[0]?.trackingNumber ?? "";

      await scanOne(tenantId, ready.id, ready.driverId, tracking);

      await expect(scanOne(tenantId, ready.id, randomUUID(), tracking)).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it("rejects scanning before the pickup is ASSIGNED", async () => {
      const tenantId = await seedTenant("pk-scan-early");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 1);
      const { id } = await requestPickup(tenantId, merchantId, addressId, {
        shipmentIds: seeded.map((s) => s.id),
      });

      await expect(
        scanOne(tenantId, id, randomUUID(), seeded[0]?.trackingNumber ?? ""),
      ).rejects.toMatchObject({ code: "PICKUP_NOT_ASSIGNED" });
    });

    it("rejects scanning after the pickup is COLLECTED", async () => {
      const tenantId = await seedTenant("pk-scan-late");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 2);
      const first = ready.shipments[0]?.trackingNumber ?? "";
      const second = ready.shipments[1]?.trackingNumber ?? "";

      await scanOne(tenantId, ready.id, ready.driverId, first);
      await asTenant(tenantId, () =>
        pickups.collect(ready.id, { idempotencyKey: randomUUID() }, ctx),
      );

      await expect(scanOne(tenantId, ready.id, ready.driverId, second)).rejects.toMatchObject({
        code: "PICKUP_NOT_ASSIGNED",
      });
    });

    it("throws NotFoundError for a non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-scan-nf");
      await expect(
        scanOne(tenantId, randomUUID(), randomUUID(), "SD-TEST-ANY"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects an empty tracking number", async () => {
      const tenantId = await seedTenant("pk-scan-empty");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(scanOne(tenantId, ready.id, ready.driverId, "")).rejects.toThrow();
    });

    it("rejects unknown fields on the scan payload (strict mode)", async () => {
      const tenantId = await seedTenant("pk-scan-strict");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(
        scanOne(tenantId, ready.id, ready.driverId, ready.shipments[0]?.trackingNumber ?? "", {
          gpsAccuracy: 5,
        }),
      ).rejects.toThrow();
    });
  });

  // ── Offline batch scan sync ────────────────────────────────────────────────

  describe("scan: offline batch sync", () => {
    async function syncBatch(
      tenantId: string,
      pickupId: string,
      driverId: string,
      scans: Record<string, unknown>[],
    ): ReturnType<PickupService["scanBatch"]> {
      return asTenant(tenantId, () =>
        pickups.scanBatch(pickupId, { scans }, { actorId: driverId }),
      );
    }

    function queued(trackingNumber: string, minutesAgo: number): Record<string, unknown> {
      return {
        idempotencyKey: randomUUID(),
        trackingNumber,
        scannedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      };
    }

    it("accepts every queued scan and reports one summary", async () => {
      const tenantId = await seedTenant("pk-batch-ok");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      const result = await syncBatch(
        tenantId,
        ready.id,
        ready.driverId,
        ready.shipments.map((s, i) => queued(s.trackingNumber, 30 - i)),
      );

      expect(result.total).toBe(3);
      expect(result.accepted).toBe(3);
      expect(result.rejected).toBe(0);
      expect(result.summary).toEqual({ total: 3, scanned: 3, missing: 0 });
      expect(result.results.every((r) => r.status === "ACCEPTED")).toBe(true);
      expect(result.results.every((r) => r.action === null)).toBe(true);
      expect(result.results.map((r) => r.index)).toEqual([0, 1, 2]);
    });

    it("preserves each queued device time rather than the sync time", async () => {
      const tenantId = await seedTenant("pk-batch-times");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 2);

      const older = new Date(Date.now() - 90 * 60_000);
      const newer = new Date(Date.now() - 30 * 60_000);
      await syncBatch(tenantId, ready.id, ready.driverId, [
        {
          idempotencyKey: randomUUID(),
          trackingNumber: ready.shipments[0]?.trackingNumber ?? "",
          scannedAt: older.toISOString(),
        },
        {
          idempotencyKey: randomUUID(),
          trackingNumber: ready.shipments[1]?.trackingNumber ?? "",
          scannedAt: newer.toISOString(),
        },
      ]);

      const rows = await scanRows(tenantId, ready.id);
      const byTracking = new Map(rows.map((r) => [r.tracking_number, r]));
      expect(byTracking.get(ready.shipments[0]?.trackingNumber ?? "")?.scanned_at?.getTime()).toBe(
        older.getTime(),
      );
      expect(byTracking.get(ready.shipments[1]?.trackingNumber ?? "")?.scanned_at?.getTime()).toBe(
        newer.getTime(),
      );
    });

    it("rejects only the unknown barcode and keeps the rest — never all-or-nothing", async () => {
      const tenantId = await seedTenant("pk-batch-partial");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 2);

      const result = await syncBatch(tenantId, ready.id, ready.driverId, [
        queued(ready.shipments[0]?.trackingNumber ?? "", 20),
        queued("SD-TEST-GHOST", 19),
        queued(ready.shipments[1]?.trackingNumber ?? "", 18),
      ]);

      expect(result.accepted).toBe(2);
      expect(result.rejected).toBe(1);
      expect(result.summary).toEqual({ total: 2, scanned: 2, missing: 0 });

      const bad = result.results[1];
      expect(bad?.status).toBe("REJECTED");
      expect(bad?.action).toBe("ESCALATE_TO_DISPATCHER");
      expect(bad?.trackingNumber).toBe("SD-TEST-GHOST");
      expect(bad?.shipmentId).toBeNull();
      expect(bad?.reason).toEqual(expect.any(String));
    });

    it("flags a parcel taken by another driver as CONFLICT / DISCARD_AND_REFRESH", async () => {
      const tenantId = await seedTenant("pk-batch-conflict");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 2);
      const contested = ready.shipments[0]?.trackingNumber ?? "";

      // Another driver got there first while this device was offline.
      await scanOne(tenantId, ready.id, randomUUID(), contested);

      const result = await syncBatch(tenantId, ready.id, ready.driverId, [
        queued(contested, 45),
        queued(ready.shipments[1]?.trackingNumber ?? "", 44),
      ]);

      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(1);
      expect(result.results[0]?.status).toBe("CONFLICT");
      expect(result.results[0]?.action).toBe("DISCARD_AND_REFRESH");
      expect(result.results[1]?.status).toBe("ACCEPTED");
    });

    it("treats a duplicate inside one batch as an idempotent accept", async () => {
      const tenantId = await seedTenant("pk-batch-dupe");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);
      const tracking = ready.shipments[0]?.trackingNumber ?? "";

      const result = await syncBatch(tenantId, ready.id, ready.driverId, [
        queued(tracking, 10),
        queued(tracking, 9),
      ]);

      expect(result.accepted).toBe(2);
      expect(result.rejected).toBe(0);
      expect(result.summary).toEqual({ total: 1, scanned: 1, missing: 0 });
      expect(await outboxPayloads(tenantId, "pickup.parcel_scanned")).toHaveLength(1);
    });

    it("is a clean no-op when the device replays the whole batch", async () => {
      const tenantId = await seedTenant("pk-batch-replay");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      const batch = ready.shipments.map((s, i) => queued(s.trackingNumber, 60 - i));
      const first = await syncBatch(tenantId, ready.id, ready.driverId, batch);
      const replay = await syncBatch(tenantId, ready.id, ready.driverId, batch);

      expect(first.accepted).toBe(3);
      expect(replay.accepted).toBe(3);
      expect(replay.summary).toEqual({ total: 3, scanned: 3, missing: 0 });
      expect(await outboxPayloads(tenantId, "pickup.parcel_scanned")).toHaveLength(3);
    });

    it("syncs a partially-scanned pickup left by an online scan", async () => {
      const tenantId = await seedTenant("pk-batch-mixed-source");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      await scanOne(tenantId, ready.id, ready.driverId, ready.shipments[0]?.trackingNumber ?? "");
      const result = await syncBatch(tenantId, ready.id, ready.driverId, [
        queued(ready.shipments[1]?.trackingNumber ?? "", 5),
        queued(ready.shipments[2]?.trackingNumber ?? "", 4),
      ]);

      expect(result.accepted).toBe(2);
      expect(result.summary).toEqual({ total: 3, scanned: 3, missing: 0 });
    });

    it("rejects scanning a batch before the pickup is ASSIGNED", async () => {
      const tenantId = await seedTenant("pk-batch-early");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 1);
      const { id } = await requestPickup(tenantId, merchantId, addressId, {
        shipmentIds: seeded.map((s) => s.id),
      });

      await expect(
        syncBatch(tenantId, id, randomUUID(), [queued(seeded[0]?.trackingNumber ?? "", 5)]),
      ).rejects.toMatchObject({ code: "PICKUP_NOT_ASSIGNED" });
    });

    it("rejects an empty batch", async () => {
      const tenantId = await seedTenant("pk-batch-empty");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(syncBatch(tenantId, ready.id, ready.driverId, [])).rejects.toThrow();
    });

    it("rejects a batch larger than 200 scans", async () => {
      const tenantId = await seedTenant("pk-batch-max");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      const oversized = Array.from({ length: 201 }, () => queued("SD-TEST-X", 1));
      await expect(syncBatch(tenantId, ready.id, ready.driverId, oversized)).rejects.toThrow();
    });

    it("rejects a queued scan with no device timestamp", async () => {
      const tenantId = await seedTenant("pk-batch-notime");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(
        syncBatch(tenantId, ready.id, ready.driverId, [
          {
            idempotencyKey: randomUUID(),
            trackingNumber: ready.shipments[0]?.trackingNumber ?? "",
          },
        ]),
      ).rejects.toThrow();
    });

    it("rejects a queued scan with no idempotency key", async () => {
      const tenantId = await seedTenant("pk-batch-nokey");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(
        syncBatch(tenantId, ready.id, ready.driverId, [
          {
            trackingNumber: ready.shipments[0]?.trackingNumber ?? "",
            scannedAt: new Date().toISOString(),
          },
        ]),
      ).rejects.toThrow();
    });

    it("throws NotFoundError for a non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-batch-nf");
      await expect(
        syncBatch(tenantId, randomUUID(), randomUUID(), [queued("SD-TEST-ANY", 1)]),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Manifest read ──────────────────────────────────────────────────────────

  describe("getManifest", () => {
    it("returns every expected parcel with its scan state and matching summary", async () => {
      const tenantId = await seedTenant("pk-manifest");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      await scanOne(tenantId, ready.id, ready.driverId, ready.shipments[0]?.trackingNumber ?? "");

      const manifest = await asTenant(tenantId, () => pickups.getManifest(ready.id));
      expect(manifest.shipments).toHaveLength(3);
      expect(manifest.summary).toEqual({ total: 3, scanned: 1, missing: 0 });

      const scanned = manifest.shipments.filter((s) => s.scanStatus === "SCANNED");
      expect(scanned).toHaveLength(1);
      expect(scanned[0]?.scannedByDriverId).toBe(ready.driverId);
      expect(scanned[0]?.scannedAt).not.toBeNull();
      expect(scanned[0]?.recordedAt).not.toBeNull();

      const expected = manifest.shipments.filter((s) => s.scanStatus === "EXPECTED");
      expect(expected).toHaveLength(2);
      expect(expected.every((s) => s.scannedAt === null)).toBe(true);
    });

    it("returns an all-zero summary for a pickup with nothing linked", async () => {
      const tenantId = await seedTenant("pk-manifest-empty");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const { id } = await requestPickup(tenantId, merchantId, addressId);

      const manifest = await asTenant(tenantId, () => pickups.getManifest(id));
      expect(manifest.shipments).toHaveLength(0);
      expect(manifest.summary).toEqual({ total: 0, scanned: 0, missing: 0 });
    });

    it("throws NotFoundError for a non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-manifest-nf");
      await expect(
        asTenant(tenantId, () => pickups.getManifest(randomUUID())),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("is tenant-scoped", async () => {
      const tenantA = await seedTenant("pk-manifest-iso-a");
      const tenantB = await seedTenant("pk-manifest-iso-b");
      const merchantId = await seedMerchant(tenantA);
      const addressId = await seedAddress(tenantA);
      const ready = await readyPickup(tenantA, merchantId, addressId, 2);

      await expect(asTenant(tenantB, () => pickups.getManifest(ready.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // ── Full lifecycle: happy path ─────────────────────────────────────────────

  describe("lifecycle: happy path", () => {
    it("REQUESTED → ACCEPTED → ASSIGNED → scan → COLLECTED → COMPLETED", async () => {
      const tenantId = await seedTenant("pk-lifecycle");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 3);

      const { id } = await requestPickup(tenantId, merchantId, addressId, {
        shipmentIds: seeded.map((s) => s.id),
      });

      const accepted = await asTenant(tenantId, () =>
        pickups.accept(id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(accepted.status).toBe("ACCEPTED");
      expect(accepted.acceptedAt).not.toBeNull();
      expect(accepted.acceptedByUserId).toBe(actorId);

      const driverId = randomUUID();
      const routeStopId = randomUUID();
      const assigned = await asTenant(tenantId, () =>
        pickups.assign(id, { idempotencyKey: randomUUID(), driverId, routeStopId }, ctx),
      );
      expect(assigned.status).toBe("ASSIGNED");
      expect(assigned.assignedDriverId).toBe(driverId);
      expect(assigned.assignedRouteStopId).toBe(routeStopId);
      expect(assigned.assignedAt).not.toBeNull();

      for (const s of seeded) {
        await scanOne(tenantId, id, driverId, s.trackingNumber);
      }

      const collected = await asTenant(tenantId, () =>
        pickups.collect(id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(collected.status).toBe("COLLECTED");
      expect(collected.actualParcelCount).toBe(3);
      expect(collected.outcomeReason).toBeNull();
      expect(collected.collectedAt).not.toBeNull();

      const completed = await asTenant(tenantId, () =>
        pickups.complete(id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(completed.status).toBe("COMPLETED");
      expect(completed.completedAt).not.toBeNull();

      const events = await outboxEventTypes(tenantId);
      expect(events).toContain("pickup.requested");
      expect(events).toContain("pickup.accepted");
      expect(events).toContain("pickup.assigned");
      expect(events).toContain("pickup.parcel_scanned");
      expect(events).toContain("pickup.collected");
      expect(events).toContain("pickup.completed");
    });

    it("runs the MERCHANT_READY lifecycle end to end through a batch sync", async () => {
      const tenantId = await seedTenant("pk-lifecycle-auto");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 4);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      const driverId = randomUUID();
      await asTenant(tenantId, () =>
        pickups.assign(id, { idempotencyKey: randomUUID(), driverId }, ctx),
      );

      const sync = await asTenant(tenantId, () =>
        pickups.scanBatch(
          id,
          {
            scans: seeded.map((s, i) => ({
              idempotencyKey: randomUUID(),
              trackingNumber: s.trackingNumber,
              scannedAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
            })),
          },
          { actorId: driverId },
        ),
      );
      expect(sync.accepted).toBe(4);

      const collected = await asTenant(tenantId, () =>
        pickups.collect(id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(collected.actualParcelCount).toBe(4);

      const completed = await asTenant(tenantId, () =>
        pickups.complete(id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(completed.status).toBe("COMPLETED");
    });

    it("assigns without routeStopId (standalone pickup, not part of a route)", async () => {
      const tenantId = await seedTenant("pk-no-stop");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      const driverId = randomUUID();
      const assigned = await asTenant(tenantId, () =>
        pickups.assign(id, { idempotencyKey: randomUUID(), driverId }, ctx),
      );
      expect(assigned.assignedDriverId).toBe(driverId);
      expect(assigned.assignedRouteStopId).toBeNull();
    });
  });

  // ── State-transition enforcement ──────────────────────────────────────────

  describe("state transitions: invalid", () => {
    it("cannot skip ACCEPTED (REQUESTED → ASSIGNED)", async () => {
      const tenantId = await seedTenant("pk-skip-accept");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await expect(
        asTenant(tenantId, () =>
          pickups.assign(id, { idempotencyKey: randomUUID(), driverId: randomUUID() }, ctx),
        ),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });
    });

    it("cannot skip ASSIGNED (ACCEPTED → COLLECTED)", async () => {
      const tenantId = await seedTenant("pk-skip-assign");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      await expect(
        asTenant(tenantId, () =>
          pickups.collect(
            id,
            { idempotencyKey: randomUUID(), outcomeReason: "MERCHANT_NOT_READY" },
            ctx,
          ),
        ),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });
    });

    it("cannot skip COLLECTED (ASSIGNED → COMPLETED)", async () => {
      const tenantId = await seedTenant("pk-skip-collect");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      await asTenant(tenantId, () =>
        pickups.assign(id, { idempotencyKey: randomUUID(), driverId: randomUUID() }, ctx),
      );
      await expect(
        asTenant(tenantId, () => pickups.complete(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });
    });

    it("cannot accept twice", async () => {
      const tenantId = await seedTenant("pk-backward");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      await expect(
        asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });
    });

    it("cannot transition from COMPLETED", async () => {
      const tenantId = await seedTenant("pk-from-completed");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const id = await fullLifecycle(tenantId, merchantId, addressId);

      await expect(
        asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });

      await expect(
        asTenant(tenantId, () =>
          pickups.cancel(id, { idempotencyKey: randomUUID(), reason: "Too late" }, ctx),
        ),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });
    });

    it("cannot transition from CANCELLED", async () => {
      const tenantId = await seedTenant("pk-from-cancelled");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () =>
        pickups.cancel(id, { idempotencyKey: randomUUID(), reason: "Changed mind" }, ctx),
      );

      await expect(
        asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────────

  describe("cancellation", () => {
    it("cancels from REQUESTED", async () => {
      const tenantId = await seedTenant("pk-cancel-req");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      const cancelled = await asTenant(tenantId, () =>
        pickups.cancel(id, { idempotencyKey: randomUUID(), reason: "No longer needed" }, ctx),
      );
      expect(cancelled.status).toBe("CANCELLED");
      expect(cancelled.cancellationReason).toBe("No longer needed");
      expect(cancelled.cancelledAt).not.toBeNull();
    });

    it("cancels from ACCEPTED", async () => {
      const tenantId = await seedTenant("pk-cancel-acc");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      const cancelled = await asTenant(tenantId, () =>
        pickups.cancel(id, { idempotencyKey: randomUUID(), reason: "Merchant closed" }, ctx),
      );
      expect(cancelled.status).toBe("CANCELLED");
    });

    it("cancels from ASSIGNED", async () => {
      const tenantId = await seedTenant("pk-cancel-asg");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const ready = await readyPickup(tenantId, merchantId, addressId, 1);
      const cancelled = await asTenant(tenantId, () =>
        pickups.cancel(
          ready.id,
          { idempotencyKey: randomUUID(), reason: "Driver unavailable" },
          ctx,
        ),
      );
      expect(cancelled.status).toBe("CANCELLED");
    });

    it("cannot cancel after COLLECTED (invariant I21)", async () => {
      const tenantId = await seedTenant("pk-cancel-col");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const ready = await readyPickup(tenantId, merchantId, addressId, 1);
      await scanOne(tenantId, ready.id, ready.driverId, ready.shipments[0]?.trackingNumber ?? "");
      await asTenant(tenantId, () =>
        pickups.collect(ready.id, { idempotencyKey: randomUUID() }, ctx),
      );
      await expect(
        asTenant(tenantId, () =>
          pickups.cancel(ready.id, { idempotencyKey: randomUUID(), reason: "Too late" }, ctx),
        ),
      ).rejects.toMatchObject({ code: "PICKUP_INVALID_TRANSITION" });
    });

    it("publishes pickup.cancelled event with reason", async () => {
      const tenantId = await seedTenant("pk-cancel-ev");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () =>
        pickups.cancel(id, { idempotencyKey: randomUUID(), reason: "Cancelled by merchant" }, ctx),
      );

      const payload = await payloadFor(tenantId, "pickup.cancelled", id);
      expect(payload).toBeDefined();
      expect(payload?.["reason"]).toBe("Cancelled by merchant");
      expect(payload?.["status"]).toBe("CANCELLED");
    });
  });

  // ── Collect: derived counts, missing parcels, variance ─────────────────────

  describe("collect: reconciliation", () => {
    it("derives actualParcelCount from scans and marks the rest MISSING", async () => {
      const tenantId = await seedTenant("pk-variance");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 5);

      for (const s of ready.shipments.slice(0, 3)) {
        await scanOne(tenantId, ready.id, ready.driverId, s.trackingNumber);
      }

      const collected = await asTenant(tenantId, () =>
        pickups.collect(ready.id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(collected.estimatedParcelCount).toBe(5);
      expect(collected.actualParcelCount).toBe(3);

      const rows = await scanRows(tenantId, ready.id);
      expect(rows.filter((r) => r.scan_status === "SCANNED")).toHaveLength(3);
      expect(rows.filter((r) => r.scan_status === "MISSING")).toHaveLength(2);
      expect(rows.some((r) => r.scan_status === "EXPECTED")).toBe(false);
    });

    it("emits scanned and missing shipment ids on pickup.collected", async () => {
      const tenantId = await seedTenant("pk-collect-ids");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      const taken = ready.shipments.slice(0, 2);
      const left = ready.shipments.slice(2);
      for (const s of taken) {
        await scanOne(tenantId, ready.id, ready.driverId, s.trackingNumber);
      }
      await asTenant(tenantId, () =>
        pickups.collect(ready.id, { idempotencyKey: randomUUID() }, ctx),
      );

      const payload = await payloadFor(tenantId, "pickup.collected", ready.id);
      expect(payload).toBeDefined();
      expect(payload?.["estimatedParcelCount"]).toBe(3);
      expect(payload?.["actualParcelCount"]).toBe(2);
      expect(payload?.["countVariance"]).toBe(1);
      expect(payload?.["driverId"]).toBe(ready.driverId);
      expect(new Set(payload?.["shipmentIds"] as string[])).toEqual(
        new Set(taken.map((s) => s.id)),
      );
      expect(new Set(payload?.["missingShipmentIds"] as string[])).toEqual(
        new Set(left.map((s) => s.id)),
      );
    });

    it("reports zero variance when every expected parcel was scanned", async () => {
      const tenantId = await seedTenant("pk-exact");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      for (const s of ready.shipments) {
        await scanOne(tenantId, ready.id, ready.driverId, s.trackingNumber);
      }
      await asTenant(tenantId, () =>
        pickups.collect(ready.id, { idempotencyKey: randomUUID() }, ctx),
      );

      const payload = await payloadFor(tenantId, "pickup.collected", ready.id);
      expect(payload?.["countVariance"]).toBe(0);
      expect(payload?.["missingShipmentIds"]).toEqual([]);
    });

    it("collect notes override the creation notes", async () => {
      const tenantId = await seedTenant("pk-collect-notes");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const seeded = await seedShipments(tenantId, merchantId, addressId, 1);
      const { id } = await requestPickup(tenantId, merchantId, addressId, {
        shipmentIds: seeded.map((s) => s.id),
        notes: "Original note",
      });
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      const driverId = randomUUID();
      await asTenant(tenantId, () =>
        pickups.assign(id, { idempotencyKey: randomUUID(), driverId }, ctx),
      );
      await scanOne(tenantId, id, driverId, seeded[0]?.trackingNumber ?? "");

      const collected = await asTenant(tenantId, () =>
        pickups.collect(id, { idempotencyKey: randomUUID(), notes: "Updated at collection" }, ctx),
      );
      expect(collected.notes).toBe("Updated at collection");
    });
  });

  // ── Zero-parcel pickup ─────────────────────────────────────────────────────

  describe("collect: zero-parcel pickup", () => {
    it("completes with actualParcelCount 0 when an outcome reason is given", async () => {
      const tenantId = await seedTenant("pk-zero-ok");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      const collected = await asTenant(tenantId, () =>
        pickups.collect(
          ready.id,
          { idempotencyKey: randomUUID(), outcomeReason: "MERCHANT_NOT_READY" },
          ctx,
        ),
      );
      expect(collected.status).toBe("COLLECTED");
      expect(collected.actualParcelCount).toBe(0);
      expect(collected.outcomeReason).toBe("MERCHANT_NOT_READY");

      // The trip still cost money — it completes, it is not cancelled (rule 5).
      const completed = await asTenant(tenantId, () =>
        pickups.complete(ready.id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(completed.status).toBe("COMPLETED");
    });

    it("refuses a zero-parcel collection with no explanation", async () => {
      const tenantId = await seedTenant("pk-zero-noreason");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 2);

      await expect(
        asTenant(tenantId, () => pickups.collect(ready.id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toMatchObject({ code: "OUTCOME_REASON_REQUIRED" });

      // The refusal must not have half-applied anything.
      const after = await asTenant(tenantId, () => pickups.getById(ready.id));
      expect(after.status).toBe("ASSIGNED");
      expect(after.actualParcelCount).toBeNull();
      const rows = await scanRows(tenantId, ready.id);
      expect(rows.every((r) => r.scan_status === "EXPECTED")).toBe(true);
    });

    it("completes a pickup where nothing was ever linked", async () => {
      const tenantId = await seedTenant("pk-zero-nolink");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 0);

      const collected = await asTenant(tenantId, () =>
        pickups.collect(
          ready.id,
          { idempotencyKey: randomUUID(), outcomeReason: "NO_PARCELS_AVAILABLE" },
          ctx,
        ),
      );
      expect(collected.estimatedParcelCount).toBe(0);
      expect(collected.actualParcelCount).toBe(0);
      expect(collected.outcomeReason).toBe("NO_PARCELS_AVAILABLE");
    });

    it("accepts every documented outcome reason", async () => {
      for (const [i, reason] of OUTCOME_REASONS.entries()) {
        const tenantId = await seedTenant(`pk-zero-reason-${i}`);
        const merchantId = await seedMerchant(tenantId);
        const addressId = await seedAddress(tenantId);
        const ready = await readyPickup(tenantId, merchantId, addressId, 1);

        const collected = await asTenant(tenantId, () =>
          pickups.collect(ready.id, { idempotencyKey: randomUUID(), outcomeReason: reason }, ctx),
        );
        expect(collected.outcomeReason).toBe(reason);
        expect(collected.actualParcelCount).toBe(0);
      }
    });

    it("rejects an outcome reason outside the enum", async () => {
      const tenantId = await seedTenant("pk-zero-badreason");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(
        asTenant(tenantId, () =>
          pickups.collect(
            ready.id,
            { idempotencyKey: randomUUID(), outcomeReason: "DRIVER_OVERSLEPT" },
            ctx,
          ),
        ),
      ).rejects.toThrow();
    });

    it("records an outcome reason alongside a partial collection", async () => {
      const tenantId = await seedTenant("pk-zero-partial");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 3);

      await scanOne(tenantId, ready.id, ready.driverId, ready.shipments[0]?.trackingNumber ?? "");
      const collected = await asTenant(tenantId, () =>
        pickups.collect(
          ready.id,
          { idempotencyKey: randomUUID(), outcomeReason: "MERCHANT_NOT_READY" },
          ctx,
        ),
      );

      expect(collected.actualParcelCount).toBe(1);
      expect(collected.outcomeReason).toBe("MERCHANT_NOT_READY");
      const payload = await payloadFor(tenantId, "pickup.collected", ready.id);
      expect(payload?.["outcomeReason"]).toBe("MERCHANT_NOT_READY");
      expect(payload?.["countVariance"]).toBe(2);
    });

    it("leaves outcomeReason null on a clean full collection", async () => {
      const tenantId = await seedTenant("pk-zero-clean");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 2);

      for (const s of ready.shipments) {
        await scanOne(tenantId, ready.id, ready.driverId, s.trackingNumber);
      }
      const collected = await asTenant(tenantId, () =>
        pickups.collect(ready.id, { idempotencyKey: randomUUID() }, ctx),
      );
      expect(collected.outcomeReason).toBeNull();

      const payload = await payloadFor(tenantId, "pickup.collected", ready.id);
      expect(payload?.["outcomeReason"]).toBeNull();
    });
  });

  // ── Outbox event payload assertions ────────────────────────────────────────

  describe("outbox event payloads", () => {
    it("pickup.accepted includes request and merchant identifiers", async () => {
      const tenantId = await seedTenant("pk-ev-acc");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));

      const payload = await payloadFor(tenantId, "pickup.accepted", id);
      expect(payload?.["merchantId"]).toBe(merchantId);
      expect(payload?.["status"]).toBe("ACCEPTED");
      expect(payload?.["actorId"]).toBe(actorId);
    });

    it("pickup.assigned includes driverId and routeStopId", async () => {
      const tenantId = await seedTenant("pk-ev-asg");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      const driverId = randomUUID();
      const routeStopId = randomUUID();
      await asTenant(tenantId, () =>
        pickups.assign(id, { idempotencyKey: randomUUID(), driverId, routeStopId }, ctx),
      );

      const payload = await payloadFor(tenantId, "pickup.assigned", id);
      expect(payload?.["driverId"]).toBe(driverId);
      expect(payload?.["routeStopId"]).toBe(routeStopId);
    });

    it("pickup.completed event payload", async () => {
      const tenantId = await seedTenant("pk-ev-comp");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const id = await fullLifecycle(tenantId, merchantId, addressId);

      const payload = await payloadFor(tenantId, "pickup.completed", id);
      expect(payload).toBeDefined();
      expect(payload?.["status"]).toBe("COMPLETED");
    });
  });

  // ── Read queries ──────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns the pickup request", async () => {
      const tenantId = await seedTenant("pk-get");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);

      const pickup = await asTenant(tenantId, () => pickups.getById(id));
      expect(pickup.id).toBe(id);
      expect(pickup.status).toBe("REQUESTED");
    });

    it("throws NotFoundError for a non-existent id", async () => {
      const tenantId = await seedTenant("pk-get-miss");
      await expect(asTenant(tenantId, () => pickups.getById(randomUUID()))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe("getByCode", () => {
    it("returns the pickup request by its scannable code", async () => {
      const tenantId = await seedTenant("pk-code");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { code } = await requestPickup(tenantId, merchantId, addressId);

      const pickup = await asTenant(tenantId, () => pickups.getByCode(code));
      expect(pickup.code).toBe(code);
    });

    it("throws NotFoundError for an unknown code", async () => {
      const tenantId = await seedTenant("pk-code-miss");
      await expect(
        asTenant(tenantId, () => pickups.getByCode("PR-99999999-999")),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── List (paginated) ──────────────────────────────────────────────────────

  describe("list", () => {
    it("returns paginated results in descending id order", async () => {
      const tenantId = await seedTenant("pk-list-page");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { id } = await requestPickup(tenantId, merchantId, addressId);
        ids.push(id);
      }

      const page1 = await asTenant(tenantId, () => pickups.list({ limit: 2 }));
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await asTenant(tenantId, () =>
        pickups.list({ limit: 2, cursor: page1.nextCursor ?? "" }),
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const allIds = [...page1.items.map((i) => i.id), ...page2.items.map((i) => i.id)];
      expect(allIds).toHaveLength(3);
      for (const id of ids) {
        expect(allIds).toContain(id);
      }
    });

    it("filters by status", async () => {
      const tenantId = await seedTenant("pk-list-status");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id: id1 } = await requestPickup(tenantId, merchantId, addressId);
      await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id1, { idempotencyKey: randomUUID() }, ctx));

      const accepted = await asTenant(tenantId, () => pickups.list({ status: "ACCEPTED" }));
      expect(accepted.items).toHaveLength(1);
      expect(accepted.items[0]?.id).toBe(id1);
    });

    it("filters by merchantId", async () => {
      const tenantId = await seedTenant("pk-list-merchant");
      const m1 = await seedMerchant(tenantId);
      const m2 = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await requestPickup(tenantId, m1, addressId);
      await requestPickup(tenantId, m2, addressId);

      const page = await asTenant(tenantId, () => pickups.list({ merchantId: m1 }));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.merchantId).toBe(m1);
    });

    it("filters by driverId", async () => {
      const tenantId = await seedTenant("pk-list-driver");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id: id1 } = await requestPickup(tenantId, merchantId, addressId);
      await requestPickup(tenantId, merchantId, addressId);

      const driverId = randomUUID();
      await asTenant(tenantId, () => pickups.accept(id1, { idempotencyKey: randomUUID() }, ctx));
      await asTenant(tenantId, () =>
        pickups.assign(id1, { idempotencyKey: randomUUID(), driverId }, ctx),
      );

      const page = await asTenant(tenantId, () => pickups.list({ driverId }));
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.assignedDriverId).toBe(driverId);
    });

    it("returns empty page when no results match", async () => {
      const tenantId = await seedTenant("pk-list-empty");
      const page = await asTenant(tenantId, () => pickups.list({ status: "COMPLETED" }));
      expect(page.items).toHaveLength(0);
      expect(page.nextCursor).toBeNull();
    });

    it("defaults limit to 50", async () => {
      const tenantId = await seedTenant("pk-list-default");
      const page = await asTenant(tenantId, () => pickups.list({}));
      expect(page.items).toHaveLength(0);
    });
  });

  // ── listByWindow ──────────────────────────────────────────────────────────

  describe("listByWindow", () => {
    it("returns pickups whose window overlaps the query range", async () => {
      const tenantId = await seedTenant("pk-window-q");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const baseTime = new Date("2026-08-01T08:00:00Z");
      await requestPickup(tenantId, merchantId, addressId, {
        requestedWindowFrom: new Date(baseTime.getTime()).toISOString(),
        requestedWindowTo: new Date(baseTime.getTime() + 2 * 3600_000).toISOString(),
      });
      await requestPickup(tenantId, merchantId, addressId, {
        requestedWindowFrom: new Date(baseTime.getTime() + 4 * 3600_000).toISOString(),
        requestedWindowTo: new Date(baseTime.getTime() + 6 * 3600_000).toISOString(),
      });

      const results = await asTenant(tenantId, () =>
        pickups.listByWindow(
          new Date(baseTime.getTime() + 1 * 3600_000),
          new Date(baseTime.getTime() + 5 * 3600_000),
        ),
      );
      expect(results).toHaveLength(2);
    });

    it("excludes pickups outside the query window", async () => {
      const tenantId = await seedTenant("pk-window-out");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const baseTime = new Date("2026-08-02T08:00:00Z");
      await requestPickup(tenantId, merchantId, addressId, {
        requestedWindowFrom: new Date(baseTime.getTime()).toISOString(),
        requestedWindowTo: new Date(baseTime.getTime() + 1 * 3600_000).toISOString(),
      });

      const results = await asTenant(tenantId, () =>
        pickups.listByWindow(
          new Date(baseTime.getTime() + 2 * 3600_000),
          new Date(baseTime.getTime() + 4 * 3600_000),
        ),
      );
      expect(results).toHaveLength(0);
    });

    it("filters by status within a window", async () => {
      const tenantId = await seedTenant("pk-window-status");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const baseTime = new Date("2026-08-03T08:00:00Z");
      const w = {
        requestedWindowFrom: baseTime.toISOString(),
        requestedWindowTo: new Date(baseTime.getTime() + 3 * 3600_000).toISOString(),
      };

      const { id: id1 } = await requestPickup(tenantId, merchantId, addressId, w);
      await requestPickup(tenantId, merchantId, addressId, w);

      await asTenant(tenantId, () => pickups.accept(id1, { idempotencyKey: randomUUID() }, ctx));

      const accepted = await asTenant(tenantId, () =>
        pickups.listByWindow(
          new Date(baseTime.getTime() - 1 * 3600_000),
          new Date(baseTime.getTime() + 4 * 3600_000),
          "ACCEPTED",
        ),
      );
      expect(accepted).toHaveLength(1);

      const requested = await asTenant(tenantId, () =>
        pickups.listByWindow(
          new Date(baseTime.getTime() - 1 * 3600_000),
          new Date(baseTime.getTime() + 4 * 3600_000),
          "REQUESTED",
        ),
      );
      expect(requested).toHaveLength(1);
    });

    it("orders results by requestedWindowFrom ascending", async () => {
      const tenantId = await seedTenant("pk-window-order");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const baseTime = new Date("2026-08-04T08:00:00Z");
      await requestPickup(tenantId, merchantId, addressId, {
        requestedWindowFrom: new Date(baseTime.getTime() + 2 * 3600_000).toISOString(),
        requestedWindowTo: new Date(baseTime.getTime() + 3 * 3600_000).toISOString(),
      });
      await requestPickup(tenantId, merchantId, addressId, {
        requestedWindowFrom: new Date(baseTime.getTime()).toISOString(),
        requestedWindowTo: new Date(baseTime.getTime() + 1 * 3600_000).toISOString(),
      });

      const results = await asTenant(tenantId, () =>
        pickups.listByWindow(
          new Date(baseTime.getTime() - 1 * 3600_000),
          new Date(baseTime.getTime() + 4 * 3600_000),
        ),
      );
      expect(results).toHaveLength(2);
      const [first, second] = results;
      expect(first?.requestedWindowFrom.getTime()).toBeLessThanOrEqual(
        second?.requestedWindowFrom.getTime() ?? Number.POSITIVE_INFINITY,
      );
    });
  });

  // ── NotFoundError for transitions on missing pickups ──────────────────────

  describe("not found", () => {
    it("accept throws NotFoundError for non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-nf-acc");
      await expect(
        asTenant(tenantId, () =>
          pickups.accept(randomUUID(), { idempotencyKey: randomUUID() }, ctx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("assign throws NotFoundError for non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-nf-asg");
      await expect(
        asTenant(tenantId, () =>
          pickups.assign(
            randomUUID(),
            { idempotencyKey: randomUUID(), driverId: randomUUID() },
            ctx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("collect throws NotFoundError for non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-nf-col");
      await expect(
        asTenant(tenantId, () =>
          pickups.collect(randomUUID(), { idempotencyKey: randomUUID() }, ctx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("complete throws NotFoundError for non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-nf-cmp");
      await expect(
        asTenant(tenantId, () =>
          pickups.complete(randomUUID(), { idempotencyKey: randomUUID() }, ctx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("cancel throws NotFoundError for non-existent pickup", async () => {
      const tenantId = await seedTenant("pk-nf-cnc");
      await expect(
        asTenant(tenantId, () =>
          pickups.cancel(randomUUID(), { idempotencyKey: randomUUID(), reason: "test" }, ctx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Tenant isolation (RLS) ────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("a tenant cannot read another tenant's pickup request", async () => {
      const tenantA = await seedTenant("pk-iso-a");
      const tenantB = await seedTenant("pk-iso-b");
      const merchantId = await seedMerchant(tenantA);
      const addressId = await seedAddress(tenantA);

      const { id } = await requestPickup(tenantA, merchantId, addressId);

      await expect(asTenant(tenantB, () => pickups.getById(id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("a tenant cannot transition another tenant's pickup request", async () => {
      const tenantA = await seedTenant("pk-iso-mut-a");
      const tenantB = await seedTenant("pk-iso-mut-b");
      const merchantId = await seedMerchant(tenantA);
      const addressId = await seedAddress(tenantA);

      const { id } = await requestPickup(tenantA, merchantId, addressId);

      await expect(
        asTenant(tenantB, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a tenant cannot scan another tenant's parcels", async () => {
      const tenantA = await seedTenant("pk-iso-scan-a");
      const tenantB = await seedTenant("pk-iso-scan-b");
      const merchantId = await seedMerchant(tenantA);
      const addressId = await seedAddress(tenantA);

      const ready = await readyPickup(tenantA, merchantId, addressId, 1);

      await expect(
        scanOne(tenantB, ready.id, ready.driverId, ready.shipments[0]?.trackingNumber ?? ""),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("cannot link a shipment belonging to another tenant", async () => {
      const tenantA = await seedTenant("pk-iso-link-a");
      const tenantB = await seedTenant("pk-iso-link-b");
      const merchantA = await seedMerchant(tenantA);
      const addressA = await seedAddress(tenantA);
      const merchantB = await seedMerchant(tenantB);
      const addressB = await seedAddress(tenantB);

      const theirs = await seedShipment(tenantA, merchantA, addressA);

      await expect(
        asTenant(tenantB, () =>
          pickups.request(createInput(merchantB, addressB, { shipmentIds: [theirs.id] }), ctx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("list returns only the current tenant's pickups", async () => {
      const tenantA = await seedTenant("pk-iso-list-a");
      const tenantB = await seedTenant("pk-iso-list-b");
      const m1 = await seedMerchant(tenantA);
      const a1 = await seedAddress(tenantA);
      const m2 = await seedMerchant(tenantB);
      const a2 = await seedAddress(tenantB);

      await requestPickup(tenantA, m1, a1);
      await requestPickup(tenantA, m1, a1);
      await requestPickup(tenantB, m2, a2);

      const pageA = await asTenant(tenantA, () => pickups.list({}));
      expect(pageA.items).toHaveLength(2);

      const pageB = await asTenant(tenantB, () => pickups.list({}));
      expect(pageB.items).toHaveLength(1);
    });

    it("getByCode is tenant-scoped", async () => {
      const tenantA = await seedTenant("pk-iso-code-a");
      const tenantB = await seedTenant("pk-iso-code-b");
      const merchantId = await seedMerchant(tenantA);
      const addressId = await seedAddress(tenantA);

      const { code } = await requestPickup(tenantA, merchantId, addressId);

      await expect(asTenant(tenantB, () => pickups.getByCode(code))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // ── Input validation (Zod strict schemas) ─────────────────────────────────

  describe("input validation", () => {
    it("rejects create with missing required fields", async () => {
      const tenantId = await seedTenant("pk-val-miss");
      await expect(asTenant(tenantId, () => pickups.request({}, ctx))).rejects.toThrow();
    });

    it("rejects invalid phone number", async () => {
      const tenantId = await seedTenant("pk-val-phone");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { contactPhone: "not-a-phone" }), ctx),
        ),
      ).rejects.toThrow();
    });

    it("rejects an empty shipmentIds array (omit it for MERCHANT_READY instead)", async () => {
      const tenantId = await seedTenant("pk-val-empty-ids");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { shipmentIds: [] }), ctx),
        ),
      ).rejects.toThrow();
    });

    it("rejects more than 500 shipmentIds", async () => {
      const tenantId = await seedTenant("pk-val-many-ids");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const tooMany = Array.from({ length: 501 }, () => randomUUID());
      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { shipmentIds: tooMany }), ctx),
        ),
      ).rejects.toThrow();
    });

    it("rejects a non-uuid shipment id", async () => {
      const tenantId = await seedTenant("pk-val-bad-id");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { shipmentIds: ["not-a-uuid"] }), ctx),
        ),
      ).rejects.toThrow();
    });

    it("rejects estimatedParcelCount as an input (it is derived)", async () => {
      const tenantId = await seedTenant("pk-val-derived");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { estimatedParcelCount: 5 }), ctx),
        ),
      ).rejects.toThrow();
    });

    it("rejects actualParcelCount as a collect input (it is derived)", async () => {
      const tenantId = await seedTenant("pk-val-derived-actual");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);

      await expect(
        asTenant(tenantId, () =>
          pickups.collect(ready.id, { idempotencyKey: randomUUID(), actualParcelCount: 1 }, ctx),
        ),
      ).rejects.toThrow();
    });

    it("rejects cancel without reason", async () => {
      const tenantId = await seedTenant("pk-val-reason");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await expect(
        asTenant(tenantId, () => pickups.cancel(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toThrow();
    });

    it("rejects assign without driverId", async () => {
      const tenantId = await seedTenant("pk-val-driver");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const { id } = await requestPickup(tenantId, merchantId, addressId);
      await asTenant(tenantId, () => pickups.accept(id, { idempotencyKey: randomUUID() }, ctx));
      await expect(
        asTenant(tenantId, () => pickups.assign(id, { idempotencyKey: randomUUID() }, ctx)),
      ).rejects.toThrow();
    });

    it("rejects unknown extra fields (strict mode)", async () => {
      const tenantId = await seedTenant("pk-val-extra");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () =>
          pickups.request(createInput(merchantId, addressId, { unknownField: "nope" }), ctx),
        ),
      ).rejects.toThrow();
    });

    it("rejects non-uuid merchantId", async () => {
      const tenantId = await seedTenant("pk-val-uuid");
      const addressId = await seedAddress(tenantId);

      await expect(
        asTenant(tenantId, () => pickups.request(createInput("not-a-uuid", addressId), ctx)),
      ).rejects.toThrow();
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  describe("concurrency", () => {
    it("two simultaneous requests get distinct codes", async () => {
      const tenantId = await seedTenant("pk-concur");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const [a, b] = await Promise.all([
        requestPickup(tenantId, merchantId, addressId),
        requestPickup(tenantId, merchantId, addressId),
      ]);

      expect(a.code).not.toBe(b.code);
    });

    it("two drivers racing for the same parcel produce exactly one custody event", async () => {
      const tenantId = await seedTenant("pk-concur-scan");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);
      const ready = await readyPickup(tenantId, merchantId, addressId, 1);
      const tracking = ready.shipments[0]?.trackingNumber ?? "";

      const settled = await Promise.allSettled([
        scanOne(tenantId, ready.id, ready.driverId, tracking),
        scanOne(tenantId, ready.id, randomUUID(), tracking),
      ]);

      // The row lock serialises them: one wins, the loser sees a conflict.
      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await outboxPayloads(tenantId, "pickup.parcel_scanned")).toHaveLength(1);
    });
  });

  // ── Multiple pickups same merchant ────────────────────────────────────────

  describe("multiple pickups per merchant", () => {
    it("a merchant can have multiple active pickup requests", async () => {
      const tenantId = await seedTenant("pk-multi");
      const merchantId = await seedMerchant(tenantId);
      const addressId = await seedAddress(tenantId);

      const first = await requestPickup(tenantId, merchantId, addressId);
      const second = await requestPickup(tenantId, merchantId, addressId);

      expect(first.id).not.toBe(second.id);
      expect(first.code).not.toBe(second.code);

      const page = await asTenant(tenantId, () => pickups.list({ merchantId }));
      expect(page.items).toHaveLength(2);
    });
  });
});
