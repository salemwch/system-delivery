import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthService } from "../src/modules/identity/application/auth.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { MfaService } from "../src/modules/identity/application/mfa.service.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { TokenService } from "../src/modules/identity/application/token.service.js";
import {
  ROLE_PERMISSIONS,
  permissionsForRoles,
} from "../src/modules/identity/domain/permissions.js";
import { AccessService } from "../src/modules/identity/application/access.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { asTenantId } from "../src/shared/database/tenant-context.js";
import type { TenantId } from "../src/shared/database/tenant-context.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { stubConfig } from "./config.stub.js";

/**
 * Identity: authentication, lockout, refresh rotation, and authorization.
 *
 * Failure paths are tested as thoroughly as the success path — an auth system
 * is defined by what it refuses, not by what it allows.
 */
describe("identity", () => {
  let database: TestDatabase;
  let dbService: DatabaseService;
  let passwords: PasswordService;
  let tokens: TokenService;
  let auth: AuthService;
  let access: AccessService;

  let tenantA: TenantId;
  let tenantB: TenantId;

  const PASSWORD = "correct-horse-battery-staple-9271";

  /** Creates an ACTIVE user with roles, returning its id. */
  async function seedUser(
    tenantId: TenantId,
    email: string,
    roles: string[],
    overrides: { status?: string; mfaEnabled?: boolean } = {},
  ): Promise<string> {
    const passwordHash = await passwords.hash(PASSWORD);

    return database.migrator.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
      const inserted = await tx<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, full_name, status, mfa_enabled)
        values (${tenantId}, ${email}, ${passwordHash}, 'Test User',
                ${overrides.status ?? "ACTIVE"}, ${overrides.mfaEnabled ?? false})
        returning id
      `;
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("failed to seed user");
      }
      for (const role of roles) {
        await tx`
          insert into user_roles (tenant_id, user_id, role)
          values (${tenantId}, ${row.id}, ${role})
        `;
      }
      return row.id;
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    dbService = new DatabaseService(database.app);
    passwords = new PasswordService();
    tokens = new TokenService(stubConfig());
    auth = new AuthService(
      dbService,
      passwords,
      tokens,
      new AuditService(dbService),
      new MfaService(
        dbService,
        passwords,
        new AuditService(dbService),
        new FieldCipher(randomBytes(32)),
      ),
    );
    access = new AccessService();

    tenantA = asTenantId(await createTenant(database.migrator, "identity-a"));
    tenantB = asTenantId(await createTenant(database.migrator, "identity-b"));
  });

  afterAll(async () => {
    await deleteTenants(database.migrator, [tenantA, tenantB]);
    await database.close();
  });

  describe("password hashing", () => {
    it("produces a verifiable Argon2id hash", async () => {
      const hash = await passwords.hash(PASSWORD);
      expect(hash.startsWith("$argon2id$")).toBe(true);
      expect(await passwords.verify(PASSWORD, hash)).toBe(true);
    });

    it("rejects a wrong password", async () => {
      const hash = await passwords.hash(PASSWORD);
      expect(await passwords.verify("not-the-password", hash)).toBe(false);
    });

    it("produces a different hash each time (random salt)", async () => {
      const [first, second] = await Promise.all([
        passwords.hash(PASSWORD),
        passwords.hash(PASSWORD),
      ]);
      expect(first).not.toBe(second);
    });

    it("returns false rather than throwing on a corrupt stored hash", async () => {
      expect(await passwords.verify(PASSWORD, "not-a-hash")).toBe(false);
      expect(await passwords.verify(PASSWORD, "")).toBe(false);
    });

    it("refuses to hash an empty password", async () => {
      await expect(passwords.hash("")).rejects.toThrow(/empty password/i);
    });

    it("flags weaker-parameter and unparseable hashes for rehashing", async () => {
      const current = await passwords.hash(PASSWORD);
      expect(passwords.needsRehash(current)).toBe(false);

      // Lower memory cost than current policy.
      expect(
        passwords.needsRehash("$argon2id$v=19$m=4096,t=2,p=1$c2FsdHNhbHQ$ZGlnZXN0ZGlnZXN0"),
      ).toBe(true);
      expect(passwords.needsRehash("garbage")).toBe(true);
      expect(passwords.needsRehash("$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$ZGln")).toBe(true);
    });

    it("verifyDummy always fails but performs real work", async () => {
      const started = process.hrtime.bigint();
      const result = await passwords.verifyDummy(PASSWORD);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

      expect(result).toBe(false);
      // A parse failure would return in well under a millisecond. Real Argon2id
      // work at 19 MiB cannot. This asserts the timing defence is genuine.
      expect(elapsedMs).toBeGreaterThan(1);
    });
  });

  describe("login", () => {
    it("issues a session for valid credentials", async () => {
      await seedUser(tenantA, "dispatcher@a.tn", ["DISPATCHER"]);

      const result = await auth.login({
        tenantId: tenantA,
        email: "dispatcher@a.tn",
        password: PASSWORD,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.session.accessToken.length).toBeGreaterThan(0);
      expect(result.session.refreshToken.length).toBeGreaterThan(0);
      expect(result.session.principal.tenantId).toBe(tenantA);
      expect(result.session.principal.roles).toEqual(["DISPATCHER"]);
    });

    it("accepts a differently-cased email", async () => {
      await seedUser(tenantA, "casing@a.tn", ["DISPATCHER"]);
      const result = await auth.login({
        tenantId: tenantA,
        email: "  CASING@A.TN  ",
        password: PASSWORD,
      });
      expect(result.ok).toBe(true);
    });

    it("rejects a wrong password", async () => {
      await seedUser(tenantA, "wrongpw@a.tn", ["DISPATCHER"]);
      const result = await auth.login({
        tenantId: tenantA,
        email: "wrongpw@a.tn",
        password: "wrong",
      });
      expect(result).toEqual({ ok: false, reason: "BAD_PASSWORD" });
    });

    it("rejects an unknown email", async () => {
      const result = await auth.login({
        tenantId: tenantA,
        email: "nobody@a.tn",
        password: PASSWORD,
      });
      expect(result).toEqual({ ok: false, reason: "UNKNOWN_USER" });
    });

    it("rejects a disabled account", async () => {
      await seedUser(tenantA, "disabled@a.tn", ["DISPATCHER"], { status: "DISABLED" });
      const result = await auth.login({
        tenantId: tenantA,
        email: "disabled@a.tn",
        password: PASSWORD,
      });
      expect(result).toEqual({ ok: false, reason: "ACCOUNT_DISABLED" });
    });

    it("refuses an OWNER without MFA (fail closed)", async () => {
      await seedUser(tenantA, "owner@a.tn", ["OWNER"], { mfaEnabled: false });
      const result = await auth.login({
        tenantId: tenantA,
        email: "owner@a.tn",
        password: PASSWORD,
      });
      // MFA_ENROLMENT_REQUIRED, not MFA_REQUIRED: the two are different states.
      // This account has never enrolled, so there is no factor to challenge —
      // it holds no session and can do nothing but enrol one.
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("MFA_ENROLMENT_REQUIRED");
      // A challenge IS issued, and must be: without it this role could never
      // log in and never enrol, locking an OWNER out of their own tenant.
      expect(result.challenge).toBeDefined();
    });

    it("locks the account after repeated failures, then rejects even a correct password", async () => {
      await seedUser(tenantA, "lockout@a.tn", ["DISPATCHER"]);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const failed = await auth.login({
          tenantId: tenantA,
          email: "lockout@a.tn",
          password: "wrong",
        });
        expect(failed.ok).toBe(false);
      }

      const locked = await auth.login({
        tenantId: tenantA,
        email: "lockout@a.tn",
        password: PASSWORD,
      });
      expect(locked).toEqual({ ok: false, reason: "ACCOUNT_LOCKED" });
    });

    it("clears the failure counter after a successful login", async () => {
      await seedUser(tenantA, "recover@a.tn", ["DISPATCHER"]);

      await auth.login({ tenantId: tenantA, email: "recover@a.tn", password: "wrong" });
      const ok = await auth.login({
        tenantId: tenantA,
        email: "recover@a.tn",
        password: PASSWORD,
      });
      expect(ok.ok).toBe(true);

      // Tenant context is required even as the owner: `users` uses FORCE RLS,
      // so an unscoped query correctly returns zero rows.
      const rows = await withTenantContext(
        database.migrator,
        tenantA,
        (tx) =>
          tx<{ failed_login_count: number }[]>`
          select failed_login_count from users where email = 'recover@a.tn'
        `,
      );
      expect(rows[0]?.failed_login_count).toBe(0);
    });

    it("does not authenticate a user from another tenant", async () => {
      await seedUser(tenantB, "shared@b.tn", ["DISPATCHER"]);

      // Same email, wrong tenant — RLS makes the row invisible.
      const result = await auth.login({
        tenantId: tenantA,
        email: "shared@b.tn",
        password: PASSWORD,
      });
      expect(result).toEqual({ ok: false, reason: "UNKNOWN_USER" });
    });

    it("allows the same email in two different tenants", async () => {
      await seedUser(tenantA, "duplicate@shared.tn", ["DISPATCHER"]);
      await seedUser(tenantB, "duplicate@shared.tn", ["FINANCE"], { mfaEnabled: true });

      const inA = await auth.login({
        tenantId: tenantA,
        email: "duplicate@shared.tn",
        password: PASSWORD,
      });
      const inB = await auth.login({
        tenantId: tenantB,
        email: "duplicate@shared.tn",
        password: PASSWORD,
      });

      expect(inA.ok).toBe(true);

      // Tenant B's user has a second factor, so the correct password buys a
      // CHALLENGE rather than a session. That is the point of the change: this
      // assertion used to be `inB.ok === true`, because `mfa_enabled` was set
      // with no enrolment behind it and the flag alone granted a session.
      // Reaching the challenge still proves the email resolved to a different
      // user in tenant B and that the password matched it.
      expect(inB.ok).toBe(false);
      if (inB.ok) throw new Error("unreachable");
      expect(inB.reason).toBe("MFA_REQUIRED");
      expect(inB.challenge).toBeDefined();

      if (!inA.ok) throw new Error("tenant A login should have succeeded");
      expect(inA.session.principal.roles).toEqual(["DISPATCHER"]);
      // Tenant A's session is scoped to tenant A, never to B.
      expect(inA.session.principal.tenantId).toBe(tenantA);
    });
  });

  describe("access tokens", () => {
    it("round-trips claims and pins the algorithm", async () => {
      await seedUser(tenantA, "token@a.tn", ["DISPATCHER"]);
      const result = await auth.login({
        tenantId: tenantA,
        email: "token@a.tn",
        password: PASSWORD,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const claims = await tokens.verifyAccessToken(result.session.accessToken);
      expect(claims?.tid).toBe(tenantA);
      expect(claims?.typ).toBe("user");
      expect(claims?.rol).toEqual(["DISPATCHER"]);
    });

    it("rejects a tampered, malformed, or empty token", async () => {
      await seedUser(tenantA, "tamper@a.tn", ["DISPATCHER"]);
      const result = await auth.login({
        tenantId: tenantA,
        email: "tamper@a.tn",
        password: PASSWORD,
      });
      if (!result.ok) throw new Error("login failed");

      const tampered = `${result.session.accessToken.slice(0, -3)}abc`;
      expect(await tokens.verifyAccessToken(tampered)).toBeNull();
      expect(await tokens.verifyAccessToken("not.a.token")).toBeNull();
      expect(await tokens.verifyAccessToken("")).toBeNull();
    });

    it("rejects a token signed with a different secret", async () => {
      const other = new TokenService(stubConfig({ JWT_ACCESS_SECRET: "b".repeat(48) }));
      const foreign = await other.issueAccessToken({
        userId: "018f0000-0000-7000-8000-000000000001",
        tenantId: tenantA,
        actorType: "user",
        roles: ["OWNER"],
        permissions: permissionsForRoles(["OWNER"]),
        hubScope: [],
        merchantId: null,
        sessionId: "018f0000-0000-7000-8000-000000000002",
      });

      expect(await tokens.verifyAccessToken(foreign.token)).toBeNull();
    });
  });

  describe("refresh rotation and reuse detection", () => {
    it("rotates a refresh token and invalidates the old one", async () => {
      await seedUser(tenantA, "rotate@a.tn", ["DISPATCHER"]);
      const first = await auth.login({
        tenantId: tenantA,
        email: "rotate@a.tn",
        password: PASSWORD,
      });
      if (!first.ok) throw new Error("login failed");

      const second = await auth.refresh(tenantA, first.session.refreshToken);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.session.refreshToken).not.toBe(first.session.refreshToken);

      // The original token is now spent.
      const replay = await auth.refresh(tenantA, first.session.refreshToken);
      expect(replay.ok).toBe(false);
    });

    it("revokes the whole family when a rotated token is replayed", async () => {
      await seedUser(tenantA, "reuse@a.tn", ["DISPATCHER"]);
      const first = await auth.login({
        tenantId: tenantA,
        email: "reuse@a.tn",
        password: PASSWORD,
      });
      if (!first.ok) throw new Error("login failed");

      const second = await auth.refresh(tenantA, first.session.refreshToken);
      if (!second.ok) throw new Error("refresh failed");

      // Attacker replays the stolen, already-rotated token.
      const replay = await auth.refresh(tenantA, first.session.refreshToken);
      expect(replay.ok).toBe(false);

      // The legitimate holder's current token is revoked too — theft becomes a
      // detected incident rather than silent persistent access.
      const afterBreach = await auth.refresh(tenantA, second.session.refreshToken);
      expect(afterBreach.ok).toBe(false);
    });

    it("rejects an unknown refresh token", async () => {
      const result = await auth.refresh(tenantA, "completely-made-up-token");
      expect(result.ok).toBe(false);
    });

    it("revokes every live session on demand", async () => {
      const userId = await seedUser(tenantA, "revokeall@a.tn", ["DISPATCHER"]);
      const session = await auth.login({
        tenantId: tenantA,
        email: "revokeall@a.tn",
        password: PASSWORD,
      });
      if (!session.ok) throw new Error("login failed");

      const revoked = await auth.revokeAllSessions(tenantA, userId, "TEST");
      expect(revoked).toBeGreaterThan(0);

      const afterRevoke = await auth.refresh(tenantA, session.session.refreshToken);
      expect(afterRevoke.ok).toBe(false);
    });

    it("stores only a digest, never the refresh token itself", async () => {
      await seedUser(tenantA, "digest@a.tn", ["DISPATCHER"]);
      const session = await auth.login({
        tenantId: tenantA,
        email: "digest@a.tn",
        password: PASSWORD,
      });
      if (!session.ok) throw new Error("login failed");

      const rows = await withTenantContext(
        database.migrator,
        tenantA,
        (tx) => tx<{ token_digest: string }[]>`select token_digest from refresh_tokens`,
      );
      const raw = session.session.refreshToken;
      for (const row of rows) {
        expect(row.token_digest).not.toBe(raw);
      }
      expect(rows.some((row) => row.token_digest === tokens.digestRefreshToken(raw))).toBe(true);
    });
  });

  describe("authorization", () => {
    const principalWith = (roles: Parameters<typeof permissionsForRoles>[0]) => ({
      userId: "018f0000-0000-7000-8000-00000000000a",
      tenantId: tenantA,
      actorType: "user" as const,
      roles,
      permissions: permissionsForRoles(roles),
      hubScope: [] as readonly string[],
      merchantId: null,
      sessionId: "018f0000-0000-7000-8000-00000000000b",
    });

    it("grants OWNER every permission", () => {
      const owner = principalWith(["OWNER"]);
      expect(access.can(owner, "ledger:adjust")).toBe(true);
      expect(access.can(owner, "shipment:assign")).toBe(true);
    });

    it("denies DISPATCHER access to COD amounts", () => {
      // Deliberate: dispatchers do not need cash figures, and excluding them
      // shrinks the blast radius of the most numerous account type.
      const dispatcher = principalWith(["DISPATCHER"]);
      expect(access.can(dispatcher, "shipment:assign")).toBe(true);
      expect(access.can(dispatcher, "cod:read_amount")).toBe(false);
      expect(access.can(dispatcher, "ledger:adjust")).toBe(false);
    });

    it("keeps FINANCE read-only on operations (separation of duties)", () => {
      const finance = principalWith(["FINANCE"]);
      expect(access.can(finance, "ledger:adjust")).toBe(true);
      expect(access.can(finance, "settlement:approve")).toBe(true);
      expect(access.can(finance, "shipment:assign")).toBe(false);
      expect(access.can(finance, "shipment:override_status")).toBe(false);
    });

    it("gives DRIVER only field operations", () => {
      const driver = principalWith(["DRIVER"]);
      expect(access.can(driver, "shipment:deliver")).toBe(true);
      expect(access.can(driver, "cod:collect")).toBe(true);
      expect(access.can(driver, "user:manage")).toBe(false);
      expect(access.can(driver, "cod:remit_receive")).toBe(false);
    });

    it("unions permissions across multiple roles", () => {
      const both = principalWith(["DISPATCHER", "FINANCE"]);
      expect(access.can(both, "shipment:assign")).toBe(true);
      expect(access.can(both, "ledger:adjust")).toBe(true);
    });

    it("rejects unknown permission names", () => {
      const owner = principalWith(["OWNER"]);
      expect(access.canByName(owner, "shipment:teleport")).toBe(false);
      expect(access.canByName(owner, "")).toBe(false);
    });

    it("enforces hub scoping", () => {
      const unscoped = principalWith(["HUB_OPERATOR"]);
      expect(access.canAccessHub(unscoped, "any-hub")).toBe(true);

      const scoped = { ...unscoped, hubScope: ["hub-1"] as readonly string[] };
      expect(access.canAccessHub(scoped, "hub-1")).toBe(true);
      expect(access.canAccessHub(scoped, "hub-2")).toBe(false);
    });

    it("keeps every role's permissions within the declared catalogue", () => {
      for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
        for (const permission of permissions) {
          expect(
            permissionsForRoles(["OWNER"]).has(permission),
            `${role} grants "${permission}", which OWNER does not have — the catalogue is inconsistent`,
          ).toBe(true);
        }
      }
    });
  });
});
