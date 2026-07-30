import { randomBytes, randomUUID } from "node:crypto";

import postgres from "postgres";
import type { Sql } from "postgres";
import { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { DriverService } from "../src/modules/fleet/application/driver.service.js";
import { ShiftService } from "../src/modules/fleet/application/shift.service.js";
import { VehicleService } from "../src/modules/fleet/application/vehicle.service.js";
import { GeofenceService } from "../src/modules/network/application/geofence.service.js";
import { HubService } from "../src/modules/network/application/hub.service.js";
import { TokenService } from "../src/modules/identity/application/token.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { RealtimeGateway } from "../src/modules/tracking/realtime/realtime.gateway.js";
import { GeofenceMonitor } from "../src/modules/tracking/telemetry/geofence-monitor.js";
import { PresenceService } from "../src/modules/tracking/telemetry/presence.service.js";
import { TelemetryService } from "../src/modules/tracking/telemetry/telemetry.service.js";
import { TelemetryWriter } from "../src/modules/tracking/telemetry/telemetry-writer.js";
import { POSITION_SOURCES } from "../src/modules/tracking/domain/dtos.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/** A config stub — the real AppConfigService demands a fully valid environment. */
function testConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    TELEMETRY_FLUSH_ROWS: 1_000,
    TELEMETRY_FLUSH_INTERVAL_MS: 50,
    TELEMETRY_BUFFER_MAX_ROWS: 50_000,
    TELEMETRY_MAX_ACCURACY_M: 200,
    TELEMETRY_PRESENCE_TTL_S: 90,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as never;
}

/** Token config for the realtime gateway telemetry publishes through. */
function tokenConfig() {
  const values: Record<string, unknown> = {
    JWT_ACCESS_SECRET: "test-secret-that-is-at-least-32-characters-long",
    JWT_ACCESS_TTL_SECONDS: 900,
    DRIVER_ACCESS_TTL_SECONDS: 3_600,
    JWT_ISSUER: "delivery-platform",
    JWT_AUDIENCE: "delivery-platform",
  };
  return { get: (key: string) => values[key] } as never;
}

/** Pino's logger requires DI context; telemetry only ever warns/errors on it. */
function testLogger(): PinoLogger {
  return {
    warn: () => undefined,
    error: () => undefined,
    info: () => undefined,
  } as unknown as PinoLogger;
}

