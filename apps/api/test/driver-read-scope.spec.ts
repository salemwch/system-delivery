import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { PickupService } from "../src/modules/pickup/application/pickup.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { NO_DRIVER, TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  seedDriverLogin,
  withTenantContext,
} from "./database.harness.js";
import type { DriverLogin, TestDatabase } from "./database.harness.js";

/**
 * Driver read scope (invariant I28, migration 0045).
 *
 * ⚠️ Before 0045 a DRIVER held tenant-wide `shipment:read`, `pickup:read` and
 * `recipient:read`: any driver could list every parcel, pickup run and
 * recipient (name, phone) of the courier. These tests run the real services
 * under a driver's request context against real RLS, so they prove what the
 * database enforces, not what a service remembered to filter.
 */
describe("driver read scope (I28)", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let shipments: ShipmentService;
  let recipients: RecipientService;
  let pickups: PickupService;
  let merchants: MerchantService;
  let addresses: AddressService;
  let createdTenants: string[] = [];

  const staff: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };
  const pod = { podType: "signature", signatureObjectKey: "pods/s.png", recipientName: "R" };

  async function seedTenant(): Promise<string> {
    const id = await createTenant(database.migrator, "driver-scope");
    createdTenants.push(id);
    return id;
  }

  /** Staff: no sub-tenant scope, sees the whole tenant. */
  function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "user" }, fn);
  }

  /** Exactly what TenantContextInterceptor binds for a DRIVER-role principal. */
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

  function driverCtx(login: DriverLogin): CommandContext {
    return { actor: { actorType: "DRIVER", actorId: login.userId } };
  }

  /** A shipment routed to `driverId` (the `assigned` event names the driver). */
  async function assignedTo(tenantId: string, driverId: string, phone: string): Promise<string> {
    return asStaff(tenantId, async () => {
      const created = await shipments.create(
        {
          idempotencyKey: randomUUID(),
          senderName: "Boutique",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: `Recipient ${phone}`,
          recipientPhone: phone,
          destination: {
            rawInput: "Sfax",
            countryCode: "TN",
            coordinates: { lat: 34.74, lng: 10.76 },
          },
          currency: "TND",
        },
        staff,
      );
      await shipments.recordEvent(
        created.id,
        { eventType: "assigned", idempotencyKey: randomUUID(), driverId },
        staff,
      );
      return created.id;
    });
  }

  /** assigned → picked up → out for delivery, all naming `driverId`. */
  async function outForDelivery(
    tenantId: string,
    driverId: string,
    phone: string,
  ): Promise<string> {
    const id = await assignedTo(tenantId, driverId, phone);
    await asStaff(tenantId, async () => {
      await shipments.recordPickup(id, { idempotencyKey: randomUUID(), driverId }, staff);
      await shipments.recordEvent(
        id,
        { eventType: "out_for_delivery", idempotencyKey: randomUUID(), driverId },
        staff,
      );
    });
    return id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    merchants = new MerchantService(db, outbox, new AuditService(db), addresses);
    recipients = new RecipientService(db);
    pickups = new PickupService(db, outbox);
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      merchants,
      recipients,
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

  describe("shipments", () => {
    it("shows a driver their own shipment and hides a colleague's", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const mine = await assignedTo(tenantId, a.driverId, "+21620000101");
      const theirs = await assignedTo(tenantId, b.driverId, "+21620000102");

      expect((await asDriver(tenantId, a, () => shipments.getById(mine))).id).toBe(mine);
      await expect(asDriver(tenantId, a, () => shipments.getById(theirs))).rejects.toBeInstanceOf(
        NotFoundError,
      );

      const listed = await asDriver(tenantId, a, () => shipments.list({}));
      expect(listed.items.map((s) => s.id)).toEqual([mine]);
    });

    it("hides a colleague's custody history, not just the shipment row", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const theirs = await outForDelivery(tenantId, b.driverId, "+21620000103");

      // The service checks the parent first and answers 404.
      await expect(asDriver(tenantId, a, () => shipments.getEvents(theirs))).rejects.toBeInstanceOf(
        NotFoundError,
      );

      // And the DATABASE refuses too, for any query that reads the child tables
      // by shipment id directly, so a future endpoint cannot forget the parent.
      const visible = await asDriver(tenantId, a, () =>
        db.withTenant(async (tx) => {
          const counts = await tx.execute<{ events: number; legs: number }>(sql`
            select (select count(*)::int from shipment_events where shipment_id = ${theirs}) as events,
                   (select count(*)::int from shipment_legs   where shipment_id = ${theirs}) as legs`);
          return counts[0];
        }),
      );
      expect(visible).toEqual({ events: 0, legs: 0 });

      // Control: the same query as staff sees them, so zero above is the policy.
      const asSeenByStaff = await asStaff(tenantId, () =>
        db.withTenant(async (tx) => {
          const counts = await tx.execute<{ events: number }>(
            sql`select count(*)::int as events from shipment_events where shipment_id = ${theirs}`,
          );
          return counts[0]?.events;
        }),
      );
      expect(asSeenByStaff).toBeGreaterThan(0);
    });

    it("lets a driver deliver their own parcel under the scope, and still see it afterwards", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const id = await outForDelivery(tenantId, a.driverId, "+21620000104");

      // Every write of the delivery (events, POD, legs, the projection's own
      // WITH CHECK) runs under the driver scope here.
      const delivered = await asDriver(tenantId, a, () =>
        shipments.confirmDelivery(id, { idempotencyKey: randomUUID(), pod }, driverCtx(a)),
      );
      expect(delivered.status).toBe("DELIVERED");

      const after = await asDriver(tenantId, a, () => shipments.getById(id));
      expect(after.lastDriverId).toBe(a.driverId);
      const events = await asDriver(tenantId, a, () => shipments.getEvents(id));
      expect(events.map((e) => e.eventType)).toContain("delivered");
    });

    it("moves the shipment out of the first driver's view when it is re-assigned", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const id = await assignedTo(tenantId, a.driverId, "+21620000105");

      await asStaff(tenantId, () =>
        shipments.recordEvent(
          id,
          { eventType: "assigned", idempotencyKey: randomUUID(), driverId: b.driverId },
          staff,
        ),
      );

      await expect(asDriver(tenantId, a, () => shipments.getById(id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await asDriver(tenantId, b, () => shipments.getById(id))).id).toBe(id);
    });

    it("shows staff the whole tenant", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      await assignedTo(tenantId, a.driverId, "+21620000106");
      await assignedTo(tenantId, b.driverId, "+21620000107");

      const listed = await asStaff(tenantId, () => shipments.list({}));
      expect(listed.items).toHaveLength(2);
    });

    it("shows a DRIVER login with no driver record nothing at all (fail closed)", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      await assignedTo(tenantId, a.driverId, "+21620000108");

      const unlinked: DriverLogin = { userId: randomUUID(), driverId: NO_DRIVER };
      const listed = await asDriver(tenantId, unlinked, () => shipments.list({}));
      expect(listed.items).toEqual([]);
    });
  });

  describe("recipients", () => {
    it("shows a driver the recipients of their own shipments only", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const mine = await assignedTo(tenantId, a.driverId, "+21620000201");
      const theirs = await assignedTo(tenantId, b.driverId, "+21620000202");
      const myRecipient = (await asStaff(tenantId, () => shipments.getById(mine))).recipientId;
      const theirRecipient = (await asStaff(tenantId, () => shipments.getById(theirs))).recipientId;
      if (myRecipient === null || theirRecipient === null) {
        throw new Error("fixture shipments must reference recipients");
      }

      expect((await asDriver(tenantId, a, () => recipients.getById(myRecipient))).id).toBe(
        myRecipient,
      );
      await expect(
        asDriver(tenantId, a, () => recipients.getById(theirRecipient)),
      ).rejects.toBeInstanceOf(NotFoundError);

      const book = await asDriver(tenantId, a, () => recipients.list({}));
      expect(book.items.map((r) => r.id)).toEqual([myRecipient]);
    });
  });

  describe("pickups", () => {
    async function assignedPickup(tenantId: string, collector: DriverLogin): Promise<string> {
      return asStaff(tenantId, async () => {
        const merchant = await merchants.create({ name: `M ${randomUUID().slice(0, 6)}` });
        const address = await addresses.resolve({
          rawInput: "Rue de la République, Tunis",
          city: "Tunis",
          countryCode: "TN",
          coordinates: { lat: 36.8, lng: 10.18 },
        });
        const from = new Date(Date.now() + 3_600_000);
        const pickup = await pickups.request(
          {
            idempotencyKey: randomUUID(),
            merchantId: merchant.id,
            pickupAddressId: address.addressId,
            contactName: "Contact",
            contactPhone: "+21620123456",
            requestedWindowFrom: from.toISOString(),
            requestedWindowTo: new Date(from.getTime() + 7_200_000).toISOString(),
          },
          { actorId: staff.actor.actorId ?? "" },
        );
        const ctx = { actorId: staff.actor.actorId ?? "" };
        await pickups.accept(pickup.id, { idempotencyKey: randomUUID() }, ctx);
        await pickups.assign(
          pickup.id,
          { idempotencyKey: randomUUID(), driverId: collector.driverId },
          ctx,
        );
        return pickup.id;
      });
    }

    it("shows a driver the runs assigned to them and hides a colleague's", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const mine = await assignedPickup(tenantId, a);
      const theirs = await assignedPickup(tenantId, b);

      expect((await asDriver(tenantId, a, () => pickups.getById(mine))).id).toBe(mine);
      await expect(asDriver(tenantId, a, () => pickups.getById(theirs))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const listed = await asDriver(tenantId, a, () => pickups.list({}));
      expect(listed.items.map((p) => p.id)).toEqual([mine]);
    });
  });

  it("hides a shipment no driver has been named on from every driver (fail closed)", async () => {
    // A NULL owner compares NULL, which RLS treats as deny: an unassigned
    // parcel is nobody's in the field yet.
    const tenantId = await seedTenant();
    const a = await seedDriverLogin(database.migrator, tenantId);
    const id = await assignedTo(tenantId, a.driverId, "+21620000301");
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx`update shipments set last_driver_id = null where id = ${id}`,
    );
    await expect(asDriver(tenantId, a, () => shipments.getById(id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
