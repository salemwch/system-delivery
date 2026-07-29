import { randomBytes } from "node:crypto";

import { Controller, Get, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as OTPAuth from "otpauth";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthController } from "../src/modules/identity/api/auth.controller.js";
import { AuthGuard } from "../src/modules/identity/api/auth.guard.js";
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
import { ProblemDetailsFilter } from "../src/shared/http/index.js";
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

  async function seedUser(tenantId: TenantId, email: string, roles: string[]): Promise<string> {
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
    const mfaEnabled = roles.some(
      (role) => role === "OWNER" || role === "FINANCE" || role === "PLATFORM_ADMIN",
    );
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
      controllers: [ProbeController, AuthController],
      providers: [
        { provide: AppConfigService, useValue: config },
        { provide: POSTGRES_CLIENT, useValue: database.app },
        DatabaseService,
        PasswordService,
        AuditService,
        MfaService,
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

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
  }) =>
    app.inject({
      method: options.method,
      url: options.url,
      ...(options.token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${options.token}` } }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });

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
  });
});
