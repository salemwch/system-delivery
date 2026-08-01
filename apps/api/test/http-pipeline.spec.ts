import { randomBytes, randomUUID } from "node:crypto";

import { Controller, Get, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as OTPAuth from "otpauth";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthController } from "../src/modules/identity/api/auth.controller.js";
import { AuthGuard } from "../src/modules/identity/api/auth.guard.js";
import { MfaController } from "../src/modules/identity/api/mfa.controller.js";
import { PermissionGuard } from "../src/modules/identity/api/permission.guard.js";
import { TenantContextInterceptor } from "../src/modules/identity/api/tenant-context.interceptor.js";
import {
  CurrentPrincipal,
  Public,
  RequirePermissions,
} from "../src/modules/identity/api/request-context.js";
import { AccessService } from "../src/modules/identity/application/access.service.js";
import { AuthService } from "../src/modules/identity/application/auth.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { MfaService } from "../src/modules/identity/application/mfa.service.js";
import { OtpService } from "../src/modules/identity/application/otp.service.js";
import { NOTIFICATION_PROVIDER } from "../src/modules/platform/domain/notification-provider.js";
import { CapturingNotificationProvider } from "./auth.factory.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { FIELD_CIPHER } from "../src/shared/crypto/crypto.tokens.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { TokenService } from "../src/modules/identity/application/token.service.js";
import type { Principal } from "../src/modules/identity/application/token.service.js";
import { AppConfigService } from "../src/shared/config/index.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { POSTGRES_CLIENT } from "../src/shared/database/database.tokens.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import type { TenantId } from "../src/shared/database/tenant-context.js";
import { ProblemDetailsFilter, createFastifyAdapter } from "../src/shared/http/index.js";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { stubConfig } from "./config.stub.js";

/**
 * End-to-end request pipeline: authenticate → authorize → bind tenant context.
 *
 * Exercised through real HTTP via Fastify's `inject()`, so guard ordering,
 * decorator metadata, the exception filter, and AsyncLocalStorage propagation
 * are all tested as they actually run — not as unit-mocked approximations.
 */

/** Probe routes covering each pipeline behaviour. */
@Controller("test")
class ProbeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get("public")
  publicRoute(): { ok: boolean } {
    return { ok: true };
  }

  @Get("protected")
  protectedRoute(@CurrentPrincipal() principal: Principal): { userId: string; tenantId: string } {
    return { userId: principal.userId, tenantId: principal.tenantId };
  }

  @Get("needs-ledger")
  @RequirePermissions("ledger:adjust")
  ledgerRoute(): { ok: boolean } {
    return { ok: true };
  }

  @Get("needs-dispatch")
  @RequirePermissions("shipment:assign")
  dispatchRoute(): { ok: boolean } {
    return { ok: true };
  }

  /** Proves tenant context reached the handler through the interceptor. */
  @Get("tenant-context")
  tenantContextRoute(): { tenantId: string | null } {
    const current = TenantContext.current();
    return { tenantId: current?.tenantId ?? null };
  }

  /** Proves context survives an await boundary (the ALS subscription trap). */
  @Get("tenant-context-async")
  async asyncTenantContextRoute(): Promise<{ tenantId: string | null }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = TenantContext.current();
    return { tenantId: current?.tenantId ?? null };
  }

  @Get("boom")
  boom(): never {
    throw new Error("internal detail that must not leak: password=hunter2");
  }

  /**
   * Writes a REAL audit row, the way every mutating command does.
   *
   * Stands in for `POST /v1/users`, `/v1/merchants/:id/suspend`, and the rest:
   * they all end in `AuditService.record` inside the caller's transaction, so
   * they all failed together when the correlation id was not a UUID.
   */
  @Get("audited")
  async auditedRoute(): Promise<{ ok: boolean }> {
    await this.database.withTenant(async (tx) => {
      await this.audit.record(tx, {
        action: "user.created",
        resourceType: "user",
        resourceId: TenantContext.current()?.actorId ?? "",
      });
    });
    return { ok: true };
  }
}

