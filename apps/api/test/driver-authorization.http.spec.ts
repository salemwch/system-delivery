import { randomBytes, randomUUID } from "node:crypto";

import { Module } from "@nestjs/common";
import type { InjectionToken, Provider } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { RecipientController } from "../src/modules/directory/api/recipient.controller.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
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
import { permissionsForRoles } from "../src/modules/identity/domain/permissions.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { FeatureService } from "../src/modules/platform/application/feature.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { NOTIFICATION_PROVIDER } from "../src/modules/platform/domain/notification-provider.js";
import { commandContextOf } from "../src/modules/shipment/api/command-context.js";
import { ShipmentController } from "../src/modules/shipment/api/shipment.controller.js";
import { BulkShipmentService } from "../src/modules/shipment/application/bulk-shipment.service.js";
import { DocumentService } from "../src/modules/shipment/application/document.service.js";
import { LabelService } from "../src/modules/shipment/application/label.service.js";
import { ParcelStateService } from "../src/modules/shipment/application/parcel-state.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentStatsService } from "../src/modules/shipment/application/shipment-stats.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { ShipmentTraceabilityService } from "../src/modules/shipment/application/traceability.service.js";
import { TrackingService } from "../src/modules/shipment/application/tracking.service.js";
import { AppConfigService } from "../src/shared/config/index.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { FIELD_CIPHER } from "../src/shared/crypto/crypto.tokens.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { POSTGRES_CLIENT } from "../src/shared/database/database.tokens.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import type { TenantId } from "../src/shared/database/tenant-context.js";
import { ProblemDetailsFilter, createFastifyAdapter } from "../src/shared/http/index.js";
import { CurrencyService } from "../src/shared/money/index.js";
import { CapturingNotificationProvider } from "./auth.factory.js";
import { stubConfig } from "./config.stub.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Driver authorization end to end over HTTP (invariants I26, I28, I29).
 *
 * Real password login → real token → AuthGuard → PermissionGuard →
 * TenantContextInterceptor (driver scope from the ROLE claim) → controller →
 * service → RLS, with the production Fastify adapter and error filter.
 *
 * ⚠️ Audit finding F1: the controller derived "is this a driver?" from the
 * LOGIN CHANNEL (`actorType === "driver"` only for a phone-code session). A
 * DRIVER-role account that signed in with a password, and had no driver record,
 * was treated as staff, and closed a return another driver was carrying.
 */
