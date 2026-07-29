import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { TokenService } from "../src/modules/identity/application/token.service.js";
import type { Principal } from "../src/modules/identity/application/token.service.js";
import { permissionsForRoles } from "../src/modules/identity/domain/permissions.js";
import type { Role } from "../src/modules/identity/domain/permissions.js";
import { RealtimeGateway } from "../src/modules/tracking/realtime/realtime.gateway.js";
import { RealtimeConnection } from "../src/modules/tracking/realtime/realtime-connection.js";
import type { Socket } from "../src/modules/tracking/realtime/realtime-connection.js";
import { withinBbox } from "../src/modules/tracking/realtime/protocol.js";
import type { ServerMessage } from "../src/modules/tracking/realtime/protocol.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

const JWT_SECRET = "test-secret-that-is-at-least-32-characters-long";

/** A config stub — the real service demands a fully valid environment. */
function tokenConfig() {
  const values: Record<string, unknown> = {
    JWT_ACCESS_SECRET: JWT_SECRET,
    JWT_ACCESS_TTL_SECONDS: 900,
    DRIVER_ACCESS_TTL_SECONDS: 3_600,
    JWT_ISSUER: "delivery-platform",
    JWT_AUDIENCE: "delivery-platform",
  };
  return { get: (key: string) => values[key] } as never;
}

function testLogger(): PinoLogger {
  return { warn: () => undefined, error: () => undefined, info: () => undefined } as never;
}

/**
 * A socket that records what was written, with a settable `bufferedAmount` so
 * backpressure is asserted deterministically rather than by flooding a real one.
 */
class FakeSocket implements Socket {
  readonly sent: ServerMessage[] = [];
  bufferedAmount = 0;
  closed = false;
  closeCode: number | undefined;
  throwOnSend = false;

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error("socket is gone");
    }
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }

  ofType(op: string): ServerMessage[] {
    return this.sent.filter((m) => m.op === op);
  }
}