describe("tracking", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let telemetrySql: Sql;
  let valkey: Redis;
  let realtimeSubscriber: Redis;

  let telemetry: TelemetryService;
  let writer: TelemetryWriter;
  let presence: PresenceService;
  let monitor: GeofenceMonitor;
  let shifts: ShiftService;
  let vehicles: VehicleService;
  let driversSvc: DriverService;
  let geofencesSvc: GeofenceService;

  let createdTenants: string[] = [];

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  /**
   * An ACTIVE driver on an open shift — the only state telemetry is accepted in.
   *
   * ⚠️ Returns BOTH ids, and creates the `users` row that links them. A user id
   * and a driver id are different things: ingest is called with the
   * AUTHENTICATED USER's id (that is all a request knows) and resolves the driver
   * from it, while `driver_positions.driver_id` holds the driver id.
   *
   * These tests used to pass a driver id straight into `ingestBatch`, which no
   * real request can do — and that gap hid a bug where the controller passed a
   * user id to a parameter expecting a driver id, so every upload from a real
   * driver was refused. A fixture that cannot represent the mismatch cannot catch
   * it.
   */
  async function onShiftDriver(tenantId: string): Promise<{ userId: string; driverId: string }> {
    const userId = randomUUID();
    // Tenant-scoped: `users` is FORCE RLS, and a pooled connection reused with
    // no `app.current_tenant_id` leaves the GUC at the EMPTY STRING — which is a
    // uuid cast error inside the policy, not a false predicate.
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx`
        insert into users (id, tenant_id, email, full_name, password_hash, status)
        values (${userId}, ${tenantId}, ${`d-${userId.slice(0, 8)}@trk.test`},
                'Ali Ben Salah', 'x', 'ACTIVE')
      `,
    );

    return asTenant(tenantId, async () => {
      const vehicle = await vehicles.create({
        plateNumber: `TUN-${Math.floor(Math.random() * 9000) + 1000}`,
        type: "VAN",
        capacityWeightGrams: 500_000,
        capacityVolumeCm3: 4_000_000,
        capacityParcels: 60,
      });
      const driver = await driversSvc.create({
        employeeCode: `D-${Math.random().toString(36).slice(2, 8)}`,
        fullName: "Ali Ben Salah",
        phone: `+2162${Math.floor(Math.random() * 9_000_000) + 1_000_000}`,
        employmentType: "EMPLOYEE",
        userId,
      });
      await driversSvc.activate(driver.id);
      await shifts.start({ driverId: driver.id, vehicleId: vehicle.id });
      return { userId, driverId: driver.id };
    });
  }

  /**
   * A driver with no open shift — a real, logged-in driver who is simply off
   * duty. Linked to a user for the same reason as {@link onShiftDriver}: the
   * privacy gate is reached through an authenticated user id, so a fixture with
   * no user cannot exercise it.
   */
  async function offShiftDriver(tenantId: string): Promise<{ userId: string; driverId: string }> {
    const userId = randomUUID();
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx`
        insert into users (id, tenant_id, email, full_name, password_hash, status)
        values (${userId}, ${tenantId}, ${`o-${userId.slice(0, 8)}@trk.test`},
                'Sami Trabelsi', 'x', 'ACTIVE')
      `,
    );

    return asTenant(tenantId, async () => {
      const driver = await driversSvc.create({
        employeeCode: `D-${Math.random().toString(36).slice(2, 8)}`,
        fullName: "Sami Trabelsi",
        phone: `+2162${Math.floor(Math.random() * 9_000_000) + 1_000_000}`,
        employmentType: "EMPLOYEE",
        userId,
      });
      await driversSvc.activate(driver.id);
      return { userId, driverId: driver.id };
    });
  }

  function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      shiftId: randomUUID(),
      batchId: randomUUID(),
      positions: [
        { t: new Date().toISOString(), lat: 36.8008, lon: 10.1817, acc: 8, spd: 5, hdg: 145 },
      ],
      ...overrides,
    };
  }

  function point(
    lat: number,
    lon: number,
    secondsAgo = 0,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      t: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
      lat,
      lon,
      acc: 8,
      ...extra,
    };
  }

  async function storedPositions(
    tenantId: string,
  ): Promise<
    { driver_id: string; lat: number; lon: number; battery_pct: number | null; time: Date }[]
  > {
    return withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx`
        select driver_id,
               ST_Y(location::geometry) as lat,
               ST_X(location::geometry) as lon,
               battery_pct,
               time
          from driver_positions
         where tenant_id = ${tenantId}
         order by time
      `,
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

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    telemetrySql = postgres(database.appUrl, { max: 2, prepare: false, onnotice: () => undefined });
    valkey = new Redis(process.env["VALKEY_URL"] ?? "redis://localhost:6379");

    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    const hubs = new HubService(db, outbox, addresses);
    const cipher = new FieldCipher(randomBytes(32));

    vehicles = new VehicleService(db, outbox, hubs);
    driversSvc = new DriverService(db, outbox, hubs, cipher);
    shifts = new ShiftService(db, outbox);
    geofencesSvc = new GeofenceService(db, addresses);

    writer = new TelemetryWriter(telemetrySql, testConfig(), testLogger());
    presence = new PresenceService(valkey, testConfig());
    monitor = new GeofenceMonitor(db, geofencesSvc, outbox, valkey);
    realtimeSubscriber = new Redis(process.env["VALKEY_URL"] ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
    const realtime = new RealtimeGateway(
      new TokenService(tokenConfig()),
      db,
      valkey,
      realtimeSubscriber,
      testLogger(),
    );
    telemetry = new TelemetryService(
      writer,
      presence,
      monitor,
      shifts,
      realtime,
      valkey,
      testConfig(),
    );
  }, 240_000);

  afterEach(async () => {
    // Drain first. The writer flushes on a timer, so a batch still buffered when
    // the tenant is deleted would fail its foreign key — and the noise would
    // surface as a flake in whichever test ran next.
    await writer.flush();
    await deleteTenants(database.migrator, createdTenants);
    for (const tenantId of createdTenants) {
      const keys = await valkey.keys(`tenant:${tenantId}:*`);
      if (keys.length > 0) {
        await valkey.del(...keys);
      }
    }
    createdTenants = [];
  });

  afterAll(async () => {
    await telemetrySql.end({ timeout: 5 });
    await realtimeSubscriber.quit();
    await valkey.quit();
    await database.close();
  });

  // ── The hypertable is really a hypertable ──────────────────────────────────

  describe("schema", () => {
    it("is a TimescaleDB hypertable, not a plain table", async () => {
      const rows = await database.migrator<{ hypertable_name: string }[]>`
        select hypertable_name from timescaledb_information.hypertables
         where hypertable_name = 'driver_positions'
      `;
      expect(rows).toHaveLength(1);
    });

    it("partitions by time and hashes by driver", async () => {
      const rows = await database.migrator<{ column_name: string; dimension_type: string }[]>`
        select column_name, dimension_type from timescaledb_information.dimensions
         where hypertable_name = 'driver_positions'
         order by dimension_number
      `;
      expect(rows.map((r) => `${r.column_name}:${r.dimension_type}`)).toEqual([
        "time:Time",
        "driver_id:Space",
      ]);
    });

    it("has a retention policy so storage stays bounded", async () => {
      const rows = await database.migrator<{ proc_name: string; drop_after: string }[]>`
        select proc_name, config->>'drop_after' as drop_after
          from timescaledb_information.jobs
         where hypertable_name = 'driver_positions' and proc_name = 'policy_retention'
      `;
      expect(rows[0]?.drop_after).toBe("90 days");
    });

    it("forces row-level security — telemetry is location data about people", async () => {
      const rows = await database.migrator<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        select relrowsecurity, relforcerowsecurity from pg_class
         where relname = 'driver_positions'
      `;
      expect(rows[0]?.relrowsecurity).toBe(true);
      expect(rows[0]?.relforcerowsecurity).toBe(true);
    });

    it("is append-only for the application role", async () => {
      const rows = await database.migrator<{ privilege_type: string }[]>`
        select privilege_type from information_schema.table_privileges
         where table_name = 'driver_positions' and grantee = 'dp_app'
         order by privilege_type
      `;
      const granted = rows.map((r) => r.privilege_type);
      expect(granted).toEqual(["INSERT", "SELECT"]);
      expect(granted).not.toContain("UPDATE");
      expect(granted).not.toContain("DELETE");
    });
  });

  // ── Ingest ─────────────────────────────────────────────────────────────────

  describe("ingest", () => {
    it("accepts a batch and writes it through to the hypertable", async () => {
      const tenantId = await seedTenant("trk-ingest");
      const { userId, driverId } = await onShiftDriver(tenantId);

      const result = await asTenant(tenantId, () =>
        telemetry.ingestBatch(
          batch({
            positions: [
              point(36.8008, 10.1817, 20, { bat: 74 }),
              point(36.8012, 10.182, 10, { bat: 74 }),
            ],
          }),
          { userId },
        ),
      );

      expect(result.accepted).toBe(2);
      expect(result.rejected).toBe(0);
      await writer.flush();

      const stored = await storedPositions(tenantId);
      expect(stored).toHaveLength(2);
      expect(stored[0]?.driver_id).toBe(driverId);
      // Longitude and latitude must not be transposed — ST_MakePoint takes (lon, lat).
      expect(stored[0]?.lat).toBeCloseTo(36.8008, 4);
      expect(stored[0]?.lon).toBeCloseTo(10.1817, 4);
      expect(stored[0]?.battery_pct).toBe(74);
    });

    it("preserves the device clock, not the arrival time", async () => {
      const tenantId = await seedTenant("trk-devicetime");
      const { userId } = await onShiftDriver(tenantId);
      const deviceTime = new Date(Date.now() - 45 * 60_000);

      await asTenant(tenantId, () =>
        telemetry.ingestBatch(
          batch({ positions: [{ t: deviceTime.toISOString(), lat: 36.8, lon: 10.18, acc: 6 }] }),
          { userId },
        ),
      );
      await writer.flush();

      const stored = await storedPositions(tenantId);
      expect(stored[0]?.time.getTime()).toBe(deviceTime.getTime());
    });

    it("records every source kind", async () => {
      const tenantId = await seedTenant("trk-sources");
      const { userId } = await onShiftDriver(tenantId);

      const result = await asTenant(tenantId, () =>
        telemetry.ingestBatch(
          batch({
            positions: POSITION_SOURCES.map((src, i) =>
              point(36.8 + i / 1000, 10.18, 30 - i, { src }),
            ),
          }),
          { userId },
        ),
      );
      expect(result.accepted).toBe(POSITION_SOURCES.length);
    });

    it("rejects the whole batch outside an open shift — the privacy gate", async () => {
      const tenantId = await seedTenant("trk-offshift");
      const { userId } = await offShiftDriver(tenantId);

      await expect(
        asTenant(tenantId, () => telemetry.ingestBatch(batch(), { userId })),
      ).rejects.toMatchObject({ code: "TELEMETRY_OUTSIDE_SHIFT" });

      await writer.flush();
      expect(await storedPositions(tenantId)).toHaveLength(0);
    });

    it("rejects positions whose accuracy is worse than the threshold", async () => {
      const tenantId = await seedTenant("trk-accuracy");
      const { userId } = await onShiftDriver(tenantId);

      const result = await asTenant(tenantId, () =>
        telemetry.ingestBatch(
          batch({
            positions: [
              point(36.8008, 10.1817, 20, { acc: 8 }),
              // A 500 m fix would drag the marker across town.
              point(36.8008, 10.1817, 10, { acc: 500 }),
            ],
          }),
          { userId },
        ),
      );

      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(1);
      expect(result.rejections.POOR_ACCURACY).toBe(1);
    });

    it("rejects a position stamped far in the future", async () => {
      const tenantId = await seedTenant("trk-skew");
      const { userId } = await onShiftDriver(tenantId);

      const result = await asTenant(tenantId, () =>
        telemetry.ingestBatch(
          batch({
            positions: [
              point(36.8, 10.18, 10),
              { t: new Date(Date.now() + 3 * 3600_000).toISOString(), lat: 36.8, lon: 10.18 },
            ],
          }),
          { userId },
        ),
      );

      expect(result.accepted).toBe(1);
      expect(result.rejections.FUTURE_TIMESTAMP).toBe(1);
    });

    it("is idempotent when the driver app replays a batch", async () => {
      const tenantId = await seedTenant("trk-replay");
      const { userId } = await onShiftDriver(tenantId);
      const payload = batch({
        positions: [point(36.8, 10.18, 20), point(36.801, 10.181, 10)],
      });

      const first = await asTenant(tenantId, () => telemetry.ingestBatch(payload, { userId }));
      const replay = await asTenant(tenantId, () => telemetry.ingestBatch(payload, { userId }));
      await writer.flush();

      expect(first.accepted).toBe(2);
      expect(replay.accepted).toBe(2);
      // The replay must not have produced a second set of rows.
      expect(await storedPositions(tenantId)).toHaveLength(2);
    });

    it("rejects invalid coordinates and unknown fields", async () => {
      const tenantId = await seedTenant("trk-validation");
      const { userId } = await onShiftDriver(tenantId);

      for (const positions of [
        [{ t: new Date().toISOString(), lat: 91, lon: 10 }],
        [{ t: new Date().toISOString(), lat: 36.8, lon: 181 }],
        [{ t: new Date().toISOString(), lat: 36.8, lon: 10.18, hdg: 360 }],
        [{ t: new Date().toISOString(), lat: 36.8, lon: 10.18, bat: 101 }],
        [{ t: new Date().toISOString(), lat: 36.8, lon: 10.18, altitude: 12 }],
      ]) {
        await expect(
          asTenant(tenantId, () => telemetry.ingestBatch(batch({ positions }), { userId })),
        ).rejects.toThrow();
      }
    });

    it("rejects an empty batch and one over 1000 positions", async () => {
      const tenantId = await seedTenant("trk-bounds");
      const { userId } = await onShiftDriver(tenantId);

      await expect(
        asTenant(tenantId, () => telemetry.ingestBatch(batch({ positions: [] }), { userId })),
      ).rejects.toThrow();
      await expect(
        asTenant(tenantId, () =>
          telemetry.ingestBatch(
            batch({ positions: Array.from({ length: 1_001 }, () => point(36.8, 10.18)) }),
            { userId },
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ── The writer ─────────────────────────────────────────────────────────────

  describe("batched writer", () => {
    it("flushes when the row threshold is reached, without waiting for the timer", async () => {
      const tenantId = await seedTenant("trk-flush-rows");
      const { driverId } = await onShiftDriver(tenantId);
      const eager = new TelemetryWriter(
        telemetrySql,
        testConfig({ TELEMETRY_FLUSH_ROWS: 3, TELEMETRY_FLUSH_INTERVAL_MS: 600_000 }),
        testLogger(),
      );

      eager.enqueue(
        Array.from({ length: 3 }, (_, i) => ({
          tenantId,
          driverId,
          routeId: null,
          time: new Date(Date.now() - i * 1_000),
          lat: 36.8,
          lon: 10.18,
          speedMps: null,
          headingDeg: null,
          accuracyM: null,
          batteryPct: null,
          isMoving: null,
          source: null,
        })),
      );
      await eager.flush();

      expect(await storedPositions(tenantId)).toHaveLength(3);
      expect(eager.stats().written).toBe(3);
    });

    it("sheds oldest rows rather than growing without bound", async () => {
      const tenantId = await seedTenant("trk-shed");
      const bounded = new TelemetryWriter(
        telemetrySql,
        testConfig({ TELEMETRY_BUFFER_MAX_ROWS: 5, TELEMETRY_FLUSH_ROWS: 1_000_000 }),
        testLogger(),
      );

      const rows = Array.from({ length: 8 }, (_, i) => ({
        tenantId,
        driverId: randomUUID(),
        routeId: null,
        time: new Date(Date.now() - (8 - i) * 1_000),
        lat: 36.8,
        lon: 10.18,
        speedMps: null,
        headingDeg: null,
        accuracyM: null,
        batteryPct: null,
        isMoving: null,
        source: null,
      }));
      const { shed } = bounded.enqueue(rows);

      expect(shed).toBe(3);
      expect(bounded.stats().buffered).toBe(5);
      expect(bounded.stats().dropped).toBe(3);
    });

    it("drains the buffer on shutdown rather than losing the last second", async () => {
      const tenantId = await seedTenant("trk-shutdown");
      const { driverId } = await onShiftDriver(tenantId);
      const lazy = new TelemetryWriter(
        telemetrySql,
        testConfig({ TELEMETRY_FLUSH_ROWS: 1_000_000, TELEMETRY_FLUSH_INTERVAL_MS: 600_000 }),
        testLogger(),
      );

      lazy.enqueue([
        {
          tenantId,
          driverId,
          routeId: null,
          time: new Date(),
          lat: 36.8,
          lon: 10.18,
          speedMps: null,
          headingDeg: null,
          accuracyM: null,
          batteryPct: null,
          isMoving: null,
          source: null,
        },
      ]);
      expect(await storedPositions(tenantId)).toHaveLength(0);

      await lazy.onApplicationShutdown();
      expect(await storedPositions(tenantId)).toHaveLength(1);
    });

    it("flush() does not return while rows enqueued mid-flush are still buffered", async () => {
      const tenantId = await seedTenant("trk-midflush");
      const { driverId } = await onShiftDriver(tenantId);

      const lazy = new TelemetryWriter(
        telemetrySql,
        testConfig({ TELEMETRY_FLUSH_ROWS: 1_000_000, TELEMETRY_FLUSH_INTERVAL_MS: 600_000 }),
        testLogger(),
      );

      const position = (lat: number) => ({
        tenantId,
        driverId,
        routeId: null,
        time: new Date(),
        lat,
        lon: 10.18,
        speedMps: null,
        headingDeg: null,
        accuracyM: null,
        batteryPct: null,
        isMoving: null,
        source: null,
      });

      lazy.enqueue([position(36.8)]);

      // Start a flush; its drain has already taken the buffer.
      const first = lazy.flush();
      // This row therefore belongs to the NEXT batch.
      lazy.enqueue([position(36.81)]);
      // Second call arrives WHILE the first is still in flight — the shape a
      // shutdown takes when a timer-driven flush is already running. It must
      // not simply await the in-flight one and report success.
      const second = lazy.flush();

      await Promise.all([first, second]);

      // Both awaited flushes have resolved, so nothing may remain in memory.
      expect(lazy.stats().buffered).toBe(0);
      expect(await storedPositions(tenantId)).toHaveLength(2);
    });

    /**
     * ⚠️ The other half of the same bug, and awaiting BOTH flushes above hides it.
     *
     * Two flushers is the ordinary case: the interval timer plus a caller. When
     * the first one's write settles, both loops resume in the same microtask
     * batch. The timer's goes first, synchronously takes the whole buffer for its
     * next write and suspends — so when the CALLER's loop resumes it sees an empty
     * buffer and, before the fix, returned. Those rows were still in flight.
     *
     * This asserts on the second flush ALONE, which is what a caller actually
     * relies on. `onApplicationShutdown` awaits exactly this promise and then the
     * process exits, so returning early discards the last positions of every
     * driver's trail — the precise failure this class exists to prevent, and it
     * survived the first attempt at fixing it.
     */
    it("flush() does not return while ANOTHER flush is still writing", async () => {
      const tenantId = await seedTenant("trk-concurrent-flush");
      const { driverId } = await onShiftDriver(tenantId);

      const lazy = new TelemetryWriter(
        telemetrySql,
        testConfig({ TELEMETRY_FLUSH_ROWS: 1_000_000, TELEMETRY_FLUSH_INTERVAL_MS: 600_000 }),
        testLogger(),
      );

      const position = (lat: number) => ({
        tenantId,
        driverId,
        routeId: null,
        time: new Date(),
        lat,
        lon: 10.18,
        speedMps: null,
        headingDeg: null,
        accuracyM: null,
        batteryPct: null,
        isMoving: null,
        source: null,
      });

      lazy.enqueue([position(36.8)]);
      // Flusher one — stands in for the interval timer, deliberately not awaited.
      const timerFlush = lazy.flush();
      lazy.enqueue([position(36.81)]);

      // The caller. Awaiting ONLY this is the whole point: a caller has no handle
      // on the timer's promise, so this one must be sufficient on its own.
      await lazy.flush();

      expect(lazy.stats().buffered).toBe(0);
      expect(lazy.stats().written).toBe(2);
      expect(await storedPositions(tenantId)).toHaveLength(2);

      // Settled afterwards purely so the run has no dangling promise.
      await timerFlush;
    });

    it("writes each tenant's rows under its own tenant, never mixed", async () => {
      const tenantA = await seedTenant("trk-mix-a");
      const tenantB = await seedTenant("trk-mix-b");
      const { driverId: driverA } = await onShiftDriver(tenantA);
      const { driverId: driverB } = await onShiftDriver(tenantB);

      // The buffer is process-wide and holds many tenants at once. This is the
      // one structure in the codebase where that is true, so it is tested.
      writer.enqueue([
        {
          tenantId: tenantA,
          driverId: driverA,
          routeId: null,
          time: new Date(),
          lat: 36.8,
          lon: 10.18,
          speedMps: null,
          headingDeg: null,
          accuracyM: null,
          batteryPct: null,
          isMoving: null,
          source: null,
        },
        {
          tenantId: tenantB,
          driverId: driverB,
          routeId: null,
          time: new Date(),
          lat: 34.74,
          lon: 10.76,
          speedMps: null,
          headingDeg: null,
          accuracyM: null,
          batteryPct: null,
          isMoving: null,
          source: null,
        },
      ]);
      await writer.flush();

      const a = await storedPositions(tenantA);
      const b = await storedPositions(tenantB);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]?.driver_id).toBe(driverA);
      expect(b[0]?.driver_id).toBe(driverB);
    });

    it("never throws out of enqueue, even with nothing to write", () => {
      expect(() => writer.enqueue([])).not.toThrow();
      expect(writer.enqueue([]).shed).toBe(0);
    });

    it("contains a failing tenant's batch without losing another tenant's rows", async () => {
      const good = await seedTenant("trk-isolate-good");
      const { driverId } = await onShiftDriver(good);
      const isolated = new TelemetryWriter(
        telemetrySql,
        testConfig({ TELEMETRY_FLUSH_ROWS: 1_000_000, TELEMETRY_FLUSH_INTERVAL_MS: 600_000 }),
        testLogger(),
      );

      const row = (tenantId: string, driver: string) => ({
        tenantId,
        driverId: driver,
        routeId: null,
        time: new Date(),
        lat: 36.8,
        lon: 10.18,
        speedMps: null,
        headingDeg: null,
        accuracyM: null,
        batteryPct: null,
        isMoving: null,
        source: null,
      });

      // A tenant id that does not exist violates the foreign key. In a shared
      // buffer, one bad tenant must not take out everyone else's positions.
      isolated.enqueue([row(randomUUID(), randomUUID()), row(good, driverId)]);
      await isolated.flush();

      expect(await storedPositions(good)).toHaveLength(1);
      expect(isolated.stats().failedFlushes).toBe(1);
      expect(isolated.stats().written).toBe(1);
    });

    it("never throws a flush failure at the caller", async () => {
      const orphan = new TelemetryWriter(
        telemetrySql,
        testConfig({ TELEMETRY_FLUSH_ROWS: 1_000_000, TELEMETRY_FLUSH_INTERVAL_MS: 600_000 }),
        testLogger(),
      );
      orphan.enqueue([
        {
          tenantId: randomUUID(),
          driverId: randomUUID(),
          routeId: null,
          time: new Date(),
          lat: 36.8,
          lon: 10.18,
          speedMps: null,
          headingDeg: null,
          accuracyM: null,
          batteryPct: null,
          isMoving: null,
          source: null,
        },
      ]);

      // The request returned 202 long ago; a database hiccup is logged and
      // counted, never thrown into a driver's phone.
      await expect(orphan.flush()).resolves.toBeUndefined();
      expect(orphan.stats().failedFlushes).toBe(1);
    });
  });

  // ── Presence ───────────────────────────────────────────────────────────────

  describe("presence", () => {
    it("records and reads a driver's last-known position", async () => {
      const tenantId = await seedTenant("trk-presence");
      const { driverId } = await onShiftDriver(tenantId);
      const at = new Date();

      await presence.record(tenantId, {
        driverId,
        lat: 36.8622,
        lon: 10.1953,
        headingDeg: 148,
        speedMps: 5.1,
        batteryPct: 74,
        at,
      });

      const last = await presence.lastKnown(tenantId, driverId);
      expect(last?.lat).toBeCloseTo(36.8622, 4);
      expect(last?.lon).toBeCloseTo(10.1953, 4);
      expect(last?.headingDeg).toBe(148);
      expect(last?.at.getTime()).toBe(at.getTime());
    });

    it("lists online drivers without scanning the keyspace", async () => {
      const tenantId = await seedTenant("trk-online");
      const { driverId: first } = await onShiftDriver(tenantId);
      const { driverId: second } = await onShiftDriver(tenantId);

      for (const driverId of [first, second]) {
        await presence.record(tenantId, {
          driverId,
          lat: 36.8,
          lon: 10.18,
          headingDeg: null,
          speedMps: null,
          batteryPct: null,
          at: new Date(),
        });
      }

      const online = await presence.onlineDrivers(tenantId);
      expect(new Set(online)).toEqual(new Set([first, second]));
    });

    it("treats a driver last seen beyond the TTL as offline", async () => {
      const tenantId = await seedTenant("trk-stale");
      const { driverId } = await onShiftDriver(tenantId);

      await presence.record(tenantId, {
        driverId,
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        at: new Date(Date.now() - 10 * 60_000),
      });

      // Expiry IS the offline signal — the index is trimmed on read.
      expect(await presence.onlineDrivers(tenantId)).not.toContain(driverId);
    });

    it("reads many positions in one round trip", async () => {
      const tenantId = await seedTenant("trk-mget");
      const drivers = (await Promise.all([onShiftDriver(tenantId), onShiftDriver(tenantId)])).map(
        (d) => d.driverId,
      );
      for (const driverId of drivers) {
        await presence.record(tenantId, {
          driverId,
          lat: 36.8,
          lon: 10.18,
          headingDeg: null,
          speedMps: null,
          batteryPct: null,
          at: new Date(),
        });
      }

      const positions = await presence.lastKnownMany(tenantId, [...drivers, randomUUID()]);
      // The unknown driver is simply absent, not an error.
      expect(positions).toHaveLength(2);
    });

    it("returns null for an unknown driver and survives a corrupt entry", async () => {
      const tenantId = await seedTenant("trk-corrupt");
      expect(await presence.lastKnown(tenantId, randomUUID())).toBeNull();

      const driverId = randomUUID();
      await valkey.set(`tenant:${tenantId}:driver:${driverId}:pos`, "{not json");
      // A malformed cache entry must degrade to "offline", never crash the board.
      expect(await presence.lastKnown(tenantId, driverId)).toBeNull();
    });

    it("clears presence when a shift ends", async () => {
      const tenantId = await seedTenant("trk-clear");
      const { driverId } = await onShiftDriver(tenantId);
      await presence.record(tenantId, {
        driverId,
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        at: new Date(),
      });

      await asTenant(tenantId, () => telemetry.clearPresence(driverId));
      expect(await presence.lastKnown(tenantId, driverId)).toBeNull();
      expect(await presence.onlineDrivers(tenantId)).not.toContain(driverId);
    });

    it("keeps one tenant's presence invisible to another", async () => {
      const tenantA = await seedTenant("trk-pres-iso-a");
      const tenantB = await seedTenant("trk-pres-iso-b");
      const { driverId } = await onShiftDriver(tenantA);

      await presence.record(tenantA, {
        driverId,
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        at: new Date(),
      });

      expect(await presence.lastKnown(tenantB, driverId)).toBeNull();
      expect(await presence.onlineDrivers(tenantB)).toHaveLength(0);
    });
  });

  // ── The telemetry/business plane boundary ──────────────────────────────────

  describe("plane separation", () => {
    it("publishes NO business event for ordinary positions", async () => {
      const tenantId = await seedTenant("trk-noevents");
      const { userId } = await onShiftDriver(tenantId);

      // ⚠️ Drain first. The writer is SHARED across this file and its buffer is
      // bounded — rows left by an earlier test count towards the high-water mark,
      // and past it `enqueue` sheds the OLDEST, which under load meant one of
      // this test's own positions. That is correct writer behaviour and a broken
      // test: the coupling is what has to go, not the shedding.
      await writer.flush();
      const droppedBefore = writer.stats().dropped;
      const failedBefore = writer.stats().failedFlushes;

      // docs/03 §2.4: a GPS ping is not a business event. Raw telemetry must
      // never reach the outbox — it would swamp every consumer.
      for (let i = 0; i < 20; i += 1) {
        await asTenant(tenantId, () =>
          telemetry.ingestBatch(batch({ positions: [point(36.8 + i / 10_000, 10.18, 60 - i)] }), {
            userId,
          }),
        );
      }
      await writer.flush();

      // Both counters asserted BEFORE the row count, and neither is decoration.
      // The writer legitimately loses rows two ways — a failed insert is dropped
      // rather than re-buffered, and a full buffer sheds the oldest — so an
      // off-by-one here has two possible causes. Checking them first means each
      // reports itself by name instead of as an inexplicable 19-of-20.
      expect(writer.stats().failedFlushes).toBe(failedBefore);
      expect(writer.stats().dropped).toBe(droppedBefore);
      expect(await storedPositions(tenantId)).toHaveLength(20);

      // The actual subject of this test: raw telemetry must never reach the
      // outbox (docs/03 §2.4) — it would swamp every consumer at 170:1.
      const events = await outboxEventTypes(tenantId);
      expect(events.filter((e) => e.startsWith("shipment."))).toHaveLength(0);
      expect(events).not.toContain("driver.location_updated");
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("hides one tenant's positions from another", async () => {
      const tenantA = await seedTenant("trk-iso-a");
      const tenantB = await seedTenant("trk-iso-b");
      const { userId: userA } = await onShiftDriver(tenantA);

      await asTenant(tenantA, () =>
        telemetry.ingestBatch(batch({ positions: [point(36.8, 10.18, 5)] }), {
          userId: userA,
        }),
      );
      await writer.flush();

      expect(await storedPositions(tenantA)).toHaveLength(1);
      // RLS is FORCEd, so even the owning role sees nothing under B's context.
      const underB = await withTenantContext(
        database.migrator,
        tenantB,
        (tx) => tx<{ n: number }[]>`select count(*)::int as n from driver_positions`,
      );
      expect(underB[0]?.n).toBe(0);
    });

    it("refuses an update or delete even from the application role", async () => {
      const tenantId = await seedTenant("trk-append-only");
      const { userId } = await onShiftDriver(tenantId);
      await asTenant(tenantId, () =>
        telemetry.ingestBatch(batch({ positions: [point(36.8, 10.18, 5)] }), { userId }),
      );
      await writer.flush();

      // Append-only is enforced by grants, not by convention.
      await expect(
        telemetrySql.begin(async (tx) => {
          await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
          await tx`update driver_positions set battery_pct = 1 where tenant_id = ${tenantId}`;
        }),
      ).rejects.toThrow(/permission denied/iu);

      await expect(
        telemetrySql.begin(async (tx) => {
          await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
          await tx`delete from driver_positions where tenant_id = ${tenantId}`;
        }),
      ).rejects.toThrow(/permission denied/iu);
    });
  });
});
