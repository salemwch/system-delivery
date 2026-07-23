import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { VehicleService } from "../src/modules/fleet/application/vehicle.service.js";
import { DriverService } from "../src/modules/fleet/application/driver.service.js";
import { ShiftService } from "../src/modules/fleet/application/shift.service.js";
import { HubService } from "../src/modules/network/application/hub.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, ConflictError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Fleet module: vehicles, drivers (with encrypted PII), shifts (the privacy gate)
 * — against real PostgreSQL, so RLS, the partial one-open-shift unique indexes,
 * and PII-at-rest all run as in production.
 */
describe("fleet", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let vehicles: VehicleService;
  let driversSvc: DriverService;
  let shiftsSvc: ShiftService;
  let createdTenants: string[] = [];

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

  function vehicleInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      plateNumber: "TUN-1234",
      type: "VAN",
      capacityWeightGrams: 500_000,
      capacityVolumeCm3: 4_000_000,
      capacityParcels: 60,
      ...overrides,
    };
  }

  function driverInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      employeeCode: "D-001",
      fullName: "Ali Ben Salah",
      phone: "+21620111222",
      employmentType: "EMPLOYEE",
      ...overrides,
    };
  }

  /** Creates an ACTIVE driver + ACTIVE vehicle, returns their ids. */
  async function activeDriverAndVehicle(
    tenantId: string,
    driverOverrides: Record<string, unknown> = {},
  ): Promise<{ driverId: string; vehicleId: string }> {
    return asTenant(tenantId, async () => {
      const vehicle = await vehicles.create(vehicleInput());
      const driver = await driversSvc.create(driverInput(driverOverrides));
      await driversSvc.activate(driver.id);
      return { driverId: driver.id, vehicleId: vehicle.id };
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    const hubs = new HubService(db, outbox, addresses);
    const cipher = new FieldCipher(randomBytes(32));
    vehicles = new VehicleService(db, outbox, hubs);
    driversSvc = new DriverService(db, outbox, hubs, cipher);
    shiftsSvc = new ShiftService(db, outbox);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Vehicles ─────────────────────────────────────────────────────────────────

  describe("vehicles", () => {
    it("creates a vehicle and reports its capacity", async () => {
      const tenantId = await seedTenant("fleet-veh");
      const vehicle = await asTenant(tenantId, () => vehicles.create(vehicleInput()));
      expect(vehicle.status).toBe("ACTIVE");
      const capacity = await asTenant(tenantId, () => vehicles.capacityOf(vehicle.id));
      expect(capacity).toEqual({ weightGrams: 500_000, volumeCm3: 4_000_000, parcels: 60 });
    });

    it("rejects a duplicate plate within a tenant", async () => {
      const tenantId = await seedTenant("fleet-veh-dup");
      await asTenant(tenantId, () => vehicles.create(vehicleInput()));
      await expect(
        asTenant(tenantId, () => vehicles.create(vehicleInput())),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("emits vehicle.status_changed on a status change", async () => {
      const tenantId = await seedTenant("fleet-veh-status");
      const vehicle = await asTenant(tenantId, () => vehicles.create(vehicleInput()));
      const updated = await asTenant(tenantId, () => vehicles.setStatus(vehicle.id, "MAINTENANCE"));
      expect(updated.status).toBe("MAINTENANCE");
      expect(await outboxEventTypes(tenantId)).toContain("vehicle.status_changed");
    });
  });

  // ── Drivers ───────────────────────────────────────────────────────────────────

  describe("drivers", () => {
    it("creates a driver, emits driver.created, and encrypts PII at rest", async () => {
      const tenantId = await seedTenant("fleet-drv");
      const driver = await asTenant(tenantId, () =>
        driversSvc.create(driverInput({ nationalId: "09876543" })),
      );
      expect(driver.status).toBe("PENDING");
      expect(driver.hasNationalId).toBe(true);
      // The view carries no plaintext PII.
      expect(JSON.stringify(driver)).not.toContain("09876543");
      expect(await outboxEventTypes(tenantId)).toEqual(["driver.created"]);

      // The stored column is ciphertext, never the plaintext.
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) =>
          tx<
            { national_id_encrypted: string | null }[]
          >`select national_id_encrypted from drivers where id = ${driver.id}`,
      );
      expect(rows[0]?.national_id_encrypted).toMatch(/^v1:/);
      expect(rows[0]?.national_id_encrypted).not.toContain("09876543");

      const revealed = await asTenant(tenantId, () => driversSvc.revealPii(driver.id));
      expect(revealed.nationalId).toBe("09876543");
    });

    it("rejects a duplicate employee code and a duplicate phone", async () => {
      const tenantId = await seedTenant("fleet-drv-dup");
      await asTenant(tenantId, () => driversSvc.create(driverInput()));
      await expect(
        asTenant(tenantId, () => driversSvc.create(driverInput({ phone: "+21620999888" }))),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        asTenant(tenantId, () => driversSvc.create(driverInput({ employeeCode: "D-002" }))),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  // ── Shifts (the privacy gate) ──────────────────────────────────────────────────

  describe("shifts", () => {
    it("starts a shift and emits driver.shift_started", async () => {
      const tenantId = await seedTenant("fleet-shift");
      const { driverId, vehicleId } = await activeDriverAndVehicle(tenantId);
      const shift = await asTenant(tenantId, () => shiftsSvc.start({ driverId, vehicleId }));
      expect(shift.status).toBe("OPEN");
      expect(await outboxEventTypes(tenantId)).toContain("driver.shift_started");
    });

    it("allows at most one open shift per driver", async () => {
      const tenantId = await seedTenant("fleet-shift-driver");
      const { driverId, vehicleId } = await activeDriverAndVehicle(tenantId);
      const other = await asTenant(tenantId, () =>
        vehicles.create(vehicleInput({ plateNumber: "TUN-5678" })),
      );
      await asTenant(tenantId, () => shiftsSvc.start({ driverId, vehicleId }));
      await expect(
        asTenant(tenantId, () => shiftsSvc.start({ driverId, vehicleId: other.id })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows at most one open shift per vehicle", async () => {
      const tenantId = await seedTenant("fleet-shift-vehicle");
      const { driverId, vehicleId } = await activeDriverAndVehicle(tenantId);
      const driver2 = await asTenant(tenantId, async () => {
        const d = await driversSvc.create(
          driverInput({ employeeCode: "D-002", phone: "+21620333444" }),
        );
        await driversSvc.activate(d.id);
        return d.id;
      });
      await asTenant(tenantId, () => shiftsSvc.start({ driverId, vehicleId }));
      await expect(
        asTenant(tenantId, () => shiftsSvc.start({ driverId: driver2, vehicleId })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("refuses to start a shift for a non-active driver", async () => {
      const tenantId = await seedTenant("fleet-shift-inactive");
      const vehicle = await asTenant(tenantId, () => vehicles.create(vehicleInput()));
      const driver = await asTenant(tenantId, () => driversSvc.create(driverInput())); // PENDING
      await expect(
        asTenant(tenantId, () => shiftsSvc.start({ driverId: driver.id, vehicleId: vehicle.id })),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("gates location by open shift, including offline points inside a closed window", async () => {
      const tenantId = await seedTenant("fleet-gate");
      const { driverId, vehicleId } = await activeDriverAndVehicle(tenantId);
      const shift = await asTenant(tenantId, () => shiftsSvc.start({ driverId, vehicleId }));

      const now = new Date();
      expect(await asTenant(tenantId, () => shiftsSvc.isWithinOpenShift(driverId, now))).toBe(true);

      await asTenant(tenantId, () => shiftsSvc.end(shift.id, {}));
      // A point captured during the shift but synced after it closed is still valid.
      expect(await asTenant(tenantId, () => shiftsSvc.isWithinOpenShift(driverId, now))).toBe(true);
      // A point far in the future (after the shift ended) is rejected.
      const later = new Date(Date.now() + 3_600_000);
      expect(await asTenant(tenantId, () => shiftsSvc.isWithinOpenShift(driverId, later))).toBe(
        false,
      );
      expect(await outboxEventTypes(tenantId)).toContain("driver.shift_ended");
    });
  });

  // ── listAvailable ───────────────────────────────────────────────────────────────

  describe("listAvailable", () => {
    it("returns ACTIVE drivers on an open shift matching required skills", async () => {
      const tenantId = await seedTenant("fleet-avail");
      const { driverId, vehicleId } = await activeDriverAndVehicle(tenantId, {
        skills: ["REFRIGERATED"],
      });
      // A second active driver with no open shift must NOT appear.
      await asTenant(tenantId, async () => {
        const d = await driversSvc.create(
          driverInput({ employeeCode: "D-009", phone: "+21620777666" }),
        );
        await driversSvc.activate(d.id);
      });
      await asTenant(tenantId, () => shiftsSvc.start({ driverId, vehicleId }));

      const available = await asTenant(tenantId, () =>
        driversSvc.listAvailable({ skills: ["REFRIGERATED"] }),
      );
      expect(available.map((d) => d.id)).toEqual([driverId]);

      const none = await asTenant(tenantId, () => driversSvc.listAvailable({ skills: ["HAZMAT"] }));
      expect(none).toHaveLength(0);
    });
  });
});
