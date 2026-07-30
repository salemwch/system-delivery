import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, ForbiddenError, NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Shipment aggregate: the state machine, the immutable custody ledger, POD, COD,
 * idempotency, and cross-tenant isolation — all against a real PostgreSQL through
 * the dp_app role, so RLS, the append-only grant on shipment_events, and the
 * (shipment, sequence) / (tenant, idempotency_key) unique constraints run exactly
 * as they do in production.
 */
describe("shipment", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let outbox: OutboxService;
  let shipments: ShipmentService;
  let createdTenants: string[] = [];

  const dispatcher: CommandContext = {
    actor: { actorType: "DISPATCHER", actorId: randomUUID() },
  };
  function driver(): CommandContext {
    return { actor: { actorType: "DRIVER", actorId: randomUUID() } };
  }

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

  /** A minimal valid create payload, with pinned addresses so geocode is confident. */
  function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      idempotencyKey: randomUUID(),
      senderName: "Boutique Farah",
      senderPhone: "+21620123456",
      origin: {
        rawInput: "Rue de Marseille, Tunis",
        city: "Tunis",
        countryCode: "TN",
        coordinates: { lat: 36.8008, lng: 10.1817 },
      },
      recipientName: "Sonia Gharbi",
      recipientPhone: "+21620987654",
      destination: {
        rawInput: "Rue de la Liberté, Ariana",
        city: "Ariana",
        countryCode: "TN",
        coordinates: { lat: 36.8625, lng: 10.1956 },
      },
      currency: "TND",
      ...overrides,
    };
  }

  /** Drives a shipment CREATED → OUT_FOR_DELIVERY, returning its id. */
  async function toOutForDelivery(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return asTenant(tenantId, async () => {
      const shipment = await shipments.create(createInput(overrides), dispatcher);
      await shipments.recordEvent(
        shipment.id,
        { eventType: "assigned", idempotencyKey: randomUUID() },
        dispatcher,
      );
      await shipments.recordPickup(
        shipment.id,
        { idempotencyKey: randomUUID(), driverId: randomUUID() },
        driver(),
      );
      await shipments.recordEvent(
        shipment.id,
        { eventType: "out_for_delivery", idempotencyKey: randomUUID() },
        dispatcher,
      );
      return shipment.id;
    });
  }

  function signaturePod(): Record<string, unknown> {
    return {
      podType: "signature",
      signatureObjectKey: "pods/sig-123.png",
      recipientName: "Sonia Gharbi",
    };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    outbox = new OutboxService();
    const merchants = new MerchantService(db, outbox);
    const recipients = new RecipientService(db);
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    const events = new ShipmentEventService(outbox);
    const operatingConfig = new OperatingConfigService(db);
    shipments = new ShipmentService(
      db,
      events,
      outbox,
      merchants,
      recipients,
      addresses,
      operatingConfig,
    );
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a shipment, a first leg, and emits shipment.created", async () => {
      const tenantId = await seedTenant("ship-create");
      const shipment = await asTenant(tenantId, () => shipments.create(createInput(), dispatcher));

      expect(shipment.status).toBe("CREATED");
      expect(shipment.trackingNumber).toMatch(/^SD-[0-9A-Z]{4}-[0-9A-Z]{6}$/);
      expect(shipment.recipientName).toBe("Sonia Gharbi");
      expect(shipment.codStatus).toBe("NOT_APPLICABLE");
      expect(shipment.lastSequence).toBe(1n);
      expect(await outboxEventTypes(tenantId)).toEqual(["shipment.created"]);

      const events = await asTenant(tenantId, () => shipments.getEvents(shipment.id));
      expect(events.map((e) => e.eventType)).toEqual(["created"]);
      expect(events[0]?.sequence).toBe(1n);
    });

    it("reuses an existing recipient by phone (I19)", async () => {
      const tenantId = await seedTenant("ship-reuse");
      const a = await asTenant(tenantId, () => shipments.create(createInput(), dispatcher));
      const b = await asTenant(tenantId, () => shipments.create(createInput(), dispatcher));
      expect(b.recipientId).toBe(a.recipientId);
    });

    it("marks COD shipments PENDING and stores the amount as bigint minor units", async () => {
      const tenantId = await seedTenant("ship-cod");
      const shipment = await asTenant(tenantId, () =>
        shipments.create(createInput({ codAmountMinor: 45500 }), dispatcher),
      );
      expect(shipment.codAmountMinor).toBe(45500n);
      expect(shipment.codStatus).toBe("PENDING");
    });

    it("is idempotent: the same idempotency key returns the same shipment", async () => {
      const tenantId = await seedTenant("ship-idem-create");
      const key = randomUUID();
      const first = await asTenant(tenantId, () =>
        shipments.create(createInput({ idempotencyKey: key }), dispatcher),
      );
      const second = await asTenant(tenantId, () =>
        shipments.create(createInput({ idempotencyKey: key }), dispatcher),
      );
      expect(second.id).toBe(first.id);
      expect(await outboxEventTypes(tenantId)).toEqual(["shipment.created"]);
    });

    it("rejects a shipment for a suspended merchant", async () => {
      const tenantId = await seedTenant("ship-susp");
      const merchants = new MerchantService(db, outbox);
      const merchantId = await asTenant(tenantId, async () => {
        const m = await merchants.create({ name: "Suspended Co" });
        await merchants.suspend(m.id, "unpaid");
        return m.id;
      });
      await expect(
        asTenant(tenantId, () => shipments.create(createInput({ merchantId }), dispatcher)),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("runs the full happy path to DELIVERED with a POD", async () => {
      const tenantId = await seedTenant("ship-deliver");
      const id = await toOutForDelivery(tenantId);

      const delivered = await asTenant(tenantId, () =>
        shipments.confirmDelivery(
          id,
          {
            idempotencyKey: randomUUID(),
            driverId: randomUUID(),
            location: { lat: 36.8624, lng: 10.1955 },
            pod: signaturePod(),
          },
          driver(),
        ),
      );

      expect(delivered.status).toBe("DELIVERED");
      expect(delivered.attemptCount).toBe(1);

      const events = await asTenant(tenantId, () => shipments.getEvents(id));
      expect(events.map((e) => e.eventType)).toEqual([
        "created",
        "assigned",
        "picked_up",
        "out_for_delivery",
        "delivery_attempted",
        "delivered",
      ]);

      const podRows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ pod_type: string }[]>`select pod_type from pod where shipment_id = ${id}`,
      );
      expect(podRows).toHaveLength(1);
      expect(podRows[0]?.pod_type).toBe("signature");

      const emitted = await outboxEventTypes(tenantId);
      expect(emitted).toContain("delivery.attempted");
      expect(emitted).toContain("pod.captured");
      expect(emitted).toContain("shipment.delivered");
    });

    it("collects COD on delivery and posts cod.collected", async () => {
      const tenantId = await seedTenant("ship-cod-deliver");
      const id = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });
      const delivered = await asTenant(tenantId, () =>
        shipments.confirmDelivery(
          id,
          {
            idempotencyKey: randomUUID(),
            driverId: randomUUID(),
            codCollected: true,
            pod: signaturePod(),
          },
          driver(),
        ),
      );
      expect(delivered.status).toBe("DELIVERED");
      expect(delivered.codStatus).toBe("COLLECTED");
      expect(await outboxEventTypes(tenantId)).toContain("cod.collected");
    });

    it("refuses to deliver a COD shipment without collecting the cash", async () => {
      const tenantId = await seedTenant("ship-cod-nocash");
      const id = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });
      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            { idempotencyKey: randomUUID(), driverId: randomUUID(), pod: signaturePod() },
            driver(),
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses a contactless POD for a COD delivery", async () => {
      const tenantId = await seedTenant("ship-cod-contactless");
      const id = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });
      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            {
              idempotencyKey: randomUUID(),
              driverId: randomUUID(),
              codCollected: true,
              pod: { podType: "contactless", recipientName: "Sonia" },
            },
            driver(),
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("sends a shipment to RETURN_PENDING when attempts are exhausted", async () => {
      const tenantId = await seedTenant("ship-exhaust");
      const id = await toOutForDelivery(tenantId, { maxAttempts: 1 });
      const failed = await asTenant(tenantId, () =>
        shipments.recordFailedAttempt(
          id,
          {
            idempotencyKey: randomUUID(),
            driverId: randomUUID(),
            reasonCode: "CUSTOMER_UNAVAILABLE",
          },
          driver(),
        ),
      );
      expect(failed.status).toBe("RETURN_PENDING");
      const emitted = await outboxEventTypes(tenantId);
      expect(emitted).toContain("delivery.failed");
      expect(emitted).toContain("shipment.return_initiated");
    });
  });

  // ── State machine enforcement ────────────────────────────────────────────────

  describe("state machine", () => {
    it("rejects an illegal transition (pickup before assignment)", async () => {
      const tenantId = await seedTenant("ship-illegal");
      const shipment = await asTenant(tenantId, () => shipments.create(createInput(), dispatcher));
      await expect(
        asTenant(tenantId, () =>
          shipments.recordPickup(
            shipment.id,
            { idempotencyKey: randomUUID(), driverId: randomUUID() },
            driver(),
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("rejects any lifecycle event on a terminal shipment", async () => {
      const tenantId = await seedTenant("ship-terminal");
      const shipment = await asTenant(tenantId, () => shipments.create(createInput(), dispatcher));
      await asTenant(tenantId, () =>
        shipments.cancel(
          shipment.id,
          { idempotencyKey: randomUUID(), reason: "merchant recall" },
          dispatcher,
        ),
      );
      await expect(
        asTenant(tenantId, () =>
          shipments.recordEvent(
            shipment.id,
            { eventType: "assigned", idempotencyKey: randomUUID() },
            dispatcher,
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("requires OWNER override to cancel an in-custody shipment", async () => {
      const tenantId = await seedTenant("ship-cancel-custody");
      const id = await toOutForDelivery(tenantId);

      await expect(
        asTenant(tenantId, () =>
          shipments.cancel(id, { idempotencyKey: randomUUID(), reason: "lost" }, dispatcher),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const cancelled = await asTenant(tenantId, () =>
        shipments.cancel(
          id,
          { idempotencyKey: randomUUID(), reason: "lost" },
          { actor: { actorType: "DISPATCHER", actorId: randomUUID() }, canOverride: true },
        ),
      );
      expect(cancelled.status).toBe("CANCELLED");
    });
  });

  // ── Custody ledger integrity ──────────────────────────────────────────────────

  describe("custody ledger", () => {
    it("is idempotent: a replayed pickup creates no second event", async () => {
      const tenantId = await seedTenant("ship-idem-pickup");
      const shipment = await asTenant(tenantId, () => shipments.create(createInput(), dispatcher));
      await asTenant(tenantId, () =>
        shipments.recordEvent(
          shipment.id,
          { eventType: "assigned", idempotencyKey: randomUUID() },
          dispatcher,
        ),
      );
      const key = randomUUID();
      const driverId = randomUUID();
      const first = await asTenant(tenantId, () =>
        shipments.recordPickup(shipment.id, { idempotencyKey: key, driverId }, driver()),
      );
      const second = await asTenant(tenantId, () =>
        shipments.recordPickup(shipment.id, { idempotencyKey: key, driverId }, driver()),
      );
      expect(first.lastSequence).toBe(second.lastSequence);

      const events = await asTenant(tenantId, () => shipments.getEvents(shipment.id));
      expect(events.filter((e) => e.eventType === "picked_up")).toHaveLength(1);
    });

    it("forbids UPDATE of shipment_events through the application role (append-only)", async () => {
      const tenantId = await seedTenant("ship-append-only");
      await asTenant(tenantId, () => shipments.create(createInput(), dispatcher));
      // dp_app has SELECT + INSERT on shipment_events, deliberately no UPDATE. The
      // grant is the enforcement, not convention.
      await expect(
        database.app`update shipment_events set reason_code = 'tampered'`,
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // ── Isolation ─────────────────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("hides another tenant's shipment as NotFound (RLS)", async () => {
      const tenantA = await seedTenant("ship-iso-a");
      const tenantB = await seedTenant("ship-iso-b");
      const shipment = await asTenant(tenantA, () => shipments.create(createInput(), dispatcher));
      await expect(asTenant(tenantB, () => shipments.getById(shipment.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
