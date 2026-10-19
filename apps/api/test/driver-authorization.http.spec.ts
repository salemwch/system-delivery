import { randomBytes, randomUUID } from "node:crypto";

import { Module } from "@nestjs/common";
import type { InjectionToken, Provider } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import * as OTPAuth from "otpauth";
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AddressCorrectionController } from "../src/modules/directory/api/address-correction.controller.js";
import { AddressCorrectionService } from "../src/modules/directory/application/address-correction.service.js";
import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { RecipientController } from "../src/modules/directory/api/recipient.controller.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { FinanceController } from "../src/modules/finance/api/finance.controller.js";
import { ShiftController } from "../src/modules/fleet/api/shift.controller.js";
import { ShiftService } from "../src/modules/fleet/application/shift.service.js";
import type { ShiftContext } from "../src/modules/fleet/application/shift.service.js";
import { LedgerService } from "../src/modules/finance/application/ledger.service.js";
import { PaymentNoteService } from "../src/modules/finance/application/payment-note.service.js";
import { ReconciliationService } from "../src/modules/finance/application/reconciliation.service.js";
import { RemittanceService } from "../src/modules/finance/application/remittance.service.js";
import { SettlementService } from "../src/modules/finance/application/settlement.service.js";
import { AuthController } from "../src/modules/identity/api/auth.controller.js";
import { WorkloadController } from "../src/modules/identity/api/workload.controller.js";
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
import { WorkloadService } from "../src/modules/platform/application/workload.service.js";
import { NOTIFICATION_PROVIDER } from "../src/modules/platform/domain/notification-provider.js";
import { commandContextOf } from "../src/modules/shipment/api/command-context.js";
import { AddressBookController } from "../src/modules/shipment/api/address-book.controller.js";
import { MediaController } from "../src/modules/shipment/api/media.controller.js";
import { ShipmentController } from "../src/modules/shipment/api/shipment.controller.js";
import { AddressBookService } from "../src/modules/shipment/application/address-book.service.js";
import { BulkShipmentService } from "../src/modules/shipment/application/bulk-shipment.service.js";
import { DocumentService } from "../src/modules/shipment/application/document.service.js";
import { LabelService } from "../src/modules/shipment/application/label.service.js";
import { ParcelStateService } from "../src/modules/shipment/application/parcel-state.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentStatsService } from "../src/modules/shipment/application/shipment-stats.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { ShipmentTraceabilityService } from "../src/modules/shipment/application/traceability.service.js";
import { PodMediaService } from "../src/modules/shipment/application/pod-media.service.js";
import { TrackingService } from "../src/modules/shipment/application/tracking.service.js";
import { AppConfigService } from "../src/shared/config/index.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { FIELD_CIPHER } from "../src/shared/crypto/crypto.tokens.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { POSTGRES_CLIENT } from "../src/shared/database/database.tokens.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import type { TenantId } from "../src/shared/database/tenant-context.js";
import { ForbiddenError, NotFoundError } from "../src/shared/errors/index.js";
import {
  ProblemDetailsFilter,
  UuidParamPipe,
  createFastifyAdapter,
} from "../src/shared/http/index.js";
import { CurrencyService } from "../src/shared/money/index.js";
import { PassThroughMalwareScanner, S3ObjectStorage } from "../src/shared/storage/index.js";
import { CapturingNotificationProvider } from "./auth.factory.js";
import { stubConfig } from "./config.stub.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import { jpegFixture } from "./media.fixtures.js";
import { createTestStorage } from "./storage.harness.js";
import type { TestStorage } from "./storage.harness.js";
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
  let otherTenant: TenantId;
  let shipments: ShipmentService;
  let shiftsSvc: ShiftService;
  let addresses: AddressService;
  let store: TestStorage | undefined;

  // Generated, never a literal: a fixed credential in a test file is exactly
  // what a secret scanner is right to flag.
  const PASSWORD = `pw-${randomBytes(18).toString("hex")}`;
  const cipher = new FieldCipher(randomBytes(32));
  const mfaSecrets = new Map<string, string>();
  const staff: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };
  // An ID-checked POD cites no media: these specs are about who may deliver,
  // not about proof artifacts (pod-media.spec.ts covers those).
  const pod = { podType: "id_check", recipientName: "R" };

  interface Seeded {
    readonly tenantId: TenantId;
    readonly email: string;
    readonly userId: string;
    readonly driverId: string | null;
  }

  async function seedAccount(
    roles: string[],
    withDriverRecord: boolean,
    tenantId: TenantId = tenant,
  ): Promise<Seeded> {
    const email = `u-${randomUUID().slice(0, 8)}@authz.tn`;
    const privileged = roles.includes("OWNER");
    const mfaSecret = privileged ? new OTPAuth.Secret({ size: 20 }).base32 : null;
    if (mfaSecret !== null) {
      mfaSecrets.set(email, mfaSecret);
    }
    const hash = await new PasswordService().hash(PASSWORD);
    return database.migrator.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
      const users = await tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status,
                           mfa_enabled, mfa_secret, mfa_enrolled_at)
        values (${tenantId}, ${email}, ${hash}, 'Authz', 'ACTIVE', ${privileged},
                ${mfaSecret === null ? null : cipher.encrypt(mfaSecret)},
                ${privileged ? new Date() : null})
        returning id`;
      const user = users[0];
      if (user === undefined) throw new Error("seed failed");
      for (const role of roles) {
        await tx`insert into user_roles (tenant_id, user_id, role) values (${tenantId}, ${user.id}, ${role})`;
      }
      let driverId: string | null = null;
      if (withDriverRecord) {
        const drivers = await tx<{ id: string }[]>`
          insert into drivers (tenant_id, user_id, employee_code, full_name, phone, status, employment_type)
          values (${tenantId}, ${user.id}, ${`D-${randomUUID().slice(0, 6)}`}, 'Driver',
                  ${`+2162${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`},
                  'ACTIVE', 'EMPLOYEE')
          returning id`;
        driverId = drivers[0]?.id ?? null;
      }
      return { tenantId, email, userId: user.id, driverId };
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
        tenantId: account.tenantId,
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

  function inTenant<T>(fn: () => Promise<T>, tenantId: TenantId = tenant): Promise<T> {
    return TenantContext.run({ tenantId, actorType: "system" }, fn);
  }

  /** A shipment out for delivery with `driverId` (null: nobody's yet). */
  async function outForDelivery(
    driverId: string,
    phone: string,
    tenantId: TenantId = tenant,
  ): Promise<string> {
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
    }, tenantId);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    tenant = asTenantId(await createTenant(database.migrator, "authz-http"));
    otherTenant = asTenantId(await createTenant(database.migrator, "authz-http-2"));

    const db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    addresses = new AddressService(db, new ManualGeocodingProvider());
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
    shiftsSvc = new ShiftService(db, outbox);
    const createdStore = await createTestStorage();
    store = createdStore;
    const media = new PodMediaService(
      db,
      new S3ObjectStorage(createdStore.settings),
      new PassThroughMalwareScanner(),
    );

    // Routes under test use only ShipmentService, ShipmentStatsService,
    // AddressBookService, RecipientService, RemittanceService, ShiftService and
    // CurrencyService. The controllers' other
    // collaborators back routes this spec never calls, so they are inert
    // placeholders, never invoked.
    const unused = (token: InjectionToken): Provider => ({ provide: token, useValue: {} });

    @Module({
      controllers: [
        AuthController,
        ShipmentController,
        RecipientController,
        FinanceController,
        ShiftController,
        AddressBookController,
        AddressCorrectionController,
        WorkloadController,
        MediaController,
      ],
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
        AddressCorrectionService,
        { provide: ShiftService, useValue: shiftsSvc },
        { provide: PodMediaService, useValue: media },
        OutboxService,
        WorkloadService,
        LedgerService,
        RemittanceService,
        unused(SettlementService),
        unused(ReconciliationService),
        unused(PaymentNoteService),
        ShipmentStatsService,
        AddressBookService,
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
        { provide: APP_PIPE, useClass: UuidParamPipe },
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
    await store?.close();
    await app.close();
    await deleteTenants(database.migrator, [tenant, otherTenant]);
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

  describe("a DRIVER remitting COD cash (driver identity, 9318622 release review)", () => {
    function remittance(driverId: string): object {
      return { driverId, hubId: randomUUID(), declaredAmountMinor: "1000", currency: "TND" };
    }

    it("is refused a colleague's driverId with 403 that names nothing about them", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const token = await login(a);

      const response = await call(
        "POST",
        "/v1/finance/remittances",
        token,
        remittance(b.driverId ?? ""),
      );
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(b.driverId ?? "");
      expect(response.body).not.toMatch(/expectedAmountMinor/u);
    });

    it("remits their own cash, and still cannot read a remittance back", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const token = await login(a);

      const own = await call(
        "POST",
        "/v1/finance/remittances",
        token,
        remittance(a.driverId ?? ""),
      );
      expect(own.statusCode).toBe(201);
      const { id } = JSON.parse(own.body) as { id: string };
      // Reading, confirming or disputing a remittance is staff work.
      expect((await call("GET", `/v1/finance/remittances/${id}`, token)).statusCode).toBe(403);
    });
  });

  describe("a DRIVER and customer addresses (address authorization, migration 0050)", () => {
    it("finds only their own shipments' recipients in the address book", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const mine = await outForDelivery(a.driverId ?? "", "+21620000601");
      await outForDelivery(b.driverId ?? "", "+21620000602");
      const token = await login(a);

      const book = await call("GET", "/v1/address-book", token);
      expect(book.statusCode).toBe(200);
      const entries = (
        JSON.parse(book.body) as {
          data: { phone: string; lastDestinationAddressId: string | null }[];
        }
      ).data;
      expect(entries.map((e) => e.phone)).toEqual(["+21620000601"]);
      expect(entries[0]?.lastDestinationAddressId).toBe(
        (await inTenant(() => shipments.getById(mine))).destinationAddressId,
      );

      // Searching for the colleague's recipient by phone finds nothing.
      const search = await call("GET", "/v1/address-book?q=%2B21620000602", token);
      expect(search.statusCode).toBe(200);
      expect((JSON.parse(search.body) as { data: unknown[] }).data).toEqual([]);
    });

    it("reads their own parcel's addresses, and no shipment route returns a colleague's", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const mine = await outForDelivery(a.driverId ?? "", "+21620000603");
      const theirId = await outForDelivery(b.driverId ?? "", "+21620000604");
      const their = await inTenant(() => shipments.getById(theirId));
      const token = await login(a);

      const own = await call("GET", `/v1/shipments/${mine}`, token);
      expect(own.statusCode, own.body).toBe(200);
      const detail = JSON.parse(own.body) as {
        destination: { rawInput: string; latitude: number | null };
      };
      expect(detail.destination.rawInput).toBe("Sfax");
      expect(detail.destination.latitude).toBeCloseTo(34.74, 5);

      for (const url of [
        `/v1/shipments/${theirId}`,
        `/v1/shipments/lookup/${their.trackingNumber}`,
      ]) {
        const response = await call("GET", url, token);
        expect(response.statusCode, url).toBe(404);
        expect(response.body).not.toContain(their.destinationAddressId);
      }
      const list = await call("GET", "/v1/shipments", token);
      expect(list.body).not.toContain(their.destinationAddressId);
    });

    it("cannot reach another tenant's parcel or its address", async () => {
      const c = await seedAccount(["DRIVER"], true, otherTenant);
      const awayId = await outForDelivery(c.driverId ?? "", "+21620000605", otherTenant);
      const away = await inTenant(() => shipments.getById(awayId), otherTenant);

      for (const token of [
        await login(await seedAccount(["DRIVER"], true)),
        await login(await seedAccount(["OWNER"], false)),
      ]) {
        const response = await call("GET", `/v1/shipments/${awayId}`, token);
        expect(response.statusCode).toBe(404);
        expect(response.body).not.toContain(away.destinationAddressId);
        const book = await call("GET", "/v1/address-book?q=%2B21620000605", token);
        expect((JSON.parse(book.body) as { data: unknown[] }).data).toEqual([]);
      }
    });
  });

  describe("a DRIVER and shifts (V5: shift identity, 9318622 release review)", () => {
    /** A van on no shift. */
    async function seedVehicle(tenantId: TenantId = tenant): Promise<string> {
      return database.migrator.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string }[]>`
          insert into vehicles (tenant_id, plate_number, type)
          values (${tenantId}, ${`TUN-${randomUUID().slice(0, 8)}`}, 'VAN')
          returning id`;
        const row = rows[0];
        if (row === undefined) throw new Error("seed failed");
        return row.id;
      });
    }

    /** Every shift of a driver, read past the API as the schema owner. */
    async function shiftsOf(
      driverId: string | null,
      tenantId: TenantId = tenant,
    ): Promise<{ id: string; status: string; closing_cash_minor: string | null }[]> {
      return database.migrator.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
        const rows = await tx<{ id: string; status: string; closing_cash_minor: string | null }[]>`
          select id, status, closing_cash_minor::text as closing_cash_minor
            from shifts where driver_id = ${driverId ?? randomUUID()}`;
        return [...rows];
      });
    }

    /** The driver opens their own shift over HTTP. */
    async function ownShift(account: Seeded, extra: object = {}): Promise<string> {
      const response = await call("POST", "/v1/shifts", await login(account), {
        driverId: account.driverId,
        vehicleId: await seedVehicle(account.tenantId),
        ...extra,
      });
      expect(response.statusCode, response.body).toBe(201);
      return (JSON.parse(response.body) as { id: string }).id;
    }

    /**
     * The location privacy gate, called exactly as TelemetryService calls it
     * for this driver's request (driver-scoped context, the login's user id).
     */
    function telemetryGate(account: Seeded, at?: Date) {
      return TenantContext.run(
        {
          tenantId: account.tenantId,
          actorType: "driver",
          actorId: account.userId,
          driverId: account.driverId ?? "",
        },
        () => shiftsSvc.openShiftForUser(account.userId, at),
      );
    }

    it("refuses a colleague's driverId on start with 403 that names nothing about them", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);

      const response = await call("POST", "/v1/shifts", await login(a), {
        driverId: b.driverId,
        vehicleId: await seedVehicle(),
        openingCashMinor: "12345",
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ code: "FORBIDDEN" });
      expect(response.body).not.toContain(b.driverId ?? "");
      // Nothing was opened for B, so B's location is not collected, and B can
      // still open their own shift (no denial of service).
      expect(await shiftsOf(b.driverId)).toEqual([]);
      expect(await telemetryGate(b)).toBeNull();
      await ownShift(b);
    });

    it("cannot read or end a colleague's shift: 404, and the shift is untouched", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const theirs = await ownShift(b, { openingCashMinor: "12345" });
      const token = await login(a);

      const read = await call("GET", `/v1/shifts/${theirs}`, token);
      expect(read.statusCode).toBe(404);
      expect(read.body).not.toContain("12345");

      const ended = await call("POST", `/v1/shifts/${theirs}/end`, token, {
        closingCashMinor: "999",
      });
      expect(ended.statusCode).toBe(404);

      expect(await shiftsOf(b.driverId)).toEqual([
        { id: theirs, status: "OPEN", closing_cash_minor: null },
      ]);
      // B's location is still collected: the shift was not closed under them.
      expect(await telemetryGate(b)).toMatchObject({ driverId: b.driverId, shiftId: theirs });
    });

    it("starts, reads and ends their own shift, and never holds two open", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const token = await login(a);
      expect(await telemetryGate(a)).toBeNull();

      const id = await ownShift(a, { openingCashMinor: "5000" });
      // Location is accepted from now on: their own OPEN shift.
      expect(await telemetryGate(a)).toMatchObject({ driverId: a.driverId, shiftId: id });

      const second = await call("POST", "/v1/shifts", token, {
        driverId: a.driverId,
        vehicleId: await seedVehicle(),
      });
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body)).toMatchObject({ code: "DRIVER_SHIFT_OPEN" });

      const read = await call("GET", `/v1/shifts/${id}`, token);
      expect(read.statusCode).toBe(200);
      expect(JSON.parse(read.body)).toMatchObject({
        id,
        driverId: a.driverId,
        openingCashMinor: "5000",
      });

      const ended = await call("POST", `/v1/shifts/${id}/end`, token, {
        closingCashMinor: "4500",
      });
      expect(ended.statusCode, ended.body).toBe(200);
      expect(JSON.parse(ended.body)).toMatchObject({ status: "CLOSED", closingCashMinor: "4500" });

      const again = await call("POST", `/v1/shifts/${id}/end`, token, {});
      expect(again.statusCode).toBe(422);
      expect(JSON.parse(again.body)).toMatchObject({ code: "SHIFT_NOT_OPEN" });
      // After the shift, a new location is refused.
      expect(await telemetryGate(a, new Date(Date.now() + 3_600_000))).toBeNull();
    });

    it("gives a DRIVER login with no driver record nothing: 403 on start, 404 on a shift", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const shift = await ownShift(a);
      const token = await login(await seedAccount(["DRIVER"], false));

      const start = await call("POST", "/v1/shifts", token, {
        driverId: a.driverId,
        vehicleId: await seedVehicle(),
      });
      expect(start.statusCode).toBe(403);
      expect((await call("GET", `/v1/shifts/${shift}`, token)).statusCode).toBe(404);
      expect((await call("POST", `/v1/shifts/${shift}/end`, token, {})).statusCode).toBe(404);
      expect((await shiftsOf(a.driverId)).map((s) => s.status)).toEqual(["OPEN"]);
    });

    it("lets an OWNER start, read and end a shift on a driver's behalf", async () => {
      const b = await seedAccount(["DRIVER"], true);
      const token = await login(await seedAccount(["OWNER"], false));

      const started = await call("POST", "/v1/shifts", token, {
        driverId: b.driverId,
        vehicleId: await seedVehicle(),
        openingCashMinor: "700",
      });
      expect(started.statusCode, started.body).toBe(201);
      const { id } = JSON.parse(started.body) as { id: string };

      const read = await call("GET", `/v1/shifts/${id}`, token);
      expect(read.statusCode).toBe(200);
      expect(JSON.parse(read.body)).toMatchObject({
        driverId: b.driverId,
        openingCashMinor: "700",
      });

      const ended = await call("POST", `/v1/shifts/${id}/end`, token, { closingCashMinor: "700" });
      expect(ended.statusCode, ended.body).toBe(200);
      expect(JSON.parse(ended.body)).toMatchObject({ status: "CLOSED" });
    });

    it("keeps shifts out of a DISPATCHER's reach (the role holds no shift permission)", async () => {
      const b = await seedAccount(["DRIVER"], true);
      const shift = await ownShift(b);
      const token = await login(await seedAccount(["DISPATCHER"], false));

      expect((await call("GET", `/v1/shifts/${shift}`, token)).statusCode).toBe(403);
      expect((await call("POST", `/v1/shifts/${shift}/end`, token, {})).statusCode).toBe(403);
      const start = await call("POST", "/v1/shifts", token, {
        driverId: b.driverId,
        vehicleId: await seedVehicle(),
      });
      expect(start.statusCode).toBe(403);
      expect((await shiftsOf(b.driverId)).map((s) => s.status)).toEqual(["OPEN"]);
    });

    it("cannot reach another tenant's shift or driver", async () => {
      const c = await seedAccount(["DRIVER"], true, otherTenant);
      const theirs = await ownShift(c, { openingCashMinor: "8888" });
      const driver = await login(await seedAccount(["DRIVER"], true));
      const owner = await login(await seedAccount(["OWNER"], false));

      for (const token of [driver, owner]) {
        const read = await call("GET", `/v1/shifts/${theirs}`, token);
        expect(read.statusCode).toBe(404);
        expect(read.body).not.toContain("8888");
        expect((await call("POST", `/v1/shifts/${theirs}/end`, token, {})).statusCode).toBe(404);
      }
      // Naming the other tenant's driver: not in this tenant for the owner
      // (404), and not themselves for the driver (403, existence unconfirmed).
      const ownerStart = await call("POST", "/v1/shifts", owner, {
        driverId: c.driverId,
        vehicleId: await seedVehicle(),
      });
      expect(ownerStart.statusCode).toBe(404);
      const driverStart = await call("POST", "/v1/shifts", driver, {
        driverId: c.driverId,
        vehicleId: await seedVehicle(),
      });
      expect(driverStart.statusCode).toBe(403);

      expect(await shiftsOf(c.driverId, otherTenant)).toEqual([
        { id: theirs, status: "OPEN", closing_cash_minor: null },
      ]);
    });

    it("is refused by the database itself (RLS, migration 0049)", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const theirs = await ownShift(b);
      const vehicle = await seedVehicle();

      // dp_app, scoped exactly as withTenant scopes A's requests.
      const asA = (query: (tx: TransactionSql) => Promise<readonly unknown[]>) =>
        database.app.begin(async (tx) => {
          await tx`select set_config('app.current_tenant_id', ${tenant}, true),
                          set_config('app.current_driver_id', ${a.driverId ?? ""}, true)`;
          return [...(await query(tx))];
        });

      expect(await asA((tx) => tx`select id from shifts where id = ${theirs}`)).toHaveLength(0);
      expect(
        await asA(
          (tx) => tx`update shifts set status = 'CLOSED', ended_at = now()
                      where id = ${theirs} returning id`,
        ),
      ).toHaveLength(0);
      await expect(
        asA(
          (tx) => tx`insert into shifts (tenant_id, driver_id, vehicle_id)
                     values (${tenant}, ${b.driverId}, ${vehicle})`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // The scope narrows; it does not blind a driver to their own rows.
      expect(
        await asA(
          (tx) => tx`insert into shifts (tenant_id, driver_id, vehicle_id)
                     values (${tenant}, ${a.driverId}, ${vehicle}) returning id`,
        ),
      ).toHaveLength(1);
      expect((await shiftsOf(b.driverId)).map((s) => s.status)).toEqual(["OPEN"]);
    });

    it("checks ownership after retrieval even in a session RLS does not narrow", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const theirs = await ownShift(b);
      const vehicle = await seedVehicle();
      const asDriverA: ShiftContext = { actorUserId: a.userId, actorIsDriver: true };
      // No driverId bound: RLS does not narrow, so the service check stands alone.
      const unscoped = <T>(fn: () => Promise<T>) =>
        TenantContext.run({ tenantId: tenant, actorType: "user" }, fn);

      await expect(unscoped(() => shiftsSvc.getById(theirs, asDriverA))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(unscoped(() => shiftsSvc.end(theirs, {}, asDriverA))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        unscoped(() => shiftsSvc.start({ driverId: b.driverId, vehicleId: vehicle }, asDriverA)),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect((await shiftsOf(b.driverId)).map((s) => s.status)).toEqual(["OPEN"]);
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
  describe("geocode corrections (2.10, 0050/0051)", () => {
    /** The destination address of a shipment, read as staff. */
    async function destinationOf(shipmentId: string): Promise<string> {
      return (await inTenant(() => shipments.getById(shipmentId))).destinationAddressId;
    }

    function correction(lat: number, lng: number) {
      return {
        idempotencyKey: randomUUID(),
        coordinates: { lat, lng },
        accuracyM: 6,
        occurredAt: new Date().toISOString(),
      };
    }

    it("lets a driver move the pin of their own delivery, and replays a retry", async () => {
      const courier = await seedAccount(["DRIVER"], true);
      const token = await login(courier);
      const address = await destinationOf(
        await outForDelivery(courier.driverId ?? "", "+21620000601"),
      );
      const body = correction(34.7405, 10.7605);

      const first = await call("POST", `/v1/addresses/${address}/corrections`, token, body);
      expect(first.statusCode, first.body).toBe(201);
      const created = JSON.parse(first.body) as { id: string; status: string; driverId: string };
      expect(created).toMatchObject({ status: "APPLIED", driverId: courier.driverId });
      expect(first.headers["idempotency-replayed"]).toBeUndefined();

      const retry = await call("POST", `/v1/addresses/${address}/corrections`, token, body);
      expect(retry.statusCode).toBe(201);
      expect(retry.headers["idempotency-replayed"]).toBe("true");
      expect((JSON.parse(retry.body) as { id: string }).id).toBe(created.id);

      const reused = await call("POST", `/v1/addresses/${address}/corrections`, token, {
        ...body,
        coordinates: { lat: 34.741, lng: 10.761 },
      });
      expect(reused.statusCode).toBe(422);
      expect(reused.body).toContain("IDEMPOTENCY_KEY_REUSED");
    });

    it("answers a colleague's address with 404, and changes nothing", async () => {
      const a = await seedAccount(["DRIVER"], true);
      const b = await seedAccount(["DRIVER"], true);
      const address = await destinationOf(await outForDelivery(b.driverId ?? "", "+21620000602"));

      const response = await call(
        "POST",
        `/v1/addresses/${address}/corrections`,
        await login(a),
        correction(34.9, 10.9),
      );
      expect(response.statusCode).toBe(404);
      const after = await inTenant(() => addresses.getById(address));
      expect(after.geocodeSource).toBe("manual");
    });

    it("keeps the review queue from drivers, and correcting from dispatchers", async () => {
      const driverToken = await login(await seedAccount(["DRIVER"], true));
      const dispatcherToken = await login(await seedAccount(["DISPATCHER"], false));

      expect((await call("GET", "/v1/address-corrections", driverToken)).statusCode).toBe(403);
      expect(
        (
          await call(
            "POST",
            `/v1/addresses/${randomUUID()}/corrections`,
            dispatcherToken,
            correction(36.8, 10.18),
          )
        ).statusCode,
      ).toBe(403);
    });

    it("sends a move over 2 km to the dispatcher, who approves it with no body", async () => {
      const courier = await seedAccount(["DRIVER"], true);
      const address = await destinationOf(
        await outForDelivery(courier.driverId ?? "", "+21620000603"),
      );
      // The destination is Sfax (34.74, 10.76); this is about 11 km north.
      const held = await call(
        "POST",
        `/v1/addresses/${address}/corrections`,
        await login(courier),
        correction(34.84, 10.76),
      );
      expect(held.statusCode, held.body).toBe(201);
      const { id, status } = JSON.parse(held.body) as { id: string; status: string };
      expect(status).toBe("PENDING_REVIEW");

      const dispatcher = await login(await seedAccount(["DISPATCHER"], false));
      const count = await call("GET", "/v1/address-corrections/count", dispatcher);
      expect(count.statusCode).toBe(200);
      expect((JSON.parse(count.body) as { pending: number }).pending).toBeGreaterThanOrEqual(1);
      const queue = await call("GET", "/v1/address-corrections?status=PENDING_REVIEW", dispatcher);
      expect(queue.statusCode, queue.body).toBe(200);
      expect(
        (JSON.parse(queue.body) as { data: { id: string }[] }).data.map((c) => c.id),
      ).toContain(id);

      const approved = await call("POST", `/v1/address-corrections/${id}/approve`, dispatcher);
      expect(approved.statusCode, approved.body).toBe(200);
      expect(JSON.parse(approved.body)).toMatchObject({ status: "APPROVED" });
    });

    it("refuses a malformed id or body at the boundary", async () => {
      const dispatcher = await login(await seedAccount(["DISPATCHER"], false));
      const courier = await login(await seedAccount(["DRIVER"], true));

      expect((await call("GET", "/v1/address-corrections/not-a-uuid", dispatcher)).statusCode).toBe(
        400,
      );
      expect(
        (await call("POST", "/v1/address-corrections/not-a-uuid/reject", dispatcher)).statusCode,
      ).toBe(400);
      expect((await call("GET", "/v1/address-corrections?limit=0", dispatcher)).statusCode).toBe(
        400,
      );
      const missingTime = await call("POST", `/v1/addresses/${randomUUID()}/corrections`, courier, {
        idempotencyKey: randomUUID(),
        coordinates: { lat: 36.8, lng: 10.18 },
      });
      expect(missingTime.statusCode).toBe(400);
    });
  });
  describe("workload counts (sidebar badges)", () => {
    it("counts only the queues the caller may open", async () => {
      await database.migrator.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenant}, true)`;
        await tx`insert into merchant_applications (tenant_id, business_name, contact_name, contact_phone)
                values (${tenant}, 'Boutique', 'Contact', '+21620000700')`;
      });
      const counts = async (token: string) => {
        const response = await call("GET", "/v1/workload", token);
        expect(response.statusCode, response.body).toBe(200);
        return JSON.parse(response.body) as Record<string, number>;
      };

      // A dispatcher holds merchant:read, which opens the applications queue.
      const dispatcher = await counts(await login(await seedAccount(["DISPATCHER"], false)));
      expect(dispatcher["applications"]).toBeGreaterThanOrEqual(1);

      // A driver holds none of the queue permissions: every count is zero, and
      // nothing about the tenant's applications, expenses or stock is disclosed.
      const driver = await counts(await login(await seedAccount(["DRIVER"], true)));
      expect(Object.values(driver).every((value) => value === 0)).toBe(true);
    });
  });
  describe("malformed ids", () => {
    it("answers a non-UUID id with 400 on every route, never a 500", async () => {
      const dispatcher = await login(await seedAccount(["DISPATCHER"], false));
      for (const url of [
        "/v1/shipments/not-a-uuid",
        "/v1/shipments/not-a-uuid/events",
        "/v1/recipients/1",
        "/v1/shipments/driver/x/stats",
        "/v1/address-corrections/%27%3B--",
      ]) {
        const response = await call("GET", url, dispatcher);
        expect(response.statusCode, `${url}: ${response.body}`).toBe(400);
        expect(response.body).toContain("VALIDATION_FAILED");
      }
      // Ids that are not UUIDs by design still route normally.
      const lookup = await call("GET", "/v1/shipments/lookup/NOT-A-TRACKING-NUMBER", dispatcher);
      expect(lookup.statusCode).toBe(404);
    });
  });
  describe("POD media (0052)", () => {
    it("issues a driver an upload slot for their own parcel, and nobody else", async () => {
      const courier = await seedAccount(["DRIVER"], true);
      const colleague = await seedAccount(["DRIVER"], true);
      const shipmentId = await outForDelivery(courier.driverId ?? "", "+21620000801");
      const bytes = jpegFixture();
      const body = {
        idempotencyKey: randomUUID(),
        purpose: "POD_PHOTO",
        shipmentId,
        contentType: "image/jpeg",
        sizeBytes: bytes.length,
      };

      const issued = await call("POST", "/v1/media/presign", await login(courier), body);
      expect(issued.statusCode, issued.body).toBe(201);
      const slot = JSON.parse(issued.body) as {
        id: string;
        status: string;
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
      };
      expect(slot.status).toBe("PENDING_UPLOAD");
      expect(slot.requiredHeaders).toEqual({
        "content-length": String(bytes.length),
        "content-type": "image/jpeg",
      });

      const other = await call("POST", "/v1/media/presign", await login(colleague), {
        ...body,
        idempotencyKey: randomUUID(),
      });
      expect(other.statusCode).toBe(404);

      // A dispatcher holds no shipment:deliver; viewing is shipment:read.
      const dispatcher = await login(await seedAccount(["DISPATCHER"], false));
      expect((await call("POST", "/v1/media/presign", dispatcher, body)).statusCode).toBe(403);
      const viewed = await call("GET", `/v1/media/${slot.id}`, dispatcher);
      expect(viewed.statusCode).toBe(200);
      expect(JSON.parse(viewed.body)).toMatchObject({ status: "PENDING_UPLOAD", viewUrl: null });
      expect((await call("GET", "/v1/media/not-a-uuid", dispatcher)).statusCode).toBe(400);
    });
  });
});
