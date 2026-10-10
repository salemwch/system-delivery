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
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
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

  /** The command context of a real, logged-in driver (invariant I26). */
  function as(login: DriverLogin): CommandContext {
    return { actor: { actorType: "DRIVER", actorId: login.userId } };
  }

  /**
   * Drives a shipment CREATED → OUT_FOR_DELIVERY in a real driver's custody.
   * Returns the shipment and the driver carrying it, the only caller allowed to
   * record its outcome.
   */
  async function toOutForDelivery(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; courier: DriverLogin }> {
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const id = await asTenant(tenantId, async () => {
      const shipment = await shipments.create(createInput(overrides), dispatcher);
      await shipments.recordEvent(
        shipment.id,
        { eventType: "assigned", idempotencyKey: randomUUID() },
        dispatcher,
      );
      await shipments.recordPickup(
        shipment.id,
        { idempotencyKey: randomUUID(), driverId: courier.driverId },
        dispatcher,
      );
      await shipments.recordEvent(
        shipment.id,
        { eventType: "out_for_delivery", idempotencyKey: randomUUID(), driverId: courier.driverId },
        dispatcher,
      );
      return shipment.id;
    });
    return { id, courier };
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
    const merchants = new MerchantService(
      db,
      outbox,
      new AuditService(db),
      new AddressService(db, outbox, new ManualGeocodingProvider()),
    );
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
      new AuditService(db),
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
      const merchants = new MerchantService(
        db,
        outbox,
        new AuditService(db),
        new AddressService(db, outbox, new ManualGeocodingProvider()),
      );
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
      const { id, courier } = await toOutForDelivery(tenantId);

      const delivered = await asTenant(tenantId, () =>
        shipments.confirmDelivery(
          id,
          {
            idempotencyKey: randomUUID(),
            location: { lat: 36.8624, lng: 10.1955 },
            pod: signaturePod(),
          },
          as(courier),
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
      const { id, courier } = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });
      const delivered = await asTenant(tenantId, () =>
        shipments.confirmDelivery(
          id,
          {
            idempotencyKey: randomUUID(),
            codCollected: true,
            pod: signaturePod(),
          },
          as(courier),
        ),
      );
      expect(delivered.status).toBe("DELIVERED");
      expect(delivered.codStatus).toBe("COLLECTED");
      expect(await outboxEventTypes(tenantId)).toContain("cod.collected");
    });

    it("refuses to deliver a COD shipment without collecting the cash", async () => {
      const tenantId = await seedTenant("ship-cod-nocash");
      const { id, courier } = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });
      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            { idempotencyKey: randomUUID(), pod: signaturePod() },
            as(courier),
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses a contactless POD for a COD delivery", async () => {
      const tenantId = await seedTenant("ship-cod-contactless");
      const { id, courier } = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });
      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            {
              idempotencyKey: randomUUID(),
              codCollected: true,
              pod: { podType: "contactless", recipientName: "Sonia" },
            },
            as(courier),
          ),
        ),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("sends a shipment to RETURN_PENDING when attempts are exhausted", async () => {
      const tenantId = await seedTenant("ship-exhaust");
      const { id, courier } = await toOutForDelivery(tenantId, { maxAttempts: 1 });
      const failed = await asTenant(tenantId, () =>
        shipments.recordFailedAttempt(
          id,
          {
            idempotencyKey: randomUUID(),
            reasonCode: "CUSTOMER_UNAVAILABLE",
          },
          as(courier),
        ),
      );
      expect(failed.status).toBe("RETURN_PENDING");
      const emitted = await outboxEventTypes(tenantId);
      expect(emitted).toContain("delivery.failed");
      expect(emitted).toContain("shipment.return_initiated");
    });
  });

  // ── Driver identity and custody (I26) ────────────────────────────────────────

  describe("driver identity and custody (I26)", () => {
    async function payloadsOf(tenantId: string, eventType: string): Promise<unknown[]> {
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ payload: unknown }[]>`
          select payload from outbox where event_type = ${eventType} order by seq`,
      );
      return rows.map((r) => r.payload);
    }

    async function eventDrivers(tenantId: string, id: string): Promise<(string | null)[]> {
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ driver_id: string | null }[]>`
          select driver_id from shipment_events
           where shipment_id = ${id} and event_type in ('delivery_attempted', 'delivered')
           order by sequence`,
      );
      return rows.map((r) => r.driver_id);
    }

    it("books the delivery and its COD to the calling driver, resolved from the login", async () => {
      const tenantId = await seedTenant("i26-attribution");
      const { id, courier } = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });

      await asTenant(tenantId, () =>
        shipments.confirmDelivery(
          id,
          { idempotencyKey: randomUUID(), codCollected: true, pod: signaturePod() },
          as(courier),
        ),
      );

      // The driver id — not the user id the token carries — on every fact the
      // ledger and reporting read.
      expect(await eventDrivers(tenantId, id)).toEqual([courier.driverId, courier.driverId]);
      expect(await payloadsOf(tenantId, "cod.collected")).toEqual([
        expect.objectContaining({ driverId: courier.driverId, amountMinor: "45500" }),
      ]);
    });

    it("rejects a driverId in the body instead of silently ignoring it", async () => {
      const tenantId = await seedTenant("i26-body");
      const { id, courier } = await toOutForDelivery(tenantId);

      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            { idempotencyKey: randomUUID(), driverId: courier.driverId, pod: signaturePod() },
            as(courier),
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        asTenant(tenantId, () =>
          shipments.recordFailedAttempt(
            id,
            {
              idempotencyKey: randomUUID(),
              driverId: courier.driverId,
              reasonCode: "CUSTOMER_UNAVAILABLE",
            },
            as(courier),
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a delivery by a driver who does not hold the parcel, and writes nothing", async () => {
      const tenantId = await seedTenant("i26-other-deliver");
      const { id } = await toOutForDelivery(tenantId, { codAmountMinor: 45500 });
      const colleague = await seedDriverLogin(database.migrator, tenantId);
      const before = await asTenant(tenantId, () => shipments.getById(id));

      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            { idempotencyKey: randomUUID(), codCollected: true, pod: signaturePod() },
            as(colleague),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const after = await asTenant(tenantId, () => shipments.getById(id));
      expect(after.status).toBe("OUT_FOR_DELIVERY");
      expect(after.lastSequence).toBe(before.lastSequence);
      expect(after.codStatus).toBe("PENDING");
      expect(await payloadsOf(tenantId, "cod.collected")).toEqual([]);
      expect(await outboxEventTypes(tenantId)).not.toContain("delivery.attempted");
    });

    it("refuses a failed attempt by a driver who does not hold the parcel", async () => {
      const tenantId = await seedTenant("i26-other-fail");
      const { id } = await toOutForDelivery(tenantId);
      const colleague = await seedDriverLogin(database.migrator, tenantId);

      await expect(
        asTenant(tenantId, () =>
          shipments.recordFailedAttempt(
            id,
            { idempotencyKey: randomUUID(), reasonCode: "CUSTOMER_UNAVAILABLE" },
            as(colleague),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const after = await asTenant(tenantId, () => shipments.getById(id));
      expect(after.status).toBe("OUT_FOR_DELIVERY");
      expect(after.attemptCount).toBe(0);
    });

    it("refuses a caller with no driver record, whatever their permissions", async () => {
      const tenantId = await seedTenant("i26-staff");
      const { id } = await toOutForDelivery(tenantId);

      // An OWNER holds `shipment:deliver` through the wildcard role, but capturing
      // POD is a driver act (01-mvp-scope §6) and there is no one to book it to.
      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            { idempotencyKey: randomUUID(), pod: signaturePod() },
            { actor: { actorType: "DISPATCHER", actorId: randomUUID() }, canOverride: true },
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses a parcel sent out with no driver named — custody nobody holds", async () => {
      const tenantId = await seedTenant("i26-no-custodian");
      const courier = await seedDriverLogin(database.migrator, tenantId);
      const id = await asTenant(tenantId, async () => {
        const shipment = await shipments.create(createInput(), dispatcher);
        await shipments.recordEvent(
          shipment.id,
          { eventType: "assigned", idempotencyKey: randomUUID() },
          dispatcher,
        );
        await shipments.recordPickup(
          shipment.id,
          { idempotencyKey: randomUUID(), driverId: courier.driverId },
          dispatcher,
        );
        await shipments.recordEvent(
          shipment.id,
          { eventType: "out_for_delivery", idempotencyKey: randomUUID() },
          dispatcher,
        );
        return shipment.id;
      });

      // Fail closed: a DRIVER custody with no driver id is not "anyone's".
      await expect(
        asTenant(tenantId, () =>
          shipments.confirmDelivery(
            id,
            { idempotencyKey: randomUUID(), pod: signaturePod() },
            as(courier),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("replays an applied delivery for its driver even though custody has been released", async () => {
      const tenantId = await seedTenant("i26-replay");
      const { id, courier } = await toOutForDelivery(tenantId);
      const key = randomUUID();
      const deliver = () =>
        asTenant(tenantId, () =>
          shipments.confirmDelivery(id, { idempotencyKey: key, pod: signaturePod() }, as(courier)),
        );

      const first = await deliver();
      // Offline retry: the parcel is DELIVERED and in nobody's custody now, but
      // the same idempotency key must answer with the original result.
      const second = await deliver();

      expect(second.status).toBe("DELIVERED");
      expect(second.lastSequence).toBe(first.lastSequence);
    });

    it("answers a late outcome on a delivered parcel with the state machine, not a 403", async () => {
      const tenantId = await seedTenant("i26-late");
      const { id, courier } = await toOutForDelivery(tenantId);
      await asTenant(tenantId, () =>
        shipments.confirmDelivery(
          id,
          { idempotencyKey: randomUUID(), pod: signaturePod() },
          as(courier),
        ),
      );

      // A NEW key (a double tap that minted another): the app must learn the
      // parcel is already delivered, not that it was never this driver's.
      await expect(
        asTenant(tenantId, () =>
          shipments.recordFailedAttempt(
            id,
            { idempotencyKey: randomUUID(), reasonCode: "CUSTOMER_UNAVAILABLE" },
            as(courier),
          ),
        ),
      ).rejects.toMatchObject({ code: "SHIPMENT_INVALID_TRANSITION" });
    });

    it("cannot link one login to two drivers (migration 0043)", async () => {
      const tenantId = await seedTenant("i26-unique");
      const courier = await seedDriverLogin(database.migrator, tenantId);

      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`
            insert into drivers (tenant_id, user_id, employee_code, full_name, phone, status, employment_type)
            values (${tenantId}, ${courier.userId}, 'D-TWIN', 'Twin', '+21629999999', 'ACTIVE', 'EMPLOYEE')`,
        ),
      ).rejects.toThrow(/drivers_tenant_user_uq/);
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
      const { id } = await toOutForDelivery(tenantId);

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
      // A replay is the SAME caller sending the same request again (I29). The
      // staff command is recorded by one dispatcher, twice.
      const first = await asTenant(tenantId, () =>
        shipments.recordPickup(shipment.id, { idempotencyKey: key, driverId }, dispatcher),
      );
      const second = await asTenant(tenantId, () =>
        shipments.recordPickup(shipment.id, { idempotencyKey: key, driverId }, dispatcher),
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
