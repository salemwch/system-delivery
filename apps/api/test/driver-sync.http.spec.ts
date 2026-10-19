import { randomBytes, randomUUID } from "node:crypto";

import { Module } from "@nestjs/common";
import type { InjectionToken, Provider } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { sql } from "drizzle-orm";
import { PinoLogger } from "nestjs-pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AddressCorrectionService } from "../src/modules/directory/application/address-correction.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { DriverSyncController } from "../src/modules/dispatch/api/driver-sync.controller.js";
import { RouteController } from "../src/modules/dispatch/api/route.controller.js";
import { AssignmentService } from "../src/modules/dispatch/application/assignment.service.js";
import { DistributionNoteService } from "../src/modules/dispatch/application/distribution-note.service.js";
import { DriverSyncService } from "../src/modules/dispatch/application/driver-sync.service.js";
import { HeuristicOptimizationProvider } from "../src/modules/dispatch/application/optimization.provider.js";
import { RouteService } from "../src/modules/dispatch/application/route.service.js";
import { DriverService } from "../src/modules/fleet/application/driver.service.js";
import { VehicleService } from "../src/modules/fleet/application/vehicle.service.js";
import { AuthController } from "../src/modules/identity/api/auth.controller.js";
import { AuthGuard } from "../src/modules/identity/api/auth.guard.js";
import { PermissionGuard } from "../src/modules/identity/api/permission.guard.js";
import { TenantContextInterceptor } from "../src/modules/identity/api/tenant-context.interceptor.js";
import { AccessService } from "../src/modules/identity/application/access.service.js";
import { AuthService } from "../src/modules/identity/application/auth.service.js";
import { MfaService } from "../src/modules/identity/application/mfa.service.js";
import { OtpService } from "../src/modules/identity/application/otp.service.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { TokenService } from "../src/modules/identity/application/token.service.js";
import { HubService } from "../src/modules/network/application/hub.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { FEATURE_KEYS } from "../src/modules/platform/domain/feature-keys.js";
import { NOTIFICATION_PROVIDER } from "../src/modules/platform/domain/notification-provider.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { AppConfigService } from "../src/shared/config/index.js";
import { FIELD_CIPHER } from "../src/shared/crypto/crypto.tokens.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { POSTGRES_CLIENT } from "../src/shared/database/database.tokens.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import type { TenantId } from "../src/shared/database/tenant-context.js";
import {
  ProblemDetailsFilter,
  UuidParamPipe,
  createFastifyAdapter,
} from "../src/shared/http/index.js";
import { CurrencyService } from "../src/shared/money/index.js";
import { CapturingNotificationProvider } from "./auth.factory.js";
import { stubConfig } from "./config.stub.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * The driver app's offline sync over HTTP (docs/05 §5, docs/08 §8.1): real
 * login → guards → driver RLS → the same commands as the online routes.
 */
