import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RouteService } from "../src/modules/dispatch/application/route.service.js";
import { AssignmentService } from "../src/modules/dispatch/application/assignment.service.js";
import type { DispatchContext } from "../src/modules/dispatch/application/route.service.js";
import { HeuristicOptimizationProvider } from "../src/modules/dispatch/application/optimization.provider.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { VehicleService } from "../src/modules/fleet/application/vehicle.service.js";
import { DriverService } from "../src/modules/fleet/application/driver.service.js";
import { ShiftService } from "../src/modules/fleet/application/shift.service.js";
import { HubService } from "../src/modules/network/application/hub.service.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Dispatch module: routes, stops, the deterministic sequencer, publish/assign,
 * capacity + skill gating, the one-IN_PROGRESS-per-driver invariant, and the
 * driver manifest — against a real PostgreSQL, so RLS, the DEFERRABLE
 * (route_id, sequence) unique, and the partial in-progress index all run as in
 * production. Dispatch composes shipment (the sanctioned same-layer call), fleet,
 * network, directory, and platform exactly as it does at runtime.
 */
describe("dispatch", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let routesSvc: RouteService;
  let assignmentSvc: AssignmentService;
  let shipments: ShipmentService;
  let vehicles: VehicleService;
  let drivers: DriverService;
  let shiftsSvc: ShiftService;
  let createdTenants: string[] = [];

  const ctx: DispatchContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function enableOptimization(tenantId: string): Promise<void> {
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) =>
        tx`insert into tenant_features (tenant_id, feature_key, enabled, source)
           values (${tenantId}, 'ROUTE_OPTIMIZATION_ENABLED', true, 'PLAN')`,
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

  function shipmentInput(
    destination: { lat: number; lng: number },
    overrides: Record<string, unknown> = {},
  ) {
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
        rawInput: "Destination, Ariana",
        city: "Ariana",
        countryCode: "TN",
        coordinates: destination,
      },
      currency: "TND",
      ...overrides,
    };
  }

  /** Creates a shipment and returns { shipmentId, legId }. */
  async function makeShipment(
    tenantId: string,
    destination: { lat: number; lng: number },
    overrides: Record<string, unknown> = {},
  ): Promise<{ shipmentId: string; legId: string }> {
    return asTenant(tenantId, async () => {
      const shipment = await shipments.create(shipmentInput(destination, overrides), ctx);
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) =>
          tx<
            { id: string }[]
          >`select id from shipment_legs where shipment_id = ${shipment.id} limit 1`,
      );
      const legId = rows[0]?.id;
      if (legId === undefined) {
        throw new Error("shipment leg not found");
      }
      return { shipmentId: shipment.id, legId };
    });
  }

  async function makeVehicle(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return asTenant(tenantId, async () => {
      const v = await vehicles.create({
        plateNumber: `TUN-${Math.floor(Math.random() * 100000)}`,
        type: "VAN",
        capacityParcels: 60,
        capacityWeightGrams: 500_000,
        ...overrides,
      });
      return v.id;
    });
  }

  async function makeDriver(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    return asTenant(tenantId, async () => {
      const d = await drivers.create({
        employeeCode: `D-${Math.floor(Math.random() * 100000)}`,
        fullName: "Karim Trabelsi",
        phone: `+2162${Math.floor(1000000 + Math.random() * 8999999)}`,
        employmentType: "EMPLOYEE",
        ...overrides,
      });
      await drivers.activate(d.id);
      return d.id;
    });
  }

  async function shipmentStatus(tenantId: string, shipmentId: string): Promise<string> {
    return asTenant(tenantId, async () => {
      const s = await shipments.getById(shipmentId);
      return s.status;
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const features = new FeatureService(db);
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    const merchants = new MerchantService(db, outbox, new AuditService(db), new AddressService(db, outbox, new ManualGeocodingProvider()));
    const recipients = new RecipientService(db);
    const hubs = new HubService(db, outbox, addresses);
    const cipher = new FieldCipher(randomBytes(32));
    vehicles = new VehicleService(db, outbox, hubs);
    drivers = new DriverService(db, outbox, hubs, cipher);
    shiftsSvc = new ShiftService(db, outbox);
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
    const optimizer = new HeuristicOptimizationProvider();
    routesSvc = new RouteService(
      db,
      outbox,
      features,
      optimizer,
      shipments,
      vehicles,
      drivers,
      hubs,
      addresses,
    );
    assignmentSvc = new AssignmentService(shipments, drivers, hubs, addresses);
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
    it("creates a DRAFT route with a per-day code", async () => {
      const tenantId = await seedTenant("disp-create");
      const route = await asTenant(tenantId, () => routesSvc.create({ plannedDate: "2026-07-23" }));
      expect(route.status).toBe("DRAFT");
      expect(route.code).toBe("R-20260723-001");
      expect(route.stopCount).toBe(0);

      const second = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23" }),
      );
      expect(second.code).toBe("R-20260723-002");
    });

    it("rejects an unknown driver reference", async () => {
      const tenantId = await seedTenant("disp-create-bad");
      await expect(
        asTenant(tenantId, () =>
          routesSvc.create({ plannedDate: "2026-07-23", driverId: randomUUID() }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Plan + optimise ──────────────────────────────────────────────────────────

  describe("addStops + optimize", () => {
    it("plans legs into stops and sequences them with the deterministic fallback", async () => {
      const tenantId = await seedTenant("disp-plan");
      await enableOptimization(tenantId);
      const vehicleId = await makeVehicle(tenantId);
      const driverId = await makeDriver(tenantId);

      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const b = await makeShipment(tenantId, { lat: 36.81, lng: 10.18 });
      const c = await makeShipment(tenantId, { lat: 36.82, lng: 10.18 });

      const route = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );

      const plan = await asTenant(tenantId, () =>
        routesSvc.addStops(route.id, { legIds: [a.legId, b.legId, c.legId] }),
      );
      expect(plan.stops).toHaveLength(3);
      expect(plan.capacity.parcels).toBe(3);
      expect(plan.capacity.capacity?.parcels).toBe(60);

      const result = await asTenant(tenantId, () => routesSvc.optimize(route.id, ctx));
      expect(result.solver).toBe("HAVERSINE_NN_2OPT");
      expect(result.usedFallback).toBe(true);
      expect(result.stopCount).toBe(3);
      expect(result.plannedDistanceM).toBeGreaterThan(0);

      // With no start hub, seeding is deterministic; the three collinear stops end
      // up monotonically ordered by latitude (ascending or descending — both are
      // the same optimal path, direction depending only on the seed).
      const stops = await asTenant(tenantId, () => routesSvc.getStops(route.id));
      const latOrder = stops.map((s) => s.latitude);
      const ascending = [...latOrder].sort((x, y) => (x ?? 0) - (y ?? 0));
      const descending = [...ascending].reverse();
      expect([JSON.stringify(ascending), JSON.stringify(descending)]).toContain(
        JSON.stringify(latOrder),
      );
    });

    it("keeps manual order when ROUTE_OPTIMIZATION_ENABLED is off (fail-closed)", async () => {
      const tenantId = await seedTenant("disp-flag-off");
      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const b = await makeShipment(tenantId, { lat: 36.81, lng: 10.18 });

      const route = await asTenant(tenantId, () => routesSvc.create({ plannedDate: "2026-07-23" }));
      const before = await asTenant(tenantId, () =>
        routesSvc.addStops(route.id, { legIds: [a.legId, b.legId] }),
      );
      const beforeOrder = before.stops.map((s) => s.id);

      const result = await asTenant(tenantId, () => routesSvc.optimize(route.id, ctx));
      expect(result.solver).toBe("MANUAL");
      expect(result.usedFallback).toBe(false);

      const after = await asTenant(tenantId, () => routesSvc.getStops(route.id));
      expect(after.map((s) => s.id)).toEqual(beforeOrder);
    });

    it("merges into the existing stop for the same address (idempotent re-add)", async () => {
      const tenantId = await seedTenant("disp-merge");
      const a = await makeShipment(tenantId, { lat: 36.82, lng: 10.19 });

      const route = await asTenant(tenantId, () => routesSvc.create({ plannedDate: "2026-07-23" }));
      const first = await asTenant(tenantId, () =>
        routesSvc.addStops(route.id, { legIds: [a.legId] }),
      );
      expect(first.stops).toHaveLength(1);

      // Re-adding the same leg merges into the existing stop rather than creating a
      // duplicate — a stop for an address entity is a single visit (domain §3.10).
      const second = await asTenant(tenantId, () =>
        routesSvc.addStops(route.id, { legIds: [a.legId] }),
      );
      expect(second.stops).toHaveLength(1);
      expect(second.stops[0]?.legIds).toEqual([a.legId]);
    });

    it("rejects a leg already planned on another active route", async () => {
      const tenantId = await seedTenant("disp-conflict");
      const a = await makeShipment(tenantId, { lat: 36.82, lng: 10.19 });
      const r1 = await asTenant(tenantId, () => routesSvc.create({ plannedDate: "2026-07-23" }));
      const r2 = await asTenant(tenantId, () => routesSvc.create({ plannedDate: "2026-07-23" }));
      await asTenant(tenantId, () => routesSvc.addStops(r1.id, { legIds: [a.legId] }));
      await expect(
        asTenant(tenantId, () => routesSvc.addStops(r2.id, { legIds: [a.legId] })),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  // ── Publish (the sanctioned shipment.assigned call) ──────────────────────────

  describe("publish", () => {
    it("assigns each shipment and emits route.published", async () => {
      const tenantId = await seedTenant("disp-publish");
      const vehicleId = await makeVehicle(tenantId);
      const driverId = await makeDriver(tenantId);
      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const b = await makeShipment(tenantId, { lat: 36.81, lng: 10.18 });

      const route = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );
      await asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [a.legId, b.legId] }));
      const published = await asTenant(tenantId, () => routesSvc.publish(route.id, ctx));
      expect(published.status).toBe("PUBLISHED");
      expect(published.publishedAt).not.toBeNull();

      expect(await shipmentStatus(tenantId, a.shipmentId)).toBe("ASSIGNED");
      expect(await shipmentStatus(tenantId, b.shipmentId)).toBe("ASSIGNED");

      const events = await outboxEventTypes(tenantId);
      expect(events.filter((e) => e === "shipment.assigned")).toHaveLength(2);
      expect(events).toContain("route.published");

      // Stops are locked once communicated to the driver.
      const stops = await asTenant(tenantId, () => routesSvc.getStops(route.id));
      expect(stops.every((s) => s.locked)).toBe(true);
    });

    it("refuses to publish without a driver and vehicle", async () => {
      const tenantId = await seedTenant("disp-publish-bare");
      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const route = await asTenant(tenantId, () => routesSvc.create({ plannedDate: "2026-07-23" }));
      await asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [a.legId] }));
      await expect(
        asTenant(tenantId, () => routesSvc.publish(route.id, ctx)),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("rejects a load that exceeds vehicle capacity", async () => {
      const tenantId = await seedTenant("disp-capacity");
      const vehicleId = await makeVehicle(tenantId, { capacityParcels: 1 });
      const driverId = await makeDriver(tenantId);
      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const b = await makeShipment(tenantId, { lat: 36.81, lng: 10.18 });
      const route = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );
      await asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [a.legId, b.legId] }));
      await expect(
        asTenant(tenantId, () => routesSvc.publish(route.id, ctx)),
      ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    });

    it("rejects a driver missing a required skill", async () => {
      const tenantId = await seedTenant("disp-skill");
      const vehicleId = await makeVehicle(tenantId);
      const driverId = await makeDriver(tenantId, { skills: ["STANDARD"] });
      const a = await makeShipment(
        tenantId,
        { lat: 36.83, lng: 10.18 },
        { requiredSkills: ["REFRIGERATED"] },
      );
      const route = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );
      await asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [a.legId] }));
      await expect(
        asTenant(tenantId, () => routesSvc.publish(route.id, ctx)),
      ).rejects.toMatchObject({ code: "DRIVER_MISSING_SKILL" });
    });

    it("cannot edit a route once published", async () => {
      const tenantId = await seedTenant("disp-locked");
      const vehicleId = await makeVehicle(tenantId);
      const driverId = await makeDriver(tenantId);
      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const b = await makeShipment(tenantId, { lat: 36.81, lng: 10.18 });
      const route = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );
      await asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [a.legId] }));
      await asTenant(tenantId, () => routesSvc.publish(route.id, ctx));
      await expect(
        asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [b.legId] })),
      ).rejects.toMatchObject({ code: "ROUTE_NOT_DRAFT" });
    });
  });

  // ── Lifecycle: start / complete / one-in-progress ────────────────────────────

  describe("lifecycle", () => {
    async function publishedRoute(
      tenantId: string,
      driverId: string,
    ): Promise<{ routeId: string; stopIds: string[] }> {
      const vehicleId = await makeVehicle(tenantId);
      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const route = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );
      await asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [a.legId] }));
      await asTenant(tenantId, () => routesSvc.publish(route.id, ctx));
      const stops = await asTenant(tenantId, () => routesSvc.getStops(route.id));
      return { routeId: route.id, stopIds: stops.map((s) => s.id) };
    }

    it("starts, resolves stops, and completes a route", async () => {
      const tenantId = await seedTenant("disp-life");
      const driverId = await makeDriver(tenantId);
      const { routeId, stopIds } = await publishedRoute(tenantId, driverId);

      const started = await asTenant(tenantId, () => routesSvc.start(routeId, ctx));
      expect(started.status).toBe("IN_PROGRESS");

      // A route with an open stop cannot complete.
      await expect(asTenant(tenantId, () => routesSvc.complete(routeId))).rejects.toMatchObject({
        code: "ROUTE_HAS_OPEN_STOPS",
      });

      for (const stopId of stopIds) {
        await asTenant(tenantId, () => routesSvc.arriveAtStop(stopId));
        await asTenant(tenantId, () => routesSvc.resolveStop(stopId, "COMPLETED"));
      }
      const completed = await asTenant(tenantId, () => routesSvc.complete(routeId));
      expect(completed.status).toBe("COMPLETED");

      const events = await outboxEventTypes(tenantId);
      expect(events).toContain("route.started");
      expect(events).toContain("stop.completed");
      expect(events).toContain("route.completed");
    });

    it("blocks publishing a second route while the driver is mid-route (I8)", async () => {
      const tenantId = await seedTenant("disp-i8");
      const driverId = await makeDriver(tenantId);
      const first = await publishedRoute(tenantId, driverId);
      await asTenant(tenantId, () => routesSvc.start(first.routeId, ctx));

      // A second route for the same driver can be drafted, but publishing it while
      // the first is IN_PROGRESS is refused — the documented publish-time guard.
      const vehicleId = await makeVehicle(tenantId);
      const b = await makeShipment(tenantId, { lat: 36.81, lng: 10.18 });
      const route2 = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );
      await asTenant(tenantId, () => routesSvc.addStops(route2.id, { legIds: [b.legId] }));
      await expect(
        asTenant(tenantId, () => routesSvc.publish(route2.id, ctx)),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("requires a reason to skip a stop", async () => {
      const tenantId = await seedTenant("disp-skip");
      const driverId = await makeDriver(tenantId);
      const { routeId, stopIds } = await publishedRoute(tenantId, driverId);
      await asTenant(tenantId, () => routesSvc.start(routeId, ctx));
      const stopId = stopIds[0];
      if (stopId === undefined) {
        throw new Error("expected a stop");
      }
      await expect(
        asTenant(tenantId, () => routesSvc.resolveStop(stopId, "SKIPPED")),
      ).rejects.toMatchObject({ code: "STOP_REASON_REQUIRED" });
    });
  });

  // ── Manifest + assignment suggestions ────────────────────────────────────────

  describe("manifest + suggestions", () => {
    it("returns the driver's manifest with recipient contact and COD", async () => {
      const tenantId = await seedTenant("disp-manifest");
      const vehicleId = await makeVehicle(tenantId);
      const driverId = await makeDriver(tenantId);
      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 }, { codAmountMinor: 12500 });
      const route = await asTenant(tenantId, () =>
        routesSvc.create({ plannedDate: "2026-07-23", driverId, vehicleId }),
      );
      await asTenant(tenantId, () => routesSvc.addStops(route.id, { legIds: [a.legId] }));
      await asTenant(tenantId, () => routesSvc.publish(route.id, ctx));

      const manifest = await asTenant(tenantId, () => routesSvc.getManifest(route.id));
      expect(manifest.summary.stopsTotal).toBe(1);
      expect(manifest.summary.codExpectedMinor).toBe(12500n);
      const shipment = manifest.stops[0]?.shipments[0];
      expect(shipment?.recipientPhone).toBe("+21620987654");
      expect(shipment?.codAmountMinor).toBe(12500n);
    });

    it("suggests drivers from the on-shift assignable pool", async () => {
      const tenantId = await seedTenant("disp-suggest");
      const vehicleId = await makeVehicle(tenantId);
      const driverId = await makeDriver(tenantId);
      // Only a driver within an OPEN shift is assignable (the fleet privacy gate).
      await asTenant(tenantId, () => shiftsSvc.start({ driverId, vehicleId }));

      const a = await makeShipment(tenantId, { lat: 36.83, lng: 10.18 });
      const suggestions = await asTenant(tenantId, () =>
        assignmentSvc.suggestDrivers({ legId: a.legId }),
      );
      expect(suggestions.map((s) => s.driverId)).toContain(driverId);

      // A driver with no open shift is not suggested.
      const otherTenant = await seedTenant("disp-suggest-empty");
      const b = await makeShipment(otherTenant, { lat: 36.83, lng: 10.18 });
      const none = await asTenant(otherTenant, () =>
        assignmentSvc.suggestDrivers({ legId: b.legId }),
      );
      expect(none).toHaveLength(0);
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────────

  describe("isolation", () => {
    it("hides a route from another tenant", async () => {
      const tenantA = await seedTenant("disp-iso-a");
      const tenantB = await seedTenant("disp-iso-b");
      const route = await asTenant(tenantA, () => routesSvc.create({ plannedDate: "2026-07-23" }));
      await expect(asTenant(tenantB, () => routesSvc.getById(route.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