describe("http pipeline", () => {
  let database: TestDatabase;
  let app: NestFastifyApplication;
  let tokens: TokenService;
  let tenantA: TenantId;

  const PASSWORD = "pipeline-test-password-8823";

  /**
   * One cipher for both the module and the fixtures, so a secret seeded by a
   * raw INSERT is decryptable by the service that reads it back.
   */
  const testCipher = new FieldCipher(randomBytes(32));

  /** TOTP secrets of the enrolled fixtures, so `tokenFor` can answer the challenge. */
  const mfaSecrets = new Map<string, string>();

  /** The code an authenticator would show for a seeded user right now. */
  function codeFor(email: string): string | undefined {
    const secret = mfaSecrets.get(email);
    if (secret === undefined) {
      return undefined;
    }
    return new OTPAuth.TOTP({
      issuer: "pipeline",
      label: email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();
  }

  async function seedUser(
    tenantId: TenantId,
    email: string,
    roles: string[],
    // Overrides the default below. `false` on a privileged role seeds the state
    // a freshly provisioned OWNER is actually in: must have a factor, has none.
    enrolMfa?: boolean,
  ): Promise<string> {
    const passwords = new PasswordService();
    const passwordHash = await passwords.hash(PASSWORD);

    // OWNER, FINANCE and PLATFORM_ADMIN cannot authenticate without a SECOND
    // FACTOR (fail-closed, docs/07-security-architecture.md §3), so these are
    // seeded FULLY ENROLLED — a real secret, encrypted with the same cipher the
    // module under test uses.
    //
    // Not with a bare `mfa_enabled = true`: that flag with no secret behind it
    // was the historical hole, and a fixture reproducing it would exercise a
    // login path production no longer has.
    const mfaEnabled =
      enrolMfa ??
      roles.some((role) => role === "OWNER" || role === "FINANCE" || role === "PLATFORM_ADMIN");
    const mfaSecret = mfaEnabled ? new OTPAuth.Secret({ size: 20 }).base32 : null;
    if (mfaSecret !== null) {
      mfaSecrets.set(email, mfaSecret);
    }

    return database.migrator.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
      const inserted = await tx<{ id: string }[]>`
        insert into users (
          tenant_id, email, password_hash, full_name, status,
          mfa_enabled, mfa_secret, mfa_enrolled_at
        )
        values (
          ${tenantId}, ${email}, ${passwordHash}, 'Pipeline User', 'ACTIVE',
          ${mfaEnabled},
          ${mfaSecret === null ? null : testCipher.encrypt(mfaSecret)},
          ${mfaEnabled ? new Date() : null}
        )
        returning id
      `;
      const row = inserted[0];
      if (row === undefined) throw new Error("seed failed");
      for (const role of roles) {
        await tx`insert into user_roles (tenant_id, user_id, role) values (${tenantId}, ${row.id}, ${role})`;
      }
      return row.id;
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    tenantA = asTenantId(await createTenant(database.migrator, "pipeline"));

    const config = stubConfig();

    @Module({
      controllers: [ProbeController, AuthController, MfaController],
      providers: [
        { provide: AppConfigService, useValue: config },
        { provide: POSTGRES_CLIENT, useValue: database.app },
        DatabaseService,
        PasswordService,
        AuditService,
        MfaService,
        OtpService,
        { provide: NOTIFICATION_PROVIDER, useValue: new CapturingNotificationProvider() },
        { provide: FIELD_CIPHER, useValue: testCipher },
        TokenService,
        AuthService,
        AccessService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    })
    class TestAppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();

    // Production's adapter, not a bare one: its `genReqId` is what keeps
    // `request.id` a UUID, and `audit_log.correlation_id` will not take
    // anything else. A default `FastifyAdapter()` here would test a transport
    // the service never runs on.
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter());
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    tokens = moduleRef.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
    await deleteTenants(database.migrator, [tenantA]);
    await database.close();
  });

  const inject = async (options: {
    method: "GET" | "POST";
    url: string;
    token?: string;
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) => {
    const headers: Record<string, string> = {
      ...options.headers,
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    };

    return app.inject({
      method: options.method,
      url: options.url,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  };

  async function tokenFor(roles: string[], email: string): Promise<string> {
    const userId = await seedUser(tenantA, email, roles);
    const code = codeFor(email);
    const login = await inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: {
        tenantId: tenantA,
        email,
        password: PASSWORD,
        // Privileged roles are enrolled, so the password alone buys only a
        // challenge. Supplying the code inline completes the login in one call.
        ...(code === undefined ? {} : { mfaCode: code }),
      },
    });
    expect(login.statusCode, login.body).toBe(200);
    const body = JSON.parse(login.body) as { accessToken: string; user: { id: string } };
    expect(body.user.id).toBe(userId);
    return body.accessToken;
  }

  describe("authentication (deny by default)", () => {
    it("allows a public route without a token", async () => {
      const response = await inject({ method: "GET", url: "/test/public" });
      expect(response.statusCode).toBe(200);
    });

    it("rejects a protected route without a token", async () => {
      const response = await inject({ method: "GET", url: "/test/protected" });
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({ code: "UNAUTHENTICATED" });
    });

    it("rejects a malformed Authorization header", async () => {
      for (const header of ["Bearer", "Basic abc", "abc", "Bearer "]) {
        const response = await app.inject({
          method: "GET",
          url: "/test/protected",
          headers: { authorization: header },
        });
        expect(response.statusCode, `header: "${header}"`).toBe(401);
      }
    });

    it("rejects a tampered token", async () => {
      const token = await tokenFor(["DISPATCHER"], "tamper-pipeline@a.tn");
      const response = await inject({
        method: "GET",
        url: "/test/protected",
        token: `${token.slice(0, -3)}xyz`,
      });
      expect(response.statusCode).toBe(401);
    });

    it("accepts a valid token and exposes the principal", async () => {
      const token = await tokenFor(["DISPATCHER"], "valid-pipeline@a.tn");
      const response = await inject({ method: "GET", url: "/test/protected", token });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ tenantId: tenantA });
    });

    it("ignores a client-supplied X-Tenant-Id header", async () => {
      // The tenant must come from the signed claim only. Honouring this header
      // would make impersonation one header away.
      const token = await tokenFor(["DISPATCHER"], "header-pipeline@a.tn");
      const response = await app.inject({
        method: "GET",
        url: "/test/protected",
        headers: {
          authorization: `Bearer ${token}`,
          "x-tenant-id": "00000000-0000-0000-0000-0000000000ff",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ tenantId: tenantA });
    });
  });

  describe("authorization", () => {
    it("allows a route the principal has permission for", async () => {
      const token = await tokenFor(["DISPATCHER"], "authz-allow@a.tn");
      const response = await inject({ method: "GET", url: "/test/needs-dispatch", token });
      expect(response.statusCode).toBe(200);
    });

    it("rejects a route the principal lacks permission for", async () => {
      const token = await tokenFor(["DISPATCHER"], "authz-deny@a.tn");
      const response = await inject({ method: "GET", url: "/test/needs-ledger", token });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ code: "FORBIDDEN" });
    });

    it("returns 401 (not 403) when an authorized route is called anonymously", async () => {
      const response = await inject({ method: "GET", url: "/test/needs-ledger" });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("tenant context binding", () => {
    it("binds tenant context for the handler", async () => {
      const token = await tokenFor(["DISPATCHER"], "ctx-sync@a.tn");
      const response = await inject({ method: "GET", url: "/test/tenant-context", token });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ tenantId: tenantA });
    });

    it("keeps tenant context across an await boundary", async () => {
      // Guards against the AsyncLocalStorage subscription trap: binding around
      // `next.handle()` instead of around its subscription silently loses
      // context before the handler ever runs.
      const token = await tokenFor(["DISPATCHER"], "ctx-async@a.tn");
      const response = await inject({ method: "GET", url: "/test/tenant-context-async", token });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ tenantId: tenantA });
    });

    it("leaves public routes without tenant context", async () => {
      const response = await inject({ method: "GET", url: "/test/tenant-context" });
      expect(response.statusCode).toBe(401);
    });

    it("does not leak context between requests", async () => {
      const token = await tokenFor(["DISPATCHER"], "ctx-leak@a.tn");
      await inject({ method: "GET", url: "/test/tenant-context", token });

      // A subsequent anonymous request must see nothing from the previous one.
      const anonymous = await inject({ method: "GET", url: "/test/public" });
      expect(anonymous.statusCode).toBe(200);
      expect(TenantContext.current()).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("returns RFC 9457 Problem Details with a request id", async () => {
      const response = await inject({ method: "GET", url: "/test/protected" });

      expect(response.headers["content-type"]).toContain("application/problem+json");
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 401,
        code: "UNAUTHENTICATED",
        instance: "/test/protected",
      });
      expect(typeof body["requestId"]).toBe("string");
      expect(typeof body["type"]).toBe("string");
    });

    it("never leaks internal detail from an unexpected error", async () => {
      const token = await tokenFor(["OWNER"], "boom@a.tn");
      const response = await inject({ method: "GET", url: "/test/boom", token });

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("hunter2");
      expect(response.body).not.toContain("internal detail");
      expect(JSON.parse(response.body)).toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("rejects unknown body properties (mass-assignment defence)", async () => {
      const response = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
          tenantId: tenantA,
          email: "someone@a.tn",
          password: "whatever",
          isAdmin: true,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { code: string; errors?: unknown[] };
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(Array.isArray(body.errors)).toBe(true);
    });

    it("reports field-level validation errors", async () => {
      const response = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: "not-a-uuid", email: "not-an-email", password: "" },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body) as { errors: { field: string }[] };
      const fields = body.errors.map((error) => error.field);
      expect(fields).toContain("tenantId");
      expect(fields).toContain("email");
    });
  });

  describe("login endpoint", () => {
    it("returns one opaque 401 for every failure mode", async () => {
      await seedUser(tenantA, "opaque@a.tn", ["DISPATCHER"]);

      const wrongPassword = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "opaque@a.tn", password: "wrong" },
      });
      const unknownUser = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "ghost@a.tn", password: PASSWORD },
      });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);

      // Identical bodies: nothing distinguishes "no such user" from "bad password".
      const a = JSON.parse(wrongPassword.body) as Record<string, unknown>;
      const b = JSON.parse(unknownUser.body) as Record<string, unknown>;
      delete a["requestId"];
      delete b["requestId"];
      expect(a).toEqual(b);
    });

    it("issues a usable token that authorises subsequent requests", async () => {
      const token = await tokenFor(["OWNER"], "roundtrip@a.tn");
      const claims = await tokens.verifyAccessToken(token);
      expect(claims?.tid).toBe(tenantA);

      const response = await inject({ method: "GET", url: "/test/needs-ledger", token });
      expect(response.statusCode).toBe(200);
    });

    it("labels a successful login so a client can discriminate on one field", async () => {
      await seedUser(tenantA, "labelled@a.tn", ["DISPATCHER"]);
      const response = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "labelled@a.tn", password: PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { status: string; accessToken: string };
      expect(body.status).toBe("AUTHENTICATED");
      expect(body.accessToken).toBeTruthy();
    });
  });

  /**
   * ⚠️ These four assertions are about the CONTROLLER, and the service they call
   * was always right.
   *
   * `AuthService` mints a challenge token for both MFA states, but the
   * controller collapsed every non-ok result into the blanket 401 — so the token
   * was created and thrown away on every request. Nothing else issues one, and
   * `/v1/auth/mfa/challenge` and `/v1/auth/mfa/bootstrap/enrol` accept nothing
   * else, which made the ENTIRE MFA subsystem unreachable over HTTP: an enrolled
   * user could not finish logging in, and a privileged role could not enrol at
   * all. Every existing test passed because they call `AuthService` directly and
   * assert on `result.reason`, which was correct the whole time.
   */
  describe("MFA states are reported, not hidden behind the opaque 401", () => {
    it("returns a challenge instead of a session when a factor is enrolled", async () => {
      await seedUser(tenantA, "enrolled@a.tn", ["FINANCE"]);

      const response = await inject({
        method: "POST",
        url: "/v1/auth/login",
        // Correct password, no code — the two-step flow.
        payload: { tenantId: tenantA, email: "enrolled@a.tn", password: PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        status: string;
        challenge: string;
        accessToken?: string;
        refreshToken?: string;
      };
      expect(body.status).toBe("MFA_REQUIRED");
      expect(body.challenge).toBeTruthy();
      // A challenge is not a session: neither token may ride along with it.
      expect(body.accessToken).toBeUndefined();
      expect(body.refreshToken).toBeUndefined();
    });

    it("tells an unenrolled privileged role to enrol, and hands it the token to do so", async () => {
      // The state a freshly provisioned OWNER is in. Without this response the
      // account is permanently locked out: it needs a session to enrol and
      // enrolment to get a session.
      await seedUser(tenantA, "unenrolled@a.tn", ["OWNER"], false);

      const response = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "unenrolled@a.tn", password: PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { status: string; challenge: string };
      expect(body.status).toBe("MFA_ENROLMENT_REQUIRED");
      expect(body.challenge).toBeTruthy();
    });

    it("issues a challenge the MFA endpoints actually accept", async () => {
      // The property that matters. A well-formed token the next endpoint
      // rejects would leave the flow just as broken, one step further along.
      await seedUser(tenantA, "usable@a.tn", ["OWNER"], false);

      const login = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "usable@a.tn", password: PASSWORD },
      });
      const { challenge } = JSON.parse(login.body) as { challenge: string };

      const verified = await tokens.verifyMfaChallenge(challenge);
      expect(verified?.tenantId).toBe(tenantA);
      // And it is NOT usable as a session, whatever else it can do.
      expect(await tokens.verifyAccessToken(challenge)).toBeNull();
    });

    it("walks a locked-out OWNER all the way to a working session", async () => {
      // ⚠️ The whole point. Each step is only reachable because the one before
      // it returned something usable, so this fails if ANY link is broken —
      // which both of them were: login discarded the challenge, and then
      // `bootstrap/enrol` answered 500 because it is `@Public()` and
      // `withTenant` found no ambient tenant to scope its write to.
      await seedUser(tenantA, "bootstrap@a.tn", ["OWNER"], false);

      const login = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "bootstrap@a.tn", password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      const { challenge, status } = JSON.parse(login.body) as {
        challenge: string;
        status: string;
      };
      expect(status).toBe("MFA_ENROLMENT_REQUIRED");

      const enrol = await inject({
        method: "POST",
        url: "/v1/auth/mfa/bootstrap/enrol",
        payload: { challenge },
      });
      expect(enrol.statusCode, enrol.body).toBe(200);
      const { secret } = JSON.parse(enrol.body) as { secret: string; provisioningUri: string };

      const confirm = await inject({
        method: "POST",
        url: "/v1/auth/mfa/bootstrap/confirm",
        payload: {
          challenge,
          code: new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate(),
        },
      });
      expect(confirm.statusCode, confirm.body).toBe(200);
      const session = JSON.parse(confirm.body) as {
        accessToken: string;
        recoveryCodes: string[];
      };
      expect(session.recoveryCodes.length).toBeGreaterThan(0);

      // The session is real: it authorises a permission-gated route.
      const authorised = await inject({
        method: "GET",
        url: "/test/needs-ledger",
        token: session.accessToken,
      });
      expect(authorised.statusCode).toBe(200);
    });

    it("scopes the bootstrap enrolment to the tenant the CHALLENGE names", async () => {
      // The tenant is taken from the signed token, never from the request. A
      // second tenant is the only way to show that write landed in the right
      // one — passing the wrong id would still have satisfied `withTenant`.
      await seedUser(tenantA, "scoped@a.tn", ["OWNER"], false);

      const login = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "scoped@a.tn", password: PASSWORD },
      });
      const { challenge } = JSON.parse(login.body) as { challenge: string };

      const enrol = await inject({
        method: "POST",
        url: "/v1/auth/mfa/bootstrap/enrol",
        payload: { challenge },
      });
      expect(enrol.statusCode).toBe(200);

      const row = await database.migrator.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenantA}, true)`;
        const found = await tx<{ mfa_secret: string | null }[]>`
          select mfa_secret from users where tenant_id = ${tenantA} and email = 'scoped@a.tn'`;
        return found[0];
      });
      expect(row?.mfa_secret).not.toBeNull();
    });

    it("still hides a WRONG PASSWORD on an MFA-enrolled account", async () => {
      // The disclosure boundary. Naming the MFA state is safe only because the
      // password was already correct; a wrong password must reach the same
      // opaque 401 as any other, and must not reveal that the account exists.
      await seedUser(tenantA, "guarded@a.tn", ["FINANCE"]);

      const response = await inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: { tenantId: tenantA, email: "guarded@a.tn", password: "wrong" },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body["challenge"]).toBeUndefined();
      expect(body["detail"]).toBe("Invalid credentials");
    });
  });

  /**
   * ⚠️ The request id ends up in a UUID COLUMN, so its format is a correctness
   * constraint, not a logging preference.
   *
   * `TenantContextInterceptor` copies `request.id` into the tenant context and
   * `AuditService` writes it to `audit_log.correlation_id`. Fastify's default
   * generator emits `req-1`, `req-2`, … — `invalid input syntax for type uuid`
   * — and because the audit row is written in the CALLER'S transaction, the
   * rejection rolled the command back with it. Every audited mutating endpoint
   * answered 500 over HTTP while its unit tests passed, because a unit test
   * calls the service directly with a real UUID or no request id at all.
   */
  describe("request id", () => {
    it("writes an audit row on a real request", async () => {
      const token = await tokenFor(["OWNER"], "audited@a.tn");

      const response = await inject({ method: "GET", url: "/test/audited", token });

      expect(response.statusCode, response.body).toBe(200);
    });

    it("is a UUID, so the correlation id is storable", async () => {
      const response = await inject({ method: "GET", url: "/test/public" });

      // Echoed back to the caller, which is how a client joins its logs to ours.
      const echoed = response.headers["x-request-id"];
      expect(typeof echoed).toBe("string");
      expect(echoed).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );
    });

    it("adopts a caller's x-request-id when it is a UUID", async () => {
      const supplied = randomUUID();
      const response = await inject({
        method: "GET",
        url: "/test/public",
        headers: { "x-request-id": supplied },
      });

      expect(response.headers["x-request-id"]).toBe(supplied);
    });

    it("REPLACES a caller's x-request-id when it is not a UUID", async () => {
      // Otherwise the original bug comes back with a remote trigger: any client
      // could make every audited command in its request fail by sending junk.
      const response = await inject({
        method: "GET",
        url: "/test/public",
        headers: { "x-request-id": "req-7" },
      });

      expect(response.headers["x-request-id"]).not.toBe("req-7");
    });

    it("survives a junk x-request-id on an AUDITED request", async () => {
      // The two rules meeting: sanitised at the edge, so the write still lands.
      const token = await tokenFor(["OWNER"], "audited-junk@a.tn");

      const response = await inject({
        method: "GET",
        url: "/test/audited",
        token,
        headers: { "x-request-id": "'; drop table audit_log; --" },
      });

      expect(response.statusCode, response.body).toBe(200);
    });
  });
});
