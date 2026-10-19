import { randomBytes, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DistributionNoteService } from "../src/modules/dispatch/application/distribution-note.service.js";
import { HeuristicOptimizationProvider } from "../src/modules/dispatch/application/optimization.provider.js";
import { RouteService } from "../src/modules/dispatch/application/route.service.js";
import { AddressCorrectionService } from "../src/modules/directory/application/address-correction.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { DriverService } from "../src/modules/fleet/application/driver.service.js";
import { VehicleService } from "../src/modules/fleet/application/vehicle.service.js";
import { HubService } from "../src/modules/network/application/hub.service.js";
import { PickupService } from "../src/modules/pickup/application/pickup.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { TenantService } from "../src/modules/platform/application/tenant.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { NO_DRIVER, TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { NotFoundError } from "../src/shared/errors/index.js";
import { CurrencyService } from "../src/shared/money/index.js";
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
  let corrections: AddressCorrectionService;
  let vehicles: VehicleService;
  let routes: RouteService;
  let notes: DistributionNoteService;
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

  /** A staff member who signs what they do: a correction always names a person. */
  async function asStaffUser<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenantId}, ${`staff-${randomUUID().slice(0, 8)}@test.tn`}, 'hash', 'Staff', 'ACTIVE')
        returning id`,
    );
    const actorId = rows[0]?.id;
    if (actorId === undefined) throw new Error("failed to seed staff user");
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "user", actorId }, fn);
  }

  /** A correction as the driver app sends it. */
  function pin(lat: number, lng: number) {
    return { idempotencyKey: randomUUID(), coordinates: { lat, lng }, occurredAt: new Date() };
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

  /** A merchant's pickup address, created as staff. */
  async function merchantPickupAddress(tenantId: string): Promise<string> {
    const address = await asStaff(tenantId, () =>
      addresses.resolve({
        rawInput: "Rue de la République, Tunis",
        city: "Tunis",
        countryCode: "TN",
        coordinates: { lat: 36.8, lng: 10.18 },
      }),
    );
    return address.addressId;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    addresses = new AddressService(db, new ManualGeocodingProvider());
    corrections = new AddressCorrectionService(db, outbox, new AuditService(db));
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
      new AuditService(db),
    );
    const hubs = new HubService(db, outbox, addresses);
    vehicles = new VehicleService(db, outbox, hubs);
    const drivers = new DriverService(db, outbox, hubs, new FieldCipher(randomBytes(32)));
    routes = new RouteService(
      db,
      outbox,
      new FeatureService(db, new AuditService(db)),
      new HeuristicOptimizationProvider(),
      shipments,
      vehicles,
      drivers,
      hubs,
      addresses,
    );
    notes = new DistributionNoteService(
      routes,
      shipments,
      addresses,
      drivers,
      vehicles,
      new TenantService(db, outbox, new OperatingConfigService(db), new AuditService(db)),
      new CurrencyService(db),
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

  describe("routes and stops (migrations 0047, 0048)", () => {
    /** A new shipment's leg, delivering to a known location in Ariana. */
    async function plannedLeg(tenantId: string): Promise<string> {
      return asStaff(tenantId, async () => {
        const shipment = await shipments.create(
          {
            idempotencyKey: randomUUID(),
            senderName: "Boutique",
            senderPhone: "+21620000001",
            origin: {
              rawInput: "Tunis",
              countryCode: "TN",
              coordinates: { lat: 36.8, lng: 10.18 },
            },
            recipientName: "Route recipient",
            recipientPhone: `+2162${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
            destination: {
              rawInput: "Ariana",
              city: "Ariana",
              countryCode: "TN",
              coordinates: { lat: 36.86, lng: 10.19 },
            },
            currency: "TND",
          },
          staff,
        );
        const legs = await db.withTenant((tx) =>
          tx.execute<{ id: string }>(
            sql`select id from shipment_legs where shipment_id = ${shipment.id} limit 1`,
          ),
        );
        const legId = legs[0]?.id;
        if (legId === undefined) throw new Error("fixture shipment has no leg");
        return legId;
      });
    }

    /** A route published to `driver`, with one stop serving `legId` (a new leg if omitted). */
    async function publishedRoute(
      tenantId: string,
      driver: DriverLogin,
      legId?: string,
    ): Promise<string> {
      const leg = legId ?? (await plannedLeg(tenantId));
      return asStaff(tenantId, async () => {
        const vehicle = await vehicles.create({
          plateNumber: `TUN-${randomUUID().slice(0, 6)}`,
          type: "VAN",
          capacityParcels: 60,
          capacityWeightGrams: 500_000,
        });
        const route = await routes.create({
          plannedDate: "2026-10-11",
          driverId: driver.driverId,
          vehicleId: vehicle.id,
        });
        await routes.addStops(route.id, { legIds: [leg] });
        await routes.publish(route.id, { actor: staff.actor });
        return route.id;
      });
    }

    it("hides a colleague's route, its stops and its manifest (where the recipients live)", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const routeId = await publishedRoute(tenantId, a);

      const listed = await asDriver(tenantId, b, () => routes.list({}));
      expect(listed.items.map((r) => r.id)).not.toContain(routeId);
      await expect(asDriver(tenantId, b, () => routes.getById(routeId))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(asDriver(tenantId, b, () => routes.getManifest(routeId))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // The printable bon de distribution lists every recipient on the route.
      await expect(asDriver(tenantId, b, () => notes.render(routeId))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // The stop rows themselves, read directly: the database refuses too.
      const stops = await asDriver(tenantId, b, () =>
        db.withTenant((tx) =>
          tx.execute<{ n: number }>(
            sql`select count(*)::int as n from route_stops where route_id = ${routeId}`,
          ),
        ),
      );
      expect(stops[0]?.n).toBe(0);
    });

    it("shows a driver their own route manifest, stop address included", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const routeId = await publishedRoute(tenantId, a);

      const manifest = await asDriver(tenantId, a, () => routes.getManifest(routeId));
      const stop = manifest.stops[0];
      expect(stop?.latitude).toBeCloseTo(36.86, 2);
      expect(stop?.shipments).toHaveLength(1);
      expect((await asDriver(tenantId, a, () => routes.list({}))).items.map((r) => r.id)).toEqual([
        routeId,
      ]);
    });

    it("takes a re-planned parcel's stop off the previous driver's cancelled route", async () => {
      // Re-planning a published route is cancel + a new route (domain §3.9
      // rule 5). The cancelled route stays the first driver's, so a route-level
      // check alone left them the stop's coordinates and address after the
      // parcel had moved to a colleague. The stop follows its parcel (0048).
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const legId = await plannedLeg(tenantId);
      const first = await publishedRoute(tenantId, a, legId);
      const before = await asDriver(tenantId, a, () => routes.getManifest(first));
      expect(before.stops).toHaveLength(1);

      await asStaff(tenantId, () => routes.cancel(first, { reason: "Driver unavailable" }));
      const second = await publishedRoute(tenantId, b, legId);

      const stale = await asDriver(tenantId, a, () => routes.getManifest(first));
      expect(stale.status).toBe("CANCELLED");
      expect(stale.stops).toEqual([]);
      const current = await asDriver(tenantId, b, () => routes.getManifest(second));
      expect(current.stops[0]?.latitude).toBeCloseTo(36.86, 2);
      expect(current.stops[0]?.shipments).toHaveLength(1);
      // The stop's address row follows the parcel too (0050): read by id, it is
      // B's now and no longer A's.
      const stopAddress = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) =>
          tx<
            { address_id: string }[]
          >`select address_id from route_stops where route_id = ${first}`,
      );
      const addressId = stopAddress[0]?.address_id ?? "";
      await expect(
        asDriver(tenantId, a, () => addresses.getById(addressId)),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await asDriver(tenantId, b, () => addresses.getById(addressId))).id).toBe(addressId);
      // Staff still see both routes whole.
      const staffView = await asStaff(tenantId, () => routes.getManifest(first));
      expect(staffView.stops).toHaveLength(1);
    });

    it("shows a stop's own address to the driver of its parcel, as on a return (0050)", async () => {
      // A return stop delivers to the merchant's return address, which is
      // neither the parcel's origin nor its destination: only the stop itself
      // authorises it.
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const legId = await plannedLeg(tenantId);
      const routeId = await publishedRoute(tenantId, a, legId);
      const returnAddress = await merchantPickupAddress(tenantId);
      await withTenantContext(
        database.migrator,
        tenantId,
        (
          tx,
        ) => tx`insert into route_stops (tenant_id, route_id, sequence, type, address_id, leg_ids)
                   values (${tenantId}, ${routeId}, 99, 'DELIVERY', ${returnAddress},
                           ARRAY[${legId}]::uuid[])`,
      );

      expect((await asDriver(tenantId, a, () => addresses.getById(returnAddress))).id).toBe(
        returnAddress,
      );
      await expect(
        asDriver(tenantId, b, () => addresses.getById(returnAddress)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("shows staff every route", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      await publishedRoute(tenantId, a);
      await publishedRoute(tenantId, b);
      expect((await asStaff(tenantId, () => routes.list({}))).items).toHaveLength(2);
    });
  });

  describe("pickups", () => {
    /** A pickup assigned to `collector`, at `pickupAddressId` (a new address if omitted). */
    async function assignedPickup(
      tenantId: string,
      collector: DriverLogin,
      pickupAddressId?: string,
    ): Promise<string> {
      return asStaff(tenantId, async () => {
        const merchant = await merchants.create({ name: `M ${randomUUID().slice(0, 6)}` });
        const addressId = pickupAddressId ?? (await merchantPickupAddress(tenantId));
        const from = new Date(Date.now() + 3_600_000);
        const pickup = await pickups.request(
          {
            idempotencyKey: randomUUID(),
            merchantId: merchant.id,
            pickupAddressId: addressId,
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

    it("shares one pickup address between the drivers sent there, and no one else (0050)", async () => {
      // A merchant's standing pickup address is ONE row referenced by every
      // pickup there. It is visible to each driver sent there, without copies.
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const c = await seedDriverLogin(database.migrator, tenantId);
      const shared = await merchantPickupAddress(tenantId);
      await assignedPickup(tenantId, a, shared);
      await assignedPickup(tenantId, b, shared);

      expect((await asDriver(tenantId, a, () => addresses.getById(shared))).id).toBe(shared);
      expect((await asDriver(tenantId, b, () => addresses.getById(shared))).id).toBe(shared);
      await expect(asDriver(tenantId, c, () => addresses.getById(shared))).rejects.toBeInstanceOf(
        NotFoundError,
      );

      // B's correction is A's too: one row, improved once for everyone sent there.
      await asDriver(tenantId, b, () => corrections.submit(shared, pin(36.81, 10.19)));
      const seenByA = await asDriver(tenantId, a, () => addresses.getById(shared));
      expect(seenByA.geocodeSource).toBe("driver_corrected");
      expect(seenByA.latitude).toBeCloseTo(36.81, 5);
      await expect(
        asDriver(tenantId, c, () => corrections.submit(shared, pin(1, 1))),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await asStaff(tenantId, () => addresses.getById(shared))).latitude).toBeCloseTo(
        36.81,
        5,
      );
    });
  });

  describe("addresses (migration 0050)", () => {
    /** The two addresses of a shipment, read as staff. */
    async function addressesOf(
      tenantId: string,
      shipmentId: string,
    ): Promise<{ origin: string; destination: string }> {
      const s = await asStaff(tenantId, () => shipments.getById(shipmentId));
      return { origin: s.originAddressId, destination: s.destinationAddressId };
    }

    /** `address.geocode_corrected` audit rows for an address. */
    async function correctionTrail(tenantId: string, addressId: string) {
      return withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<
          {
            actor_type: string;
            actor_id: string | null;
            changes: Record<string, { from: unknown; to: unknown }>;
            context: Record<string, unknown>;
          }[]
        >`select actor_type, actor_id, changes, context from audit_log
           where action = 'address.geocode_corrected' and resource_id = ${addressId}`,
      );
    }

    it("shows a driver their own parcel's addresses and hides a colleague's", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const own = await addressesOf(
        tenantId,
        await outForDelivery(tenantId, a.driverId, "+21620000501"),
      );
      const other = await addressesOf(
        tenantId,
        await outForDelivery(tenantId, b.driverId, "+21620000502"),
      );

      for (const id of [own.origin, own.destination]) {
        expect((await asDriver(tenantId, a, () => addresses.getById(id))).id).toBe(id);
      }
      for (const id of [other.origin, other.destination]) {
        await expect(asDriver(tenantId, a, () => addresses.getById(id))).rejects.toBeInstanceOf(
          NotFoundError,
        );
        // Staff keep the whole tenant.
        expect((await asStaff(tenantId, () => addresses.getById(id))).id).toBe(id);
      }
      // Read directly, past any service: the database refuses too.
      const rows = await asDriver(tenantId, a, () =>
        db.withTenant((tx) =>
          tx.execute<{ n: number }>(
            sql`select count(*)::int as n from addresses
                 where id in (${other.origin}, ${other.destination})`,
          ),
        ),
      );
      expect(rows[0]?.n).toBe(0);
    });

    it("takes the address away when the parcel moves to a colleague", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const id = await assignedTo(tenantId, a.driverId, "+21620000503");
      const { destination } = await addressesOf(tenantId, id);
      expect((await asDriver(tenantId, a, () => addresses.getById(destination))).id).toBe(
        destination,
      );

      await asStaff(tenantId, () =>
        shipments.recordEvent(
          id,
          { eventType: "assigned", idempotencyKey: randomUUID(), driverId: b.driverId },
          staff,
        ),
      );

      await expect(
        asDriver(tenantId, a, () => addresses.getById(destination)),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await asDriver(tenantId, b, () => addresses.getById(destination))).id).toBe(
        destination,
      );
    });

    it("shows a DRIVER login with no driver record no address (fail closed)", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const { destination } = await addressesOf(
        tenantId,
        await outForDelivery(tenantId, a.driverId, "+21620000504"),
      );
      const unlinked: DriverLogin = { userId: randomUUID(), driverId: NO_DRIVER };
      await expect(
        asDriver(tenantId, unlinked, () => addresses.getById(destination)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("cannot reach another tenant's address, whoever asks", async () => {
      const home = await seedTenant();
      const away = await seedTenant();
      const a = await seedDriverLogin(database.migrator, home);
      const c = await seedDriverLogin(database.migrator, away);
      const { destination } = await addressesOf(
        away,
        await outForDelivery(away, c.driverId, "+21620000505"),
      );
      await expect(asDriver(home, a, () => addresses.getById(destination))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(asStaff(home, () => addresses.getById(destination))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        asStaffUser(home, () => corrections.submit(destination, pin(1, 1))),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("corrects only an address the driver may see, and audits the pin it replaced", async () => {
      const tenantId = await seedTenant();
      const a = await seedDriverLogin(database.migrator, tenantId);
      const b = await seedDriverLogin(database.migrator, tenantId);
      const own = await addressesOf(
        tenantId,
        await outForDelivery(tenantId, a.driverId, "+21620000506"),
      );
      const other = await addressesOf(
        tenantId,
        await outForDelivery(tenantId, b.driverId, "+21620000507"),
      );

      const submitted = await asDriver(tenantId, a, () =>
        corrections.submit(own.destination, {
          ...pin(34.7412, 10.7612),
          accessNotes: "Portail vert, 2e étage",
        }),
      );
      expect(submitted.correction.status).toBe("APPLIED");
      const corrected = await asStaff(tenantId, () => addresses.getById(own.destination));
      expect(corrected.geocodeSource).toBe("driver_corrected");
      expect(corrected.latitude).toBeCloseTo(34.7412, 5);
      const trail = await correctionTrail(tenantId, own.destination);
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        actor_type: "DRIVER",
        actor_id: a.userId,
        changes: { pinSource: { from: "manual", to: "driver_corrected" } },
        context: { accessNotesChanged: true },
      });
      expect(Number(trail[0]?.changes["latitude"]?.from)).toBeCloseTo(34.74, 5);
      expect(Number(trail[0]?.changes["latitude"]?.to)).toBeCloseTo(34.7412, 5);
      // The trail records that the notes changed, never what they say.
      expect(JSON.stringify(trail[0])).not.toContain("Portail vert");

      // A colleague's pin: not found, unchanged, and nothing recorded.
      const before = await asStaff(tenantId, () => addresses.getById(other.destination));
      await expect(
        asDriver(tenantId, a, () => corrections.submit(other.destination, pin(34.9, 10.9))),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await asStaff(tenantId, () => addresses.getById(other.destination))).toEqual(before);
      expect(await correctionTrail(tenantId, other.destination)).toEqual([]);

      // Staff may correct any address in the tenant (a few hundred metres:
      // applied at once, not held for review).
      await asStaffUser(tenantId, () => corrections.submit(other.destination, pin(34.742, 10.762)));
      expect(await correctionTrail(tenantId, other.destination)).toHaveLength(1);
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
