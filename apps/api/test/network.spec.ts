import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { HubService } from "../src/modules/network/application/hub.service.js";
import { ZoneService } from "../src/modules/network/application/zone.service.js";
import { GeofenceService } from "../src/modules/network/application/geofence.service.js";
import { evaluateGeofences } from "../src/modules/network/domain/geofence-eval.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
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
 * Network module: hubs, zones, geofences — against a real PostgreSQL + PostGIS,
 * so RLS, GIST containment (ST_Covers), nearest-hub (<->), and geography round-
 * tripping run exactly as in production. The pure geofence crossing logic is also
 * unit-tested with no database.
 */
describe("network", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let hubs: HubService;
  let zonesSvc: ZoneService;
  let geofences: GeofenceService;
  let addresses: AddressService;
  let createdTenants: string[] = [];

  // A square around Tunis (lng 10.10–10.30, lat 36.75–36.90).
  const tunisPolygon = {
    type: "Polygon" as const,
    coordinates: [
      [
        [10.1, 36.75],
        [10.3, 36.75],
        [10.3, 36.9],
        [10.1, 36.9],
        [10.1, 36.75],
      ],
    ],
  };

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

  function hubInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      code: "TUN-01",
      name: "Tunis Sorting Center",
      type: "SORTING_CENTER",
      address: {
        rawInput: "Zone Industrielle, Tunis",
        countryCode: "TN",
        coordinates: { lat: 36.8, lng: 10.18 },
      },
      timezone: "Africa/Tunis",
      ...overrides,
    };
  }

  async function makeAddress(lat: number, lng: number): Promise<string> {
    const resolved = await addresses.resolve({
      rawInput: `pin ${lat},${lng}`,
      countryCode: "TN",
      coordinates: { lat, lng },
    });
    return resolved.addressId;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    hubs = new HubService(db, outbox, addresses);
    zonesSvc = new ZoneService(db, outbox);
    geofences = new GeofenceService(db, addresses);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Hubs ─────────────────────────────────────────────────────────────────────

  describe("hubs", () => {
    it("creates a hub, denormalises its location, and emits hub.created", async () => {
      const tenantId = await seedTenant("net-hub");
      const hub = await asTenant(tenantId, () => hubs.create(hubInput()));
      expect(hub.code).toBe("TUN-01");
      expect(hub.status).toBe("ACTIVE");
      expect(hub.latitude).toBeCloseTo(36.8, 4);
      expect(hub.longitude).toBeCloseTo(10.18, 4);
      expect(await outboxEventTypes(tenantId)).toEqual(["hub.created"]);
    });

    it("rejects a duplicate hub code within a tenant", async () => {
      const tenantId = await seedTenant("net-hub-dup");
      await asTenant(tenantId, () => hubs.create(hubInput()));
      await expect(asTenant(tenantId, () => hubs.create(hubInput()))).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it("rejects an invalid IANA timezone", async () => {
      const tenantId = await seedTenant("net-hub-tz");
      await expect(
        asTenant(tenantId, () => hubs.create(hubInput({ timezone: "Mars/Olympus" }))),
      ).rejects.toBeInstanceOf(Error);
    });

    it("deactivates and reactivates a hub", async () => {
      const tenantId = await seedTenant("net-hub-status");
      const hub = await asTenant(tenantId, () => hubs.create(hubInput()));
      const off = await asTenant(tenantId, () => hubs.deactivate(hub.id));
      expect(off.status).toBe("INACTIVE");
      const on = await asTenant(tenantId, () => hubs.activate(hub.id));
      expect(on.status).toBe("ACTIVE");
    });

    it("rejects a re-parenting that would create a cycle", async () => {
      const tenantId = await seedTenant("net-hub-cycle");
      const a = await asTenant(tenantId, () => hubs.create(hubInput({ code: "A" })));
      const b = await asTenant(tenantId, () =>
        hubs.create(hubInput({ code: "B", parentHubId: a.id })),
      );
      await expect(
        asTenant(tenantId, () => hubs.update(a.id, { parentHubId: b.id })),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("hides another tenant's hub as NotFound (RLS)", async () => {
      const tenantA = await seedTenant("net-hub-iso-a");
      const tenantB = await seedTenant("net-hub-iso-b");
      const hub = await asTenant(tenantA, () => hubs.create(hubInput()));
      await expect(asTenant(tenantB, () => hubs.getById(hub.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // ── Zones ─────────────────────────────────────────────────────────────────────

  describe("zones", () => {
    it("creates a zone and emits zone.updated", async () => {
      const tenantId = await seedTenant("net-zone");
      const zone = await asTenant(tenantId, () =>
        zonesSvc.create({ code: "TUNIS", name: "Grand Tunis", boundary: tunisPolygon }),
      );
      expect(zone.code).toBe("TUNIS");
      expect(zone.centroidLat).toBeCloseTo(36.825, 2);
      expect(await outboxEventTypes(tenantId)).toEqual(["zone.updated"]);
    });

    it("resolves which zone contains a point, and nothing outside it", async () => {
      const tenantId = await seedTenant("net-zone-contain");
      const zone = await asTenant(tenantId, () =>
        zonesSvc.create({ code: "TUNIS", name: "Grand Tunis", boundary: tunisPolygon }),
      );
      const inside = await asTenant(tenantId, () => zonesSvc.containing({ lat: 36.8, lng: 10.18 }));
      expect(inside).toBe(zone.id);
      const outside = await asTenant(tenantId, () => zonesSvc.containing({ lat: 34.0, lng: 9.0 }));
      expect(outside).toBeNull();
    });
  });

  // ── resolveForAddress ────────────────────────────────────────────────────────

  describe("resolveForAddress", () => {
    it("prefers the hub serving the address's zone over a geographically closer hub", async () => {
      const tenantId = await seedTenant("net-resolve");
      const zone = await asTenant(tenantId, () =>
        zonesSvc.create({ code: "TUNIS", name: "Grand Tunis", boundary: tunisPolygon }),
      );
      const serving = await asTenant(tenantId, () =>
        hubs.create(
          hubInput({
            code: "SERVING",
            address: { rawInput: "far", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
            serviceZoneIds: [zone.id],
          }),
        ),
      );
      // Closer to the target address, but serves no zone.
      await asTenant(tenantId, () =>
        hubs.create(
          hubInput({
            code: "CLOSER",
            address: {
              rawInput: "near",
              countryCode: "TN",
              coordinates: { lat: 36.82, lng: 10.2 },
            },
          }),
        ),
      );
      const addressId = await asTenant(tenantId, () => makeAddress(36.821, 10.201));
      const resolved = await asTenant(tenantId, () => hubs.resolveForAddress(addressId));
      expect(resolved?.id).toBe(serving.id);
    });

    it("falls back to the nearest active hub when no zone matches", async () => {
      const tenantId = await seedTenant("net-resolve-nearest");
      const hub = await asTenant(tenantId, () => hubs.create(hubInput()));
      const addressId = await asTenant(tenantId, () => makeAddress(34.0, 9.0));
      const resolved = await asTenant(tenantId, () => hubs.resolveForAddress(addressId));
      expect(resolved?.id).toBe(hub.id);
    });
  });

  // ── Geofences ──────────────────────────────────────────────────────────────────

  describe("geofences", () => {
    it("derives a HUB geofence centre from the hub and defaults its radius", async () => {
      const tenantId = await seedTenant("net-gf-hub");
      const hub = await asTenant(tenantId, () => hubs.create(hubInput()));
      const gf = await asTenant(tenantId, () =>
        geofences.create({ name: "Hub gate", kind: "HUB", hubId: hub.id }),
      );
      expect(gf.latitude).toBeCloseTo(36.8, 4);
      expect(gf.radiusM).toBe(200);
    });

    it("inherits the zone radius for a STOP geofence", async () => {
      const tenantId = await seedTenant("net-gf-stop");
      await asTenant(tenantId, () =>
        zonesSvc.create({
          code: "TUNIS",
          name: "Grand Tunis",
          boundary: tunisPolygon,
          defaultGeofenceRadiusM: 120,
        }),
      );
      const addressId = await asTenant(tenantId, () => makeAddress(36.81, 10.19));
      const gf = await asTenant(tenantId, () =>
        geofences.create({ name: "Doorstep", kind: "STOP", addressId }),
      );
      expect(gf.radiusM).toBe(120);
      expect(gf.latitude).toBeCloseTo(36.81, 4);
    });

    it("requires an explicit centre and radius for a CUSTOM geofence", async () => {
      const tenantId = await seedTenant("net-gf-custom");
      await expect(
        asTenant(tenantId, () => geofences.create({ name: "bad", kind: "CUSTOM" })),
      ).rejects.toBeInstanceOf(BusinessRuleError);
      const gf = await asTenant(tenantId, () =>
        geofences.create({
          name: "Market square",
          kind: "CUSTOM",
          centre: { lat: 36.8, lng: 10.18 },
          radiusM: 80,
        }),
      );
      expect(gf.radiusM).toBe(80);
    });

    it("loads active geofences for in-memory evaluation", async () => {
      const tenantId = await seedTenant("net-gf-load");
      await asTenant(tenantId, () =>
        geofences.create({
          name: "g",
          kind: "CUSTOM",
          centre: { lat: 36.8, lng: 10.18 },
          radiusM: 100,
        }),
      );
      const loaded = await asTenant(tenantId, () => geofences.load());
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.radiusM).toBe(100);
    });
  });

  // ── Pure evaluation (no database) ─────────────────────────────────────────────

  describe("geofence evaluation (pure)", () => {
    const fence = { id: "g1", centre: { lat: 36.8, lng: 10.18 }, radiusM: 150 };

    it("reports ENTER when a point moves inside a geofence it was outside", () => {
      const [result] = evaluateGeofences({ lat: 36.8001, lng: 10.1801 }, [fence], new Set());
      expect(result?.inside).toBe(true);
      expect(result?.transition).toBe("ENTER");
    });

    it("reports EXIT when a point moves outside a geofence it was inside", () => {
      const [result] = evaluateGeofences({ lat: 36.9, lng: 10.3 }, [fence], new Set(["g1"]));
      expect(result?.inside).toBe(false);
      expect(result?.transition).toBe("EXIT");
    });

    it("reports NONE when the in/out state is unchanged", () => {
      const [result] = evaluateGeofences({ lat: 36.9, lng: 10.3 }, [fence], new Set());
      expect(result?.transition).toBe("NONE");
    });
  });
});