describe("driver authorization over HTTP", () => {
  let database: TestDatabase;
  let app: NestFastifyApplication;
  let tenant: TenantId;
  let shipments: ShipmentService;

  // Generated, never a literal: a fixed credential in a test file is exactly
  // what a secret scanner is right to flag.
  const PASSWORD = `pw-${randomBytes(18).toString("hex")}`;
  const cipher = new FieldCipher(randomBytes(32));
  const mfaSecrets = new Map<string, string>();
  const staff: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };
  const pod = { podType: "signature", signatureObjectKey: "pods/s.png", recipientName: "R" };

  interface Seeded {
    readonly email: string;
    readonly userId: string;
    readonly driverId: string | null;
  }

  async function seedAccount(roles: string[], withDriverRecord: boolean): Promise<Seeded> {
    const email = `u-${randomUUID().slice(0, 8)}@authz.tn`;
    const privileged = roles.includes("OWNER");
    const mfaSecret = privileged ? new OTPAuth.Secret({ size: 20 }).base32 : null;
    if (mfaSecret !== null) {
      mfaSecrets.set(email, mfaSecret);
    }
    const hash = await new PasswordService().hash(PASSWORD);
    return database.migrator.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenant}, true)`;
      const users = await tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status,
                           mfa_enabled, mfa_secret, mfa_enrolled_at)
        values (${tenant}, ${email}, ${hash}, 'Authz', 'ACTIVE', ${privileged},
                ${mfaSecret === null ? null : cipher.encrypt(mfaSecret)},
                ${privileged ? new Date() : null})
        returning id`;
      const user = users[0];
      if (user === undefined) throw new Error("seed failed");
      for (const role of roles) {
        await tx`insert into user_roles (tenant_id, user_id, role) values (${tenant}, ${user.id}, ${role})`;
      }
      let driverId: string | null = null;
      if (withDriverRecord) {
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

  /** A real PASSWORD login, the channel F1 was about. */
  async function login(account: Seeded): Promise<string> {
    const secret = mfaSecrets.get(account.email);
    const mfaCode =
      secret === undefined
        ? undefined
        : new OTPAuth.TOTP({
            issuer: "authz",
            label: account.email,
            algorithm: "SHA1",
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(secret),
          }).generate();
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        tenantId: tenant,
        email: account.email,
        password: PASSWORD,
        ...(mfaCode === undefined ? {} : { mfaCode }),
      },
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

  function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: tenant, actorType: "system" }, fn);
  }

  /** A shipment out for delivery with `driverId` (null: nobody's yet). */
  async function outForDelivery(driverId: string, phone: string): Promise<string> {
    return inTenant(async () => {
      const s = await shipments.create(
        {
          idempotencyKey: randomUUID(),
          senderName: "B",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: `R ${phone}`,
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
        s.id,
        { eventType: "assigned", idempotencyKey: randomUUID() },
        staff,
      );
      await shipments.recordPickup(s.id, { idempotencyKey: randomUUID(), driverId }, staff);
      await shipments.recordEvent(
        s.id,
        { eventType: "out_for_delivery", idempotencyKey: randomUUID(), driverId },
        staff,
      );
      return s.id;
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    tenant = asTenantId(await createTenant(database.migrator, "authz-http"));

    const db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    const recipients = new RecipientService(db);
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      new MerchantService(db, outbox, new AuditService(db), addresses),
      recipients,
      addresses,
      new OperatingConfigService(db),
      new AuditService(db),
    );

    // Routes under test use only ShipmentService, RecipientService and
    // CurrencyService. The controller's other collaborators back routes this
    // spec never calls, so they are inert placeholders, never invoked.
    const unused = (token: InjectionToken): Provider => ({ provide: token, useValue: {} });

    @Module({
      controllers: [AuthController, ShipmentController, RecipientController],
      providers: [
        { provide: AppConfigService, useValue: stubConfig() },
        { provide: POSTGRES_CLIENT, useValue: database.app },
        DatabaseService,
        PasswordService,
        AuditService,
        MfaService,
        OtpService,
        { provide: NOTIFICATION_PROVIDER, useValue: new CapturingNotificationProvider() },
        { provide: FIELD_CIPHER, useValue: cipher },
        TokenService,
        AuthService,
        AccessService,
        CurrencyService,
        { provide: ShipmentService, useValue: shipments },
        { provide: RecipientService, useValue: recipients },
        { provide: AddressService, useValue: addresses },
        unused(ShipmentStatsService),
        unused(ParcelStateService),
        unused(BulkShipmentService),
        unused(TrackingService),
        unused(ShipmentTraceabilityService),
        unused(FeatureService),
        unused(LabelService),
        unused(DocumentService),
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    })
    class AuthzTestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [AuthzTestModule] }).compile();
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

  it("derives the actor from the ROLE claim, not from how the user signed in", () => {
    const roles = ["DRIVER"] as const;
    const ctx = commandContextOf({
      userId: "u",
      roles,
      permissions: permissionsForRoles(roles),
    });
    expect(ctx.actor.actorType).toBe("DRIVER");
  });

  describe("a DRIVER-role password login with no driver record (F1)", () => {
    it("is refused with 403 on every driver-only command", async () => {
      const courier = await seedAccount(["DRIVER"], true);
      const unlinked = await seedAccount(["DRIVER"], false);
      const token = await login(unlinked);
      const id = await outForDelivery(courier.driverId ?? "", "+21620000401");

      for (const [path, body] of [
        ["deliver", { idempotencyKey: randomUUID(), pod }],
        ["fail", { idempotencyKey: randomUUID(), reasonCode: "CUSTOMER_UNAVAILABLE" }],
        ["return/complete", { idempotencyKey: randomUUID() }],
      ] as const) {
        const response = await call("POST", `/v1/shipments/${id}/${path}`, token, body);
        expect(response.statusCode, `${path}: ${response.body}`).toBe(403);
        expect(JSON.parse(response.body)).toMatchObject({ code: "FORBIDDEN" });
      }
      expect((await inTenant(() => shipments.getById(id))).status).toBe("OUT_FOR_DELIVERY");
    });

    it("cannot close a return another driver is carrying (the reproduced R3)", async () => {
      const courier = await seedAccount(["DRIVER"], true);
      const unlinked = await seedAccount(["DRIVER"], false);
      const id = await outForDelivery(courier.driverId ?? "", "+21620000402");
      await inTenant(() =>
        shipments.recordFailedAttempt(
          id,
          { idempotencyKey: randomUUID(), reasonCode: "CUSTOMER_REFUSED" },
          { actor: { actorType: "DRIVER", actorId: courier.userId } },
        ),
      );

      const response = await call(
        "POST",
        `/v1/shipments/${id}/return/complete`,
        await login(unlinked),
        { idempotencyKey: randomUUID() },
      );

      expect(response.statusCode).toBe(403);
      const after = await inTenant(() => shipments.getById(id));
      expect(after.status).toBe("RETURN_PENDING");
      expect(after.codStatus).not.toBe("CANCELLED");
    });

    it("reads nothing: no shipments listed, every id a 404", async () => {
      const courier = await seedAccount(["DRIVER"], true);
      const id = await outForDelivery(courier.driverId ?? "", "+21620000403");
      const token = await login(await seedAccount(["DRIVER"], false));

      const list = await call("GET", "/v1/shipments", token);
      expect(list.statusCode).toBe(200);
      expect((JSON.parse(list.body) as { data: unknown[] }).data).toEqual([]);
      expect((await call("GET", `/v1/shipments/${id}`, token)).statusCode).toBe(404);
    });
  });

  describe("a linked driver signed in by password", () => {
    it("reads their own shipment and recipient, and gets 404 for a colleague's", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const mine = await outForDelivery(a.driverId ?? "", "+21620000404");
      const theirs = await outForDelivery(b.driverId ?? "", "+21620000405");
      const theirRecipient = (await inTenant(() => shipments.getById(theirs))).recipientId;
      const token = await login(a);

      expect((await call("GET", `/v1/shipments/${mine}`, token)).statusCode).toBe(200);
      expect((await call("GET", `/v1/shipments/${theirs}`, token)).statusCode).toBe(404);
      expect((await call("GET", `/v1/recipients/${theirRecipient ?? ""}`, token)).statusCode).toBe(
        404,
      );

      const book = await call("GET", "/v1/recipients", token);
      expect(book.statusCode).toBe(200);
      const ids = (JSON.parse(book.body) as { data: { id: string }[] }).data.map((r) => r.id);
      expect(ids).toHaveLength(1);
      expect(ids).not.toContain(theirRecipient);
    });

    it("delivers their own parcel, and a reused key on another parcel is a 422", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const first = await outForDelivery(a.driverId ?? "", "+21620000406");
      const second = await outForDelivery(a.driverId ?? "", "+21620000407");
      const token = await login(a);
      const key = randomUUID();

      const delivered = await call("POST", `/v1/shipments/${first}/deliver`, token, {
        idempotencyKey: key,
        pod,
      });
      expect(delivered.statusCode, delivered.body).toBe(200);
      expect(delivered.headers["idempotency-replayed"]).toBeUndefined();

      // The offline retry: same caller, same request. The recorded response,
      // marked as a replay (docs/05-api-contracts.md §3).
      const replayed = await call("POST", `/v1/shipments/${first}/deliver`, token, {
        idempotencyKey: key,
        pod,
      });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.headers["idempotency-replayed"]).toBe("true");
      expect(JSON.parse(replayed.body)).toEqual(JSON.parse(delivered.body));

      // Same key, same caller, a different parcel: the documented conflict,
      // not a silent 200 for a delivery that never happened.
      const reused = await call("POST", `/v1/shipments/${second}/deliver`, token, {
        idempotencyKey: key,
        pod,
      });
      expect(reused.statusCode).toBe(422);
      expect(JSON.parse(reused.body)).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      expect((await inTenant(() => shipments.getById(second))).status).toBe("OUT_FOR_DELIVERY");
    });
  });

  describe("an OWNER (policy: whole tenant, closes returns at the counter, captures no POD)", () => {
    it("reads every driver's shipment", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const id = await outForDelivery(a.driverId ?? "", "+21620000408");
      const token = await login(await seedAccount(["OWNER"], false));
      expect((await call("GET", `/v1/shipments/${id}`, token)).statusCode).toBe(200);
    });

    it("may not capture proof of delivery: deliver is driver-only", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const id = await outForDelivery(a.driverId ?? "", "+21620000409");
      const token = await login(await seedAccount(["OWNER"], false));
      const response = await call("POST", `/v1/shipments/${id}/deliver`, token, {
        idempotencyKey: randomUUID(),
        pod,
      });
      expect(response.statusCode).toBe(403);
    });

    it("closes a return at the counter, booked to no driver", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const id = await outForDelivery(a.driverId ?? "", "+21620000410");
      await inTenant(() =>
        shipments.recordFailedAttempt(
          id,
          { idempotencyKey: randomUUID(), reasonCode: "CUSTOMER_REFUSED" },
          { actor: { actorType: "DRIVER", actorId: a.userId } },
        ),
      );
      const owner = await seedAccount(["OWNER"], false);
      const token = await login(owner);

      const response = await call("POST", `/v1/shipments/${id}/return/complete`, token, {
        idempotencyKey: randomUUID(),
        receivedByName: "Counter staff",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect((JSON.parse(response.body) as { status: string }).status).toBe("RETURNED");

      // Decision 2: the staff closure is audit-logged, with who did it and
      // which driver still held the parcel.
      const audit = await database.migrator.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenant}, true)`;
        return tx<
          {
            actor_type: string;
            actor_id: string | null;
            changes: Record<string, { from: unknown; to: unknown }>;
            context: Record<string, unknown>;
          }[]
        >`select actor_type, actor_id, changes, context from audit_log
           where action = 'shipment.return_closed_by_staff' and resource_id = ${id}`;
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_type: "USER",
        actor_id: owner.userId,
        changes: {
          status: { from: "RETURN_PENDING", to: "RETURNED" },
          // A non-COD fixture: nothing to cancel (COD closure is covered in
          // return-lifecycle.spec).
          codStatus: { from: "NOT_APPLICABLE", to: "NOT_APPLICABLE" },
        },
        context: {
          receivedByName: "Counter staff",
          custodyAtClosure: { type: "DRIVER", id: a.driverId },
        },
      });
    });

    it("refuses return closure to staff without the permission (a DISPATCHER)", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const id = await outForDelivery(a.driverId ?? "", "+21620000411");
      await inTenant(() =>
        shipments.recordFailedAttempt(
          id,
          { idempotencyKey: randomUUID(), reasonCode: "CUSTOMER_REFUSED" },
          { actor: { actorType: "DRIVER", actorId: a.userId } },
        ),
      );
      const token = await login(await seedAccount(["DISPATCHER"], false));

      const response = await call("POST", `/v1/shipments/${id}/return/complete`, token, {
        idempotencyKey: randomUUID(),
      });
      expect(response.statusCode).toBe(403);
      expect((await inTenant(() => shipments.getById(id))).status).toBe("RETURN_PENDING");
    });

    it("refuses an unassigned LINKED driver who knows the shipment id", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const id = await outForDelivery(a.driverId ?? "", "+21620000412");
      await inTenant(() =>
        shipments.recordFailedAttempt(
          id,
          { idempotencyKey: randomUUID(), reasonCode: "CUSTOMER_REFUSED" },
          { actor: { actorType: "DRIVER", actorId: a.userId } },
        ),
      );

      const response = await call("POST", `/v1/shipments/${id}/return/complete`, await login(b), {
        idempotencyKey: randomUUID(),
      });
      // Not visible to B at all (I28): possession of the id grants nothing.
      expect(response.statusCode).toBe(404);
      expect((await inTenant(() => shipments.getById(id))).status).toBe("RETURN_PENDING");
    });
  });
});