describe("realtime", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let tokens: TokenService;
  let gateway: RealtimeGateway;
  let valkey: Redis;
  let subscriber: Redis;
  let createdTenants: string[] = [];

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  function principalFor(tenantId: string, roles: Role[] = ["DISPATCHER"]): Principal {
    return {
      userId: randomUUID(),
      tenantId,
      actorType: "user",
      roles,
      permissions: permissionsForRoles(roles),
      hubScope: [],
      sessionId: randomUUID(),
    };
  }

  async function tokenFor(tenantId: string, roles: Role[] = ["DISPATCHER"]): Promise<string> {
    const { token } = await tokens.issueAccessToken(principalFor(tenantId, roles));
    return token;
  }

  /** A connection wired to a fake socket, bypassing the HTTP upgrade. */
  function connect(tenantId: string, socket: FakeSocket): RealtimeConnection {
    return new RealtimeConnection(principalFor(tenantId), socket);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const url = process.env["VALKEY_URL"] ?? "redis://localhost:6379";
    valkey = new Redis(url);
    subscriber = new Redis(url, { maxRetriesPerRequest: null });
    tokens = new TokenService(tokenConfig());
    gateway = new RealtimeGateway(tokens, db, valkey, subscriber, testLogger());
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    gateway.onApplicationShutdown();
    await subscriber.quit();
    await valkey.quit();
    await database.close();
  });

  // ── Viewport maths ─────────────────────────────────────────────────────────

  describe("viewport", () => {
    it("includes a point inside and excludes one outside", () => {
      const tunis: [number, number, number, number] = [10.1, 36.79, 10.28, 36.9];
      expect(withinBbox(tunis, 36.8008, 10.1817)).toBe(true);
      expect(withinBbox(tunis, 34.74, 10.76)).toBe(false);
    });

    it("includes points exactly on the boundary", () => {
      const box: [number, number, number, number] = [10, 36, 11, 37];
      expect(withinBbox(box, 36, 10)).toBe(true);
      expect(withinBbox(box, 37, 11)).toBe(true);
    });

    it("handles a viewport crossing the antimeridian", () => {
      // west > east means the box wraps ±180°. A naive comparison renders it empty.
      const wrapping: [number, number, number, number] = [170, -10, -170, 10];
      expect(withinBbox(wrapping, 0, 175)).toBe(true);
      expect(withinBbox(wrapping, 0, -175)).toBe(true);
      expect(withinBbox(wrapping, 0, 0)).toBe(false);
    });
  });

  // ── Coalescing ─────────────────────────────────────────────────────────────

  describe("coalescing", () => {
    it("emits ONE frame per flush, not one per driver", async () => {
      const tenantId = await seedTenant("rt-coalesce");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);

      for (let i = 0; i < 50; i += 1) {
        connection.offerPosition({
          driverId: randomUUID(),
          lat: 36.8 + i / 10_000,
          lon: 10.18,
          headingDeg: null,
          speedMps: null,
          batteryPct: null,
          routeId: null,
        });
      }
      connection.flush(new Date());

      const frames = socket.ofType("positions");
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ op: "positions" });
      // 50 drivers, one message — not 50.
      const frame = frames[0];
      expect(frame?.op === "positions" ? frame.drivers : []).toHaveLength(50);
    });

    it("keeps only the newest position per driver", async () => {
      const tenantId = await seedTenant("rt-newest");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);
      const driverId = randomUUID();

      for (const lat of [36.8, 36.81, 36.82]) {
        connection.offerPosition({
          driverId,
          lat,
          lon: 10.18,
          headingDeg: null,
          speedMps: null,
          batteryPct: null,
          routeId: null,
        });
      }
      connection.flush(new Date());

      const frame = socket.ofType("positions")[0];
      const drivers = frame?.op === "positions" ? frame.drivers : [];
      expect(drivers).toHaveLength(1);
      expect(drivers[0]?.lat).toBe(36.82);
    });

    it("sends nothing when there is nothing to send", async () => {
      const tenantId = await seedTenant("rt-idle");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);

      connection.flush(new Date());
      expect(socket.sent).toHaveLength(0);
    });

    it("filters positions to the subscribed viewport", async () => {
      const tenantId = await seedTenant("rt-filter");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], [10.1, 36.79, 10.28, 36.9]);

      const inside = randomUUID();
      connection.offerPosition({
        driverId: inside,
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });
      // Sfax — well outside a Tunis viewport.
      connection.offerPosition({
        driverId: randomUUID(),
        lat: 34.74,
        lon: 10.76,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });
      connection.flush(new Date());

      const frame = socket.ofType("positions")[0];
      const drivers = frame?.op === "positions" ? frame.drivers : [];
      expect(drivers).toHaveLength(1);
      expect(drivers[0]?.id).toBe(inside);
    });

    it("delivers a route-subscribed driver even when outside the viewport", async () => {
      const tenantId = await seedTenant("rt-route-channel");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      const routeId = randomUUID();
      connection.subscribe(["drivers:viewport", `route:${routeId}`], [10.1, 36.79, 10.28, 36.9]);

      connection.offerPosition({
        driverId: randomUUID(),
        lat: 34.74,
        lon: 10.76,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId,
      });
      connection.flush(new Date());

      // Watching a route means watching it wherever it goes.
      const frame = socket.ofType("positions")[0];
      expect(frame?.op === "positions" ? frame.drivers : []).toHaveLength(1);
    });

    it("ignores positions for a client subscribed to nothing", async () => {
      const tenantId = await seedTenant("rt-nosub");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);

      connection.offerPosition({
        driverId: randomUUID(),
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });
      connection.flush(new Date());
      expect(socket.sent).toHaveLength(0);
    });

    it("stops delivering after unsubscribe", async () => {
      const tenantId = await seedTenant("rt-unsub");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);
      connection.unsubscribe(["drivers:viewport"]);

      connection.offerPosition({
        driverId: randomUUID(),
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });
      connection.flush(new Date());
      expect(socket.ofType("positions")).toHaveLength(0);
    });
  });

  // ── Backpressure ───────────────────────────────────────────────────────────

  describe("backpressure", () => {
    it("drops superseded position frames when the client falls behind", async () => {
      const tenantId = await seedTenant("rt-bp-positions");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);

      socket.bufferedAmount = 8 * 1_048_576;
      connection.offerPosition({
        driverId: randomUUID(),
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });
      connection.flush(new Date());

      expect(socket.ofType("positions")).toHaveLength(0);
      expect(connection.stats().droppedFrames).toBe(1);
      // Dropped, not queued — a backlog of stale positions would make it worse.
      expect(connection.stats().pending).toBe(0);
    });

    it("NEVER drops an alert or a status change, however far behind", async () => {
      const tenantId = await seedTenant("rt-bp-events");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);

      socket.bufferedAmount = 8 * 1_048_576;
      connection.offerEvent({
        op: "alert",
        severity: "warning",
        code: "DRIVER_OFFLINE",
        driverId: randomUUID(),
      });
      connection.offerEvent({
        op: "shipment_updated",
        shipment: { id: randomUUID(), status: "DELIVERED" },
      });
      connection.offerPosition({
        driverId: randomUUID(),
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });
      connection.flush(new Date());

      // A dispatcher must still learn the delivery failed, even while the map lags.
      expect(socket.ofType("alert")).toHaveLength(1);
      expect(socket.ofType("shipment_updated")).toHaveLength(1);
      expect(socket.ofType("positions")).toHaveLength(0);
      expect(connection.stats().queuedEvents).toBe(0);
    });

    it("resumes position frames once the client catches up", async () => {
      const tenantId = await seedTenant("rt-bp-recover");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);
      const position = {
        driverId: randomUUID(),
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      };

      socket.bufferedAmount = 8 * 1_048_576;
      connection.offerPosition(position);
      connection.flush(new Date());
      expect(socket.ofType("positions")).toHaveLength(0);

      socket.bufferedAmount = 0;
      connection.offerPosition(position);
      connection.flush(new Date());
      expect(socket.ofType("positions")).toHaveLength(1);
    });

    it("treats a send failure as a closed connection, not an error", async () => {
      const tenantId = await seedTenant("rt-deadsocket");
      const socket = new FakeSocket();
      const connection = connect(tenantId, socket);
      connection.subscribe(["drivers:viewport"], undefined);

      socket.throwOnSend = true;
      connection.offerPosition({
        driverId: randomUUID(),
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });

      // One dead client must never interrupt delivery to the others.
      expect(() => {
        connection.flush(new Date());
      }).not.toThrow();
    });
  });

  // ── Handshake ──────────────────────────────────────────────────────────────

  describe("handshake", () => {
    it("accepts a valid dispatcher token", async () => {
      const tenantId = await seedTenant("rt-accept");
      const socket = new FakeSocket();

      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      expect(connection).not.toBeNull();
      expect(connection?.tenantId).toBe(tenantId);
      if (connection !== null) {
        gateway.release(connection);
      }
    });

    it("rejects a missing, malformed, or foreign-signed token", async () => {
      const tenantId = await seedTenant("rt-reject");
      const otherIssuer = new TokenService({
        get: (key: string) =>
          key === "JWT_ACCESS_SECRET"
            ? "a-completely-different-secret-at-least-32-chars"
            : key === "JWT_ACCESS_TTL_SECONDS"
              ? 900
              : key === "DRIVER_ACCESS_TTL_SECONDS"
                ? 3_600
                : "delivery-platform",
      } as never);
      const foreign = await otherIssuer.issueAccessToken(principalFor(tenantId));

      expect(await gateway.accept(new FakeSocket(), null)).toBeNull();
      expect(await gateway.accept(new FakeSocket(), "not-a-token")).toBeNull();
      expect(await gateway.accept(new FakeSocket(), foreign.token)).toBeNull();
    });

    it("rejects an authenticated caller without live-location permission", async () => {
      const tenantId = await seedTenant("rt-unentitled");
      // A driver may report their own position but not watch the whole fleet.
      const token = await tokenFor(tenantId, ["DRIVER"]);
      expect(await gateway.accept(new FakeSocket(), token)).toBeNull();
    });
  });

  // ── Subscription authorization ─────────────────────────────────────────────

  describe("subscriptions", () => {
    it("accepts the viewport channel", async () => {
      const tenantId = await seedTenant("rt-sub-viewport");
      const socket = new FakeSocket();
      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      if (connection === null) throw new Error("expected a connection");

      await gateway.handleMessage(
        connection,
        JSON.stringify({ op: "subscribe", channels: ["drivers:viewport"] }),
      );

      expect(socket.ofType("subscribed")).toHaveLength(1);
      expect(connection.isSubscribedTo("drivers:viewport")).toBe(true);
      gateway.release(connection);
    });

    it("REFUSES a route belonging to another tenant", async () => {
      const tenantId = await seedTenant("rt-sub-foreign");
      const socket = new FakeSocket();
      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      if (connection === null) throw new Error("expected a connection");

      // A socket is not a database query, so RLS never sees this. Without the
      // explicit check any dispatcher could watch another tenant by guessing.
      await gateway.handleMessage(
        connection,
        JSON.stringify({ op: "subscribe", channels: [`route:${randomUUID()}`] }),
      );

      const errors = socket.ofType("error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "SUBSCRIPTION_FORBIDDEN" });
      expect(connection.isSubscribedTo("drivers:viewport")).toBe(false);
      gateway.release(connection);
    });

    it("refuses a mixed batch rather than partially subscribing", async () => {
      const tenantId = await seedTenant("rt-sub-mixed");
      const socket = new FakeSocket();
      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      if (connection === null) throw new Error("expected a connection");

      await gateway.handleMessage(
        connection,
        JSON.stringify({
          op: "subscribe",
          channels: ["drivers:viewport", `shipment:${randomUUID()}`],
        }),
      );

      expect(socket.ofType("error")).toHaveLength(1);
      // All-or-nothing: a partially applied subscribe is a confusing half-state.
      expect(connection.isSubscribedTo("drivers:viewport")).toBe(false);
      gateway.release(connection);
    });

    it("answers ping with pong", async () => {
      const tenantId = await seedTenant("rt-ping");
      const socket = new FakeSocket();
      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      if (connection === null) throw new Error("expected a connection");

      await gateway.handleMessage(connection, JSON.stringify({ op: "ping" }));
      expect(socket.ofType("pong")).toHaveLength(1);
      gateway.release(connection);
    });

    it("rejects malformed and off-protocol frames without closing", async () => {
      const tenantId = await seedTenant("rt-badframes");
      const socket = new FakeSocket();
      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      if (connection === null) throw new Error("expected a connection");

      await gateway.handleMessage(connection, "{not json");
      await gateway.handleMessage(connection, JSON.stringify({ op: "drop_database" }));
      await gateway.handleMessage(connection, JSON.stringify({ op: "subscribe" }));
      await gateway.handleMessage(
        connection,
        JSON.stringify({ op: "subscribe", channels: ["../../etc/passwd"] }),
      );

      expect(socket.ofType("error")).toHaveLength(4);
      expect(socket.closed).toBe(false);
      gateway.release(connection);
    });
  });

  // ── Cross-instance fan-out ─────────────────────────────────────────────────

  describe("cross-instance fan-out", () => {
    it("delivers a position published on one instance to a client on another", async () => {
      const tenantId = await seedTenant("rt-crossinstance");

      // A second gateway with its own subscriber connection stands in for a
      // second API replica: the driver's ping lands on one, the dispatcher's
      // socket lives on the other.
      const otherSubscriber = new Redis(process.env["VALKEY_URL"] ?? "redis://localhost:6379", {
        maxRetriesPerRequest: null,
      });
      const otherInstance = new RealtimeGateway(tokens, db, valkey, otherSubscriber, testLogger());
      otherInstance.onModuleInit();

      try {
        const socket = new FakeSocket();
        const connection = await otherInstance.accept(socket, await tokenFor(tenantId));
        if (connection === null) throw new Error("expected a connection");
        connection.subscribe(["drivers:viewport"], undefined);

        const driverId = randomUUID();
        gateway.publishPosition(tenantId, {
          driverId,
          lat: 36.8,
          lon: 10.18,
          headingDeg: 145,
          speedMps: 5,
          batteryPct: 74,
          routeId: null,
        });

        await waitFor(() => connection.stats().pending > 0);
        connection.flush(new Date());

        const frame = socket.ofType("positions")[0];
        const drivers = frame?.op === "positions" ? frame.drivers : [];
        expect(drivers).toHaveLength(1);
        expect(drivers[0]?.id).toBe(driverId);
      } finally {
        otherInstance.onApplicationShutdown();
        await otherSubscriber.quit();
      }
    });

    it("never delivers one tenant's positions to another tenant's socket", async () => {
      const tenantA = await seedTenant("rt-fanout-a");
      const tenantB = await seedTenant("rt-fanout-b");
      const otherSubscriber = new Redis(process.env["VALKEY_URL"] ?? "redis://localhost:6379", {
        maxRetriesPerRequest: null,
      });
      const instance = new RealtimeGateway(tokens, db, valkey, otherSubscriber, testLogger());
      instance.onModuleInit();

      try {
        const socketB = new FakeSocket();
        const connectionB = await instance.accept(socketB, await tokenFor(tenantB));
        if (connectionB === null) throw new Error("expected a connection");
        connectionB.subscribe(["drivers:viewport"], undefined);

        instance.publishPosition(tenantA, {
          driverId: randomUUID(),
          lat: 36.8,
          lon: 10.18,
          headingDeg: null,
          speedMps: null,
          batteryPct: null,
          routeId: null,
        });

        await sleep(150);
        connectionB.flush(new Date());
        expect(socketB.ofType("positions")).toHaveLength(0);
      } finally {
        instance.onApplicationShutdown();
        await otherSubscriber.quit();
      }
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("releases a connection on close and stops writing to it", async () => {
      const tenantId = await seedTenant("rt-release");
      const socket = new FakeSocket();
      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      if (connection === null) throw new Error("expected a connection");
      connection.subscribe(["drivers:viewport"], undefined);

      const before = gateway.connectionCount;
      gateway.release(connection);
      expect(gateway.connectionCount).toBe(before - 1);

      connection.offerPosition({
        driverId: randomUUID(),
        lat: 36.8,
        lon: 10.18,
        headingDeg: null,
        speedMps: null,
        batteryPct: null,
        routeId: null,
      });
      connection.flush(new Date());
      expect(socket.ofType("positions")).toHaveLength(0);
    });

    it("closes every socket with 'going away' on shutdown", async () => {
      const tenantId = await seedTenant("rt-shutdown");
      const otherSubscriber = new Redis(process.env["VALKEY_URL"] ?? "redis://localhost:6379", {
        maxRetriesPerRequest: null,
      });
      const instance = new RealtimeGateway(tokens, db, valkey, otherSubscriber, testLogger());
      instance.onModuleInit();

      const socket = new FakeSocket();
      await instance.accept(socket, await tokenFor(tenantId));

      instance.onApplicationShutdown();
      expect(socket.closed).toBe(true);
      // 1001 tells the client this was a deploy, so it reconnects rather than
      // backing off as it would after an error.
      expect(socket.closeCode).toBe(1_001);
      expect(instance.connectionCount).toBe(0);
      await otherSubscriber.quit();
    });

    it("tolerates a double release", async () => {
      const tenantId = await seedTenant("rt-double-release");
      const socket = new FakeSocket();
      const connection = await gateway.accept(socket, await tokenFor(tenantId));
      if (connection === null) throw new Error("expected a connection");

      gateway.release(connection);
      expect(() => {
        gateway.release(connection);
      }).not.toThrow();
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls a condition rather than sleeping a fixed time — deterministic and fast. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await sleep(10);
  }
  throw new Error("condition was not met before the timeout");
}