describe("driver sync over HTTP", () => {
  let database: TestDatabase;
  let app: NestFastifyApplication;
  let tenant: TenantId;
  let shipments: ShipmentService;
  let routes: RouteService;
  let vehicles: VehicleService;
  let db: DatabaseService;

  const PASSWORD = `pw-${randomBytes(18).toString("hex")}`;
  const staff: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };
  const strongPod = { podType: "id_check", recipientName: "R" };

  interface Account {
    readonly email: string;
    readonly userId: string;
    readonly driverId: string | null;
  }

  async function seedAccount(roles: string[], withDriver: boolean): Promise<Account> {
    const email = `u-${randomUUID().slice(0, 8)}@sync.tn`;
    const hash = await new PasswordService().hash(PASSWORD);
    return database.migrator.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenant}, true)`;
      const users = await tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status)
        values (${tenant}, ${email}, ${hash}, 'Sync', 'ACTIVE') returning id`;
      const user = users[0];
      if (user === undefined) throw new Error("seed failed");
      for (const role of roles) {
        await tx`insert into user_roles (tenant_id, user_id, role) values (${tenant}, ${user.id}, ${role})`;
      }
      let driverId: string | null = null;
      if (withDriver) {
        const drivers = await tx<{ id: string }[]>`
          insert into drivers (tenant_id, user_id, employee_code, full_name, phone, status, employment_type)
          values (${tenant}, ${user.id}, ${`D-${randomUUID().slice(0, 6)}`}, 'Driver',
                  ${`+2162${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`},
                  'ACTIVE', 'EMPLOYEE')
          returning id`;
        driverId = drivers[0]?.id ?? null;
      }
      return { email, userId: user.id, driverId };
    });
  }

  async function login(account: Account): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { tenantId: tenant, email: account.email, password: PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (JSON.parse(response.body) as { accessToken: string }).accessToken;
  }

  function call(method: "GET" | "POST", url: string, token: string, payload?: object) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: { ...payload } }),
    });
  }

  function asStaff<T>(fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: tenant, actorType: "system" }, fn);
  }

  /** A parcel out for delivery with `driverId`; returns it and its destination. */
  async function outForDelivery(driverId: string): Promise<{ id: string; destination: string }> {
    return asStaff(async () => {
      const s = await shipments.create(
        {
          idempotencyKey: randomUUID(),
          senderName: "Boutique",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: "Recipient",
          recipientPhone: `+2162${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
          destination: {
            rawInput: "Sfax",
            countryCode: "TN",
            coordinates: { lat: 34.74, lng: 10.76 },
          },
          currency: "TND",
          codAmountMinor: 12_500n,
        },
        staff,
      );
      await shipments.recordEvent(
        s.id,
        { eventType: "assigned", idempotencyKey: randomUUID(), driverId },
        staff,
      );
      await shipments.recordPickup(s.id, { idempotencyKey: randomUUID(), driverId }, staff);
      await shipments.recordEvent(
        s.id,
        { eventType: "out_for_delivery", idempotencyKey: randomUUID(), driverId },
        staff,
      );
      return { id: s.id, destination: s.destinationAddressId };
    });
  }

  /** A route published to the driver, serving one new parcel (12.500 TND COD). */
  async function publishedRoute(driverId: string): Promise<string> {
    return asStaff(async () => {
      const shipment = await shipments.create(
        {
          idempotencyKey: randomUUID(),
          senderName: "Boutique",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: "Route recipient",
          recipientPhone: `+2162${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
          destination: {
            rawInput: "Ariana",
            city: "Ariana",
            countryCode: "TN",
            coordinates: { lat: 36.86, lng: 10.19 },
          },
          currency: "TND",
          codAmountMinor: 12_500n,
        },
        staff,
      );
      const legs = await db.withTenant((tx) =>
        tx.execute<{ id: string }>(
          sql`select id from shipment_legs where shipment_id = ${shipment.id} limit 1`,
        ),
      );
      const legId = legs[0]?.id;
      if (legId === undefined) throw new Error("no leg");
      const vehicle = await vehicles.create({
        plateNumber: `TUN-${randomUUID().slice(0, 6)}`,
        type: "VAN",
        capacityParcels: 60,
        capacityWeightGrams: 500_000,
      });
      const route = await routes.create({
        plannedDate: "2026-10-19",
        driverId,
        vehicleId: vehicle.id,
      });
      await routes.addStops(route.id, { legIds: [legId] });
      await routes.publish(route.id, { actor: staff.actor });
      return route.id;
    });
  }

  interface SyncBody {
    results: {
      idempotencyKey: string | null;
      type: string | null;
      status: string;
      replayed?: boolean;
      resultingStatus?: string;
      code?: string;
      action?: string;
    }[];
    activeRoutes: { routeId: string; status: string; version: string }[];
    routeUpdates: { routeId: string; version: string; manifest: { routeId: string } }[];
    features: Record<string, boolean>;
    serverTime: string;
  }

  async function sync(token: string, body: object): Promise<SyncBody> {
    const response = await call("POST", "/v1/drivers/me/sync", token, body);
    expect(response.statusCode, response.body).toBe(200);
    return JSON.parse(response.body) as SyncBody;
  }

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  beforeAll(async () => {
    database = await createTestDatabase();
    tenant = asTenantId(await createTenant(database.migrator, "sync-http"));
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const audit = new AuditService(db);
    const addresses = new AddressService(db, new ManualGeocodingProvider());
    const features = new FeatureService(db, audit);
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      new MerchantService(db, outbox, audit, addresses),
      new RecipientService(db),
      addresses,
      new OperatingConfigService(db),
      audit,
    );
    const hubs = new HubService(db, outbox, addresses);
    vehicles = new VehicleService(db, outbox, hubs);
    const drivers = new DriverService(db, outbox, hubs, new FieldCipher(randomBytes(32)));
    routes = new RouteService(
      db,
      outbox,
      features,
      new HeuristicOptimizationProvider(),
      shipments,
      vehicles,
      drivers,
      hubs,
      addresses,
    );
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const unused = (token: InjectionToken): Provider => ({ provide: token, useValue: {} });

    @Module({
      controllers: [AuthController, RouteController, DriverSyncController],
      providers: [
        { provide: AppConfigService, useValue: stubConfig() },
        { provide: POSTGRES_CLIENT, useValue: database.app },
        DatabaseService,
        PasswordService,
        AuditService,
        MfaService,
        OtpService,
        { provide: NOTIFICATION_PROVIDER, useValue: new CapturingNotificationProvider() },
        { provide: FIELD_CIPHER, useValue: new FieldCipher(randomBytes(32)) },
        TokenService,
        AuthService,
        AccessService,
        CurrencyService,
        { provide: ShipmentService, useValue: shipments },
        { provide: RouteService, useValue: routes },
        { provide: FeatureService, useValue: features },
        {
          provide: AddressCorrectionService,
          useValue: new AddressCorrectionService(db, outbox, audit),
        },
        // Logs are not under test; the structured logger is replaced by a sink.
        { provide: PinoLogger, useValue: logger },
        DriverSyncService,
        unused(AssignmentService),
        unused(DistributionNoteService),
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_PIPE, useClass: UuidParamPipe },
      ],
    })
    class SyncTestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [SyncTestModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter());
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 240_000);

  afterAll(async () => {
    await app.close();
    await deleteTenants(database.migrator, [tenant]);
    await database.close();
  });

  it("serves the route manifest over HTTP, money as strings with their exponent", async () => {
    const driver = await seedAccount(["DRIVER"], true);
    const routeId = await publishedRoute(driver.driverId ?? "");

    const response = await call("GET", `/v1/routes/${routeId}/manifest`, await login(driver));
    expect(response.statusCode, response.body).toBe(200);
    const manifest = JSON.parse(response.body) as {
      summary: { codExpected: unknown };
      stops: { shipments: { cod: unknown }[] }[];
    };
    // TND has three decimals: 12.500 TND is 12500 millimes, never 1250.
    expect(manifest.summary.codExpected).toEqual([
      { amountMinor: "12500", currency: "TND", currencyExponent: 3 },
    ]);
    expect(manifest.stops[0]?.shipments[0]?.cod).toEqual({
      amountMinor: "12500",
      currency: "TND",
      currencyExponent: 3,
    });
  });

  it("drains a queue item by item, and a resent batch is replayed, not re-applied", async () => {
    const driver = await seedAccount(["DRIVER"], true);
    const token = await login(driver);
    const delivered = await outForDelivery(driver.driverId ?? "");
    const failed = await outForDelivery(driver.driverId ?? "");
    const body = {
      deviceId: "pixel-7a",
      pendingEvents: [
        {
          idempotencyKey: randomUUID(),
          type: "ADDRESS_CORRECTED",
          addressId: delivered.destination,
          payload: { coordinates: { lat: 34.7401, lng: 10.7601 }, occurredAt: minutesAgo(40) },
        },
        {
          idempotencyKey: randomUUID(),
          type: "DELIVERED",
          shipmentId: delivered.id,
          payload: { pod: strongPod, codCollected: true, occurredAt: minutesAgo(39) },
        },
        {
          idempotencyKey: randomUUID(),
          type: "FAILED",
          shipmentId: failed.id,
          payload: { reasonCode: "CUSTOMER_UNREACHABLE", occurredAt: minutesAgo(20) },
        },
      ],
    };

    const first = await sync(token, body);
    expect(first.results).toEqual([
      expect.objectContaining({ status: "ACCEPTED", replayed: false, resultingStatus: "APPLIED" }),
      expect.objectContaining({
        status: "ACCEPTED",
        replayed: false,
        resultingStatus: "DELIVERED",
      }),
      expect.objectContaining({ status: "ACCEPTED", replayed: false, type: "FAILED" }),
    ]);
    // The device time is what was recorded, not the sync time (docs/01 7.5).
    const events = await withTenantContext(
      database.migrator,
      tenant,
      (tx) => tx<{ occurred_at: Date }[]>`
        select occurred_at from shipment_events
         where shipment_id = ${delivered.id} and event_type = 'delivered'`,
    );
    expect(events[0]?.occurred_at.toISOString()).toBe(body.pendingEvents[1]?.payload.occurredAt);

    // The response never reached the phone; it sends the same batch again.
    const again = await sync(token, body);
    expect(again.results.map((r) => [r.status, r.replayed])).toEqual([
      ["ACCEPTED", true],
      ["ACCEPTED", true],
      ["ACCEPTED", true],
    ]);
    expect(Object.keys(first.features).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("answers each item on its own, escalates what physically happened, holds what follows", async () => {
    const driver = await seedAccount(["DRIVER"], true);
    const colleague = await seedAccount(["DRIVER"], true);
    const token = await login(driver);
    const mine = await outForDelivery(driver.driverId ?? "");
    const theirs = await outForDelivery(colleague.driverId ?? "");
    const theirsToo = await outForDelivery(colleague.driverId ?? "");
    const other = await outForDelivery(driver.driverId ?? "");

    const { results } = await sync(token, {
      deviceId: "pixel-7a",
      pendingEvents: [
        // 1. No device time: unreadable, but maybe a delivery. A person looks.
        {
          idempotencyKey: randomUUID(),
          type: "DELIVERED",
          shipmentId: other.id,
          payload: { pod: strongPod },
        },
        // 2. A colleague's parcel "delivered": refused, and never silently dropped.
        {
          idempotencyKey: randomUUID(),
          type: "DELIVERED",
          shipmentId: theirs.id,
          payload: { pod: strongPod, codCollected: true, occurredAt: minutesAgo(30) },
        },
        // 3. Another colleague parcel "failed": nothing physical lost, refresh
        //    and drop. (On `theirs` it would wait behind item 2, by design.)
        {
          idempotencyKey: randomUUID(),
          type: "FAILED",
          shipmentId: theirsToo.id,
          payload: { reasonCode: "CUSTOMER_UNREACHABLE", occurredAt: minutesAgo(29) },
        },
        // 4. A photo POD with no photo: invalid, escalated...
        {
          idempotencyKey: randomUUID(),
          type: "DELIVERED",
          shipmentId: mine.id,
          payload: {
            pod: { podType: "photo", recipientName: "R" },
            codCollected: true,
            occurredAt: minutesAgo(10),
          },
        },
        // 5. ...so a later item for the SAME parcel waits instead of overtaking it.
        {
          idempotencyKey: randomUUID(),
          type: "FAILED",
          shipmentId: mine.id,
          payload: { reasonCode: "CUSTOMER_UNREACHABLE", occurredAt: minutesAgo(5) },
        },
        // 6. A phone clock a day ahead.
        {
          idempotencyKey: randomUUID(),
          type: "FAILED",
          shipmentId: other.id,
          payload: {
            reasonCode: "CUSTOMER_UNREACHABLE",
            occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
        // 7. Not even an object.
        "garbage",
      ],
    });

    expect(results.map((r) => [r.status, r.code ?? null, r.action ?? null])).toEqual([
      ["REJECTED", "VALIDATION_FAILED", "ESCALATE_TO_DISPATCHER"],
      ["REJECTED", "NOT_FOUND", "ESCALATE_TO_DISPATCHER"],
      ["REJECTED", "NOT_FOUND", "DISCARD_AND_REFRESH"],
      ["REJECTED", "POD_INCOMPLETE", "ESCALATE_TO_DISPATCHER"],
      ["REJECTED", "HELD_BEHIND_EARLIER_ITEM", "RETRY_LATER"],
      ["REJECTED", "VALIDATION_FAILED", "ESCALATE_TO_DISPATCHER"],
      ["REJECTED", "VALIDATION_FAILED", "ESCALATE_TO_DISPATCHER"],
    ]);
    // Nothing was applied by any of them.
    for (const id of [mine.id, theirs.id, theirsToo.id, other.id]) {
      expect((await asStaff(() => shipments.getById(id))).status).toBe("OUT_FOR_DELIVERY");
    }
  });

  it("sends a route's manifest only when the device does not already hold that version", async () => {
    const driver = await seedAccount(["DRIVER"], true);
    const token = await login(driver);
    const routeId = await publishedRoute(driver.driverId ?? "");

    const first = await sync(token, { deviceId: "pixel-7a" });
    expect(first.activeRoutes).toEqual([expect.objectContaining({ routeId, status: "PUBLISHED" })]);
    const version = first.activeRoutes[0]?.version ?? "";
    expect(first.routeUpdates.map((u) => [u.routeId, u.version, u.manifest.routeId])).toEqual([
      [routeId, version, routeId],
    ]);

    const same = await sync(token, {
      deviceId: "pixel-7a",
      knownRouteVersions: { [routeId]: version },
    });
    expect(same.routeUpdates).toEqual([]);
    expect(same.activeRoutes[0]?.version).toBe(version);

    // Dispatch re-times the stop: anything the driver would see is a change.
    await withTenantContext(
      database.migrator,
      tenant,
      (tx) => tx`update route_stops set planned_arrival_at = now() + interval '2 hours'
                  where route_id = ${routeId}`,
    );
    const changed = await sync(token, {
      deviceId: "pixel-7a",
      knownRouteVersions: { [routeId]: version },
    });
    expect(changed.routeUpdates.map((u) => u.routeId)).toEqual([routeId]);
    expect(changed.routeUpdates[0]?.version).not.toBe(version);
  });

  it("is a driver's own device only, and refuses a malformed envelope", async () => {
    const dispatcher = await login(await seedAccount(["DISPATCHER"], false));
    expect(
      (await call("POST", "/v1/drivers/me/sync", dispatcher, { deviceId: "x" })).statusCode,
    ).toBe(403);
    const unlinked = await login(await seedAccount(["DRIVER"], false));
    expect(
      (await call("POST", "/v1/drivers/me/sync", unlinked, { deviceId: "x" })).statusCode,
    ).toBe(403);
    const driver = await login(await seedAccount(["DRIVER"], true));
    const tooMany = { deviceId: "x", pendingEvents: Array.from({ length: 101 }, () => ({})) };
    expect((await call("POST", "/v1/drivers/me/sync", driver, tooMany)).statusCode).toBe(400);
    expect(
      (await call("POST", "/v1/drivers/me/sync", driver, { pendingEvents: [] })).statusCode,
    ).toBe(400);
  });
});
