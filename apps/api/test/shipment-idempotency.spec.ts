import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { requestFingerprint } from "../src/modules/shipment/domain/request-fingerprint.js";
import type { Shipment } from "../src/modules/shipment/domain/schema.js";
import {
  decodeShipment,
  encodeShipment,
} from "../src/modules/shipment/domain/shipment-snapshot.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  seedDriverLogin,
  withTenantContext,
} from "./database.harness.js";
import type { DriverLogin, TestDatabase } from "./database.harness.js";

/**
 * Idempotency keys bound to what they were used for (invariant I29, 0046).
 *
 * ⚠️ The key used to be looked up tenant-wide in shipment_events, BEFORE
 * authorization and with no binding. R1 and R2 below are the two reproduced
 * audit findings (F2): a key from parcel X silently swallowed a delivery of
 * parcel Y with a 200, and a driver who did not hold a parcel got 200 instead
 * of 403 by reusing someone else's key.
 *
 * Reference: draft-ietf-httpapi-idempotency-key-header-07: a duplicate returns
 * the original result; the same key with a different payload is 422.
 */
describe("shipment idempotency (I29)", () => {
  let database: TestDatabase;
  let shipments: ShipmentService;
  let createdTenants: string[] = [];

  const dispatcherA: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };
  const dispatcherB: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };
  const pod = { podType: "signature", signatureObjectKey: "pods/s.png", recipientName: "R" };

  function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  function as(login: DriverLogin): CommandContext {
    return { actor: { actorType: "DRIVER", actorId: login.userId } };
  }

  async function seedTenant(): Promise<string> {
    const id = await createTenant(database.migrator, "idempotency");
    createdTenants.push(id);
    return id;
  }

  function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      idempotencyKey: randomUUID(),
      senderName: "Boutique",
      senderPhone: "+21620000001",
      origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
      recipientName: "Ahmed",
      recipientPhone: "+21620000002",
      destination: { rawInput: "Sfax", countryCode: "TN", coordinates: { lat: 34.74, lng: 10.76 } },
      currency: "TND",
      ...overrides,
    };
  }

  async function outForDelivery(
    tenantId: string,
    courier: DriverLogin,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return inTenant(tenantId, async () => {
      const s = await shipments.create(createInput(overrides), dispatcherA);
      await shipments.recordEvent(
        s.id,
        { eventType: "assigned", idempotencyKey: randomUUID() },
        dispatcherA,
      );
      await shipments.recordPickup(
        s.id,
        { idempotencyKey: randomUUID(), driverId: courier.driverId },
        dispatcherA,
      );
      await shipments.recordEvent(
        s.id,
        { eventType: "out_for_delivery", idempotencyKey: randomUUID(), driverId: courier.driverId },
        dispatcherA,
      );
      return s.id;
    });
  }

  async function count(tenantId: string, query: "events" | "cod", id: string): Promise<number> {
    const rows = await withTenantContext(database.migrator, tenantId, (tx) =>
      query === "events"
        ? tx<
            { n: number }[]
          >`select count(*)::int as n from shipment_events where shipment_id = ${id}`
        : tx<{ n: number }[]>`
              select count(*)::int as n from outbox
               where event_type = 'cod.collected' and payload->>'shipmentId' = ${id}`,
    );
    return rows[0]?.n ?? -1;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      new MerchantService(db, outbox, new AuditService(db), addresses),
      new RecipientService(db),
      addresses,
      new OperatingConfigService(db),
    );
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Pure units ────────────────────────────────────────────────────────────

  describe("request fingerprint", () => {
    it("ignores field order and the key itself, and absent equals undefined", () => {
      expect(requestFingerprint({ idempotencyKey: "a", reason: "x", n: 1 })).toBe(
        requestFingerprint({ n: 1, reason: "x", idempotencyKey: "b", extra: undefined }),
      );
    });

    it("changes with any asked-for value, including nested and array order", () => {
      const base = requestFingerprint({ pod: { recipientName: "R" }, keys: ["a", "b"] });
      expect(requestFingerprint({ pod: { recipientName: "S" }, keys: ["a", "b"] })).not.toBe(base);
      expect(requestFingerprint({ pod: { recipientName: "R" }, keys: ["b", "a"] })).not.toBe(base);
    });

    it("canonicalises dates and bigints instead of trusting runtime printing", () => {
      const at = new Date("2026-10-10T08:00:00.000Z");
      expect(requestFingerprint({ at, amount: 12_500n })).toBe(
        requestFingerprint({ amount: 12_500n, at: new Date(at.getTime()) }),
      );
      expect(requestFingerprint({ amount: 12_500n })).not.toBe(
        requestFingerprint({ amount: 12_501n }),
      );
    });
  });

  describe("outcome snapshot codec", () => {
    it("round-trips a shipment exactly, bigints and instants included", async () => {
      const tenantId = await seedTenant();
      const created = await inTenant(tenantId, () =>
        shipments.create(createInput({ codAmountMinor: 9_007_199_254_740_993n }), dispatcherA),
      );
      // Past 2^53: a JSON number would silently round this to ...992.
      const back: Shipment = decodeShipment(JSON.parse(JSON.stringify(encodeShipment(created))));
      expect(back).toEqual(created);
      expect(back.codAmountMinor).toBe(9_007_199_254_740_993n);
    });

    it("refuses anything that is not a recorded snapshot", () => {
      expect(() => decodeShipment({ id: "x" })).toThrow();
    });
  });

  // ── The reproduced findings ───────────────────────────────────────────────

  it("R1: refuses a key used on another shipment, and does not skip the requested work silently", async () => {
    const tenantId = await seedTenant();
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const x = await outForDelivery(tenantId, courier);
    const y = await outForDelivery(tenantId, courier, { codAmountMinor: 45_000n });
    const key = randomUUID();
    await inTenant(tenantId, () =>
      shipments.confirmDelivery(x, { idempotencyKey: key, pod }, as(courier)),
    );
    const before = await count(tenantId, "events", y);

    await expect(
      inTenant(tenantId, () =>
        shipments.confirmDelivery(y, { idempotencyKey: key, codCollected: true, pod }, as(courier)),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 422 });

    // Nothing pretended to happen to Y, and nothing did.
    expect((await inTenant(tenantId, () => shipments.getById(y))).status).toBe("OUT_FOR_DELIVERY");
    expect(await count(tenantId, "events", y)).toBe(before);
    expect(await count(tenantId, "cod", y)).toBe(0);
  });

  it("R2: answers a different caller reusing a key with 422, not 200, and discloses nothing", async () => {
    const tenantId = await seedTenant();
    const a = await seedDriverLogin(database.migrator, tenantId);
    const b = await seedDriverLogin(database.migrator, tenantId);
    const x = await outForDelivery(tenantId, a);
    const key = randomUUID();
    await inTenant(tenantId, () =>
      shipments.confirmDelivery(x, { idempotencyKey: key, pod }, as(a)),
    );

    const refusal = await inTenant(tenantId, () =>
      shipments.confirmDelivery(x, { idempotencyKey: key, pod }, as(b)),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // No shipment, caller, status or payload of the earlier use in the message.
    expect(String((refusal as Error).message)).not.toMatch(/DELIVERED|[0-9a-f]{8}-[0-9a-f]{4}/u);
  });

  // ── Mismatches ────────────────────────────────────────────────────────────

  it("refuses the same caller reusing a key with a different payload", async () => {
    const tenantId = await seedTenant();
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const x = await outForDelivery(tenantId, courier);
    const key = randomUUID();
    await inTenant(tenantId, () =>
      shipments.recordFailedAttempt(
        x,
        { idempotencyKey: key, reasonCode: "CUSTOMER_UNAVAILABLE" },
        as(courier),
      ),
    );

    await expect(
      inTenant(tenantId, () =>
        shipments.recordFailedAttempt(
          x,
          { idempotencyKey: key, reasonCode: "WRONG_ADDRESS" },
          as(courier),
        ),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("refuses the same caller reusing a key for a different command on the same shipment", async () => {
    const tenantId = await seedTenant();
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const x = await outForDelivery(tenantId, courier);
    const key = randomUUID();
    await inTenant(tenantId, () =>
      shipments.recordFailedAttempt(
        x,
        { idempotencyKey: key, reasonCode: "CUSTOMER_UNAVAILABLE" },
        as(courier),
      ),
    );

    await expect(
      inTenant(tenantId, () =>
        shipments.cancel(x, { idempotencyKey: key, reason: "x" }, dispatcherA),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  // ── Valid replays ─────────────────────────────────────────────────────────

  it("replays the RECORDED outcome without repeating any effect, even after the parcel moved on", async () => {
    const tenantId = await seedTenant();
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const x = await outForDelivery(tenantId, courier);
    const key = randomUUID();
    const request = { idempotencyKey: key, reasonCode: "CUSTOMER_UNAVAILABLE" };
    const first = await inTenant(tenantId, () =>
      shipments.recordFailedAttempt(x, request, as(courier)),
    );
    const eventsAfterFirst = await count(tenantId, "events", x);

    // The parcel is sent out again, so "now" differs from the first outcome.
    await inTenant(tenantId, () =>
      shipments.recordEvent(
        x,
        { eventType: "out_for_delivery", idempotencyKey: randomUUID(), driverId: courier.driverId },
        dispatcherA,
      ),
    );

    const replay = await inTenant(tenantId, () =>
      shipments.recordFailedAttempt(x, request, as(courier)),
    );

    expect(replay).toEqual(first);
    expect(replay.status).toBe("ATTEMPT_FAILED");
    // One extra event: the out_for_delivery above. None from the replay.
    expect(await count(tenantId, "events", x)).toBe(eventsAfterFirst + 1);
  });

  it("replays a create for the same caller, and refuses it for another caller or payload", async () => {
    const tenantId = await seedTenant();
    const input = createInput();
    const first = await inTenant(tenantId, () => shipments.create(input, dispatcherA));
    const replay = await inTenant(tenantId, () => shipments.create(input, dispatcherA));
    expect(replay).toEqual(first);

    await expect(
      inTenant(tenantId, () => shipments.create(input, dispatcherB)),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    await expect(
      inTenant(tenantId, () =>
        shipments.create({ ...input, recipientName: "Someone else" }, dispatcherA),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("lets ANY dispatcher retry a server-derived fact key (route publish), but not on another shipment", async () => {
    const tenantId = await seedTenant();
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const [x, y] = await inTenant(tenantId, async () => [
      (await shipments.create(createInput(), dispatcherA)).id,
      (await shipments.create(createInput(), dispatcherA)).id,
    ]);
    const factKey = `assign:${randomUUID()}:${randomUUID()}`;
    const assign = { eventType: "assigned", idempotencyKey: factKey, driverId: courier.driverId };

    const first = await inTenant(tenantId, () => shipments.recordEvent(x, assign, dispatcherA));
    // A second dispatcher retrying a half-published route replays cleanly.
    const retry = await inTenant(tenantId, () => shipments.recordEvent(x, assign, dispatcherB));
    expect(retry).toEqual(first);

    await expect(
      inTenant(tenantId, () => shipments.recordEvent(y, assign, dispatcherA)),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────

  it("applies two concurrent identical deliveries exactly once", async () => {
    const tenantId = await seedTenant();
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const x = await outForDelivery(tenantId, courier, { codAmountMinor: 45_000n });
    const request = { idempotencyKey: randomUUID(), codCollected: true, pod };

    const [one, two] = await Promise.all([
      inTenant(tenantId, () => shipments.confirmDelivery(x, request, as(courier))),
      inTenant(tenantId, () => shipments.confirmDelivery(x, request, as(courier))),
    ]);

    expect(one).toEqual(two);
    expect(one.status).toBe("DELIVERED");
    expect(await count(tenantId, "cod", x)).toBe(1);
    const recorded = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<{ n: number }[]>`
        select count(*)::int as n from shipment_command_keys where idempotency_key = ${request.idempotencyKey}`,
    );
    expect(recorded[0]?.n).toBe(1);
    const delivered = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx<{ n: number }[]>`
        select count(*)::int as n from shipment_events
         where shipment_id = ${x} and event_type = 'delivered'`,
    );
    expect(delivered[0]?.n).toBe(1);
  });

  it("lets only one of two concurrent uses of a key on different shipments win; the loser changes nothing", async () => {
    const tenantId = await seedTenant();
    const courier = await seedDriverLogin(database.migrator, tenantId);
    const x = await outForDelivery(tenantId, courier);
    const y = await outForDelivery(tenantId, courier);
    const key = randomUUID();

    const results = await Promise.allSettled([
      inTenant(tenantId, () =>
        shipments.confirmDelivery(x, { idempotencyKey: key, pod }, as(courier)),
      ),
      inTenant(tenantId, () =>
        shipments.confirmDelivery(y, { idempotencyKey: key, pod }, as(courier)),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" ? rejected[0].reason : null).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    const statuses = await inTenant(tenantId, async () => [
      (await shipments.getById(x)).status,
      (await shipments.getById(y)).status,
    ]);
    // Exactly one parcel delivered; the loser's whole command rolled back.
    expect(statuses.filter((s) => s === "DELIVERED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "OUT_FOR_DELIVERY")).toHaveLength(1);
  });

  it("forbids rewriting a recorded key: the table is append-only for the app role", async () => {
    await expect(database.app`update shipment_command_keys set command = 'x'`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(database.app`delete from shipment_command_keys`).rejects.toThrow(
      /permission denied/i,
    );
  });
});
