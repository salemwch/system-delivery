import { randomUUID } from "node:crypto";

import * as OTPAuth from "otpauth";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AuthService } from "../src/modules/identity/application/auth.service.js";
import type { MfaService } from "../src/modules/identity/application/mfa.service.js";
import type { TokenService } from "../src/modules/identity/application/token.service.js";
import { UserService } from "../src/modules/identity/application/user.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { buildAuthStack } from "./auth.factory.js";

/**
 * Multi-factor authentication (docs/07-security-architecture.md §3, §4.1).
 *
 * ⚠️ These tests exist because the `mfa_enabled` flag used to LIE. It was set
 * true at provisioning so privileged accounts could log in at all, with no
 * enrolment and no challenge behind it — OWNER, FINANCE and PLATFORM_ADMIN were
 * password-only while the system reported multi-factor.
 *
 * So the assertions here are mostly about what MUST BE REFUSED: a replayed
 * code, a reused recovery code, an access token presented as a challenge, and a
 * privileged login that skips the factor entirely.
 */
describe("mfa", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let mfa: MfaService;
  let auth: AuthService;
  let tokens: TokenService;
  let usersService: UserService;
  let createdTenants: string[] = [];

  const ISSUER = "Delivery Platform Test";

  async function asAdmin<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  function email(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}@example.tn`;
  }

  /** Generates the code an authenticator would show right now for `secret`. */
  function currentCode(secret: string, offsetSteps = 0): string {
    const totp = new OTPAuth.TOTP({
      issuer: ISSUER,
      label: "test",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
  }

  /** Creates an ACTIVE user and returns its id plus login credentials. */
  async function seedUser(
    tenantId: string,
    role: "DISPATCHER" | "OWNER" = "DISPATCHER",
  ): Promise<{ id: string; email: string; password: string }> {
    const address = email("mfa");
    const password = "a-long-enough-password-for-policy";
    const created = await asAdmin(tenantId, () =>
      usersService.create({ email: address, fullName: "MFA User", password, roles: [role] }),
    );
    // A privileged role is created with mfaEnabled true so it can authenticate
    // before enrolment exists. Clear it so these tests start from a real,
    // un-enrolled state rather than the historical shortcut.
    await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx`update users set mfa_enabled = false where id = ${created.user.id}`,
    );
    return { id: created.user.id, email: address, password };
  }

  /** Full enrolment, returning the secret and the recovery codes. */
  async function enrol(
    tenantId: string,
    userId: string,
  ): Promise<{ secret: string; recoveryCodes: readonly string[] }> {
    const challenge = await asAdmin(tenantId, () => mfa.beginEnrolment(userId, ISSUER));
    const result = await asAdmin(tenantId, () =>
      mfa.completeEnrolment(userId, currentCode(challenge.secret)),
    );
    return { secret: challenge.secret, recoveryCodes: result.recoveryCodes };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const stack = buildAuthStack(db);
    ({ auth, mfa, tokens } = stack);
    usersService = new UserService(db, stack.passwords, new OutboxService(), stack.audit);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Enrolment ──────────────────────────────────────────────────────────────

  describe("enrolment", () => {
    it("issues a provisioning URI an authenticator can consume", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);

      const challenge = await asAdmin(tenantId, () => mfa.beginEnrolment(user.id, ISSUER));

      expect(challenge.provisioningUri).toMatch(/^otpauth:\/\/totp\//u);
      expect(challenge.provisioningUri).toContain("issuer=");
      // Base32, 160 bits.
      expect(challenge.secret).toMatch(/^[A-Z2-7]{32}$/u);
    });

    it("does NOT activate MFA until a code proves the authenticator has the secret", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);

      await asAdmin(tenantId, () => mfa.beginEnrolment(user.id, ISSUER));

      const [row] = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ mfa_enabled: boolean; mfa_enrolled_at: Date | null }[]>`
          select mfa_enabled, mfa_enrolled_at from users where id = ${user.id}
        `,
      );
      // Activating here would lock out anyone whose QR scan failed.
      expect(row?.mfa_enabled).toBe(false);
      expect(row?.mfa_enrolled_at).toBeNull();
    });

    it("activates and returns recovery codes once a correct code is supplied", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);

      const { recoveryCodes } = await enrol(tenantId, user.id);

      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);

      const [row] = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ mfa_enabled: boolean; mfa_enrolled_at: Date | null }[]>`
          select mfa_enabled, mfa_enrolled_at from users where id = ${user.id}
        `,
      );
      expect(row?.mfa_enabled).toBe(true);
      expect(row?.mfa_enrolled_at).not.toBeNull();
    });

    it("rejects a wrong code at confirmation", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      await asAdmin(tenantId, () => mfa.beginEnrolment(user.id, ISSUER));

      await expect(
        asAdmin(tenantId, () => mfa.completeEnrolment(user.id, "000000")),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses to re-enrol over an ACTIVE second factor", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      await enrol(tenantId, user.id);

      // Silently replacing a working factor is an account-takeover primitive.
      // Replacing it is `reset`, which is permissioned and audited.
      await expect(
        asAdmin(tenantId, () => mfa.beginEnrolment(user.id, ISSUER)),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("allows retrying an unverified enrolment, for a failed scan", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);

      const first = await asAdmin(tenantId, () => mfa.beginEnrolment(user.id, ISSUER));
      const second = await asAdmin(tenantId, () => mfa.beginEnrolment(user.id, ISSUER));

      expect(second.secret).not.toBe(first.secret);
      // The NEW secret is the live one.
      const result = await asAdmin(tenantId, () =>
        mfa.completeEnrolment(user.id, currentCode(second.secret)),
      );
      expect(result.recoveryCodes).toHaveLength(10);
    });
  });

  // ── The secret never sits in the clear ─────────────────────────────────────

  describe("secret at rest", () => {
    it("stores the TOTP secret encrypted", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { secret } = await enrol(tenantId, user.id);

      const [row] = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ mfa_secret: string }[]>`
          select mfa_secret from users where id = ${user.id}
        `,
      );

      // docs/07 §7 classes MFA secrets CRITICAL: a database read must not yield
      // a working authenticator.
      expect(row?.mfa_secret).toMatch(/^v1:/u);
      expect(row?.mfa_secret).not.toContain(secret);
    });
  });

  // ── Replay: the defence most implementations omit ──────────────────────────

  describe("replay protection", () => {
    it("accepts a code once and REFUSES the same code again", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { secret } = await enrol(tenantId, user.id);
      // The NEXT step: enrolment already consumed the current one, and the
      // replay guard rightly refuses it a second time. Still inside the drift
      // window, so it verifies now.
      const code = currentCode(secret, 1);

      const first = await db.withTenant(
        (tx) => mfa.verifyChallenge(tx, user.id, code),
        asTenantId(tenantId),
      );
      expect(first.ok).toBe(true);

      const second = await db.withTenant(
        (tx) => mfa.verifyChallenge(tx, user.id, code),
        asTenantId(tenantId),
      );
      // Still cryptographically valid for the rest of its 30-second step. That
      // is exactly why it must be refused: a code seen over the shoulder or
      // captured by a phishing proxy is otherwise replayable.
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("unreachable");
      expect(second.reason).toBe("BAD_CODE");
    });

    it("refuses a code from an EARLIER step than one already accepted", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { secret } = await enrol(tenantId, user.id);

      // Enrolment already consumed the current step, so the previous step —
      // still inside the drift window — must not be accepted afterwards.
      const previous = currentCode(secret, -1);
      const result = await db.withTenant(
        (tx) => mfa.verifyChallenge(tx, user.id, previous),
        asTenantId(tenantId),
      );
      expect(result.ok).toBe(false);
    });
  });

  // ── Recovery codes ─────────────────────────────────────────────────────────

  describe("recovery codes", () => {
    it("stores them hashed, never in the clear", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { recoveryCodes } = await enrol(tenantId, user.id);

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ code_hash: string }[]>`
          select code_hash from mfa_recovery_codes where user_id = ${user.id}
        `,
      );

      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.code_hash).toMatch(/^\$argon2id\$/u);
      }
      // A recovery code bypasses the second factor entirely, so it is a bearer
      // credential and gets password treatment.
      const serialised = JSON.stringify(rows);
      for (const code of recoveryCodes) {
        expect(serialised).not.toContain(code);
      }
    });

    it("accepts a recovery code in place of a TOTP code", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { recoveryCodes } = await enrol(tenantId, user.id);
      const code = recoveryCodes[0];
      if (code === undefined) throw new Error("expected a recovery code");

      const result = await db.withTenant(
        (tx) => mfa.verifyChallenge(tx, user.id, code),
        asTenantId(tenantId),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.usedRecoveryCode).toBe(true);
      expect(result.remainingCodes).toBe(9);
    });

    it("burns a recovery code — the same one never works twice", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { recoveryCodes } = await enrol(tenantId, user.id);
      const code = recoveryCodes[0];
      if (code === undefined) throw new Error("expected a recovery code");

      await db.withTenant((tx) => mfa.verifyChallenge(tx, user.id, code), asTenantId(tenantId));

      const second = await db.withTenant(
        (tx) => mfa.verifyChallenge(tx, user.id, code),
        asTenantId(tenantId),
      );
      expect(second.ok).toBe(false);
    });

    it("rejects a recovery code that was never issued", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      await enrol(tenantId, user.id);

      const result = await db.withTenant(
        (tx) => mfa.verifyChallenge(tx, user.id, "ZZZZZZZZZZZZZZZZ"),
        asTenantId(tenantId),
      );
      expect(result.ok).toBe(false);
    });
  });

  // ── The login flow end to end ──────────────────────────────────────────────

  describe("login", () => {
    it("returns a challenge instead of a session when a factor is enrolled", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      await enrol(tenantId, user.id);

      const result = await auth.login({
        tenantId,
        email: user.email,
        password: user.password,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("MFA_REQUIRED");
      expect(result.challenge).toBeDefined();
    });

    it("completes the login when the challenge is answered", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { secret } = await enrol(tenantId, user.id);

      const first = await auth.login({
        tenantId,
        email: user.email,
        password: user.password,
      });
      if (first.ok || first.challenge === undefined) throw new Error("expected a challenge");

      const verified = await tokens.verifyMfaChallenge(first.challenge);
      expect(verified?.userId).toBe(user.id);

      const completed = await auth.completeMfaLogin(tenantId, user.id, currentCode(secret, 1));
      expect(completed.ok).toBe(true);
      if (!completed.ok) throw new Error("unreachable");
      expect(completed.session.accessToken).toBeDefined();
    });

    it("accepts the code inline, for a client that already has it", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { secret } = await enrol(tenantId, user.id);

      const result = await auth.login({
        tenantId,
        email: user.email,
        password: user.password,
        mfaCode: currentCode(secret, 1),
      });

      expect(result.ok).toBe(true);
    });

    it("refuses the login when the second factor is wrong", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      await enrol(tenantId, user.id);

      const result = await auth.login({
        tenantId,
        email: user.email,
        password: user.password,
        mfaCode: "000000",
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("MFA_INVALID");
    });

    it("refuses a privileged role that has never enrolled", async () => {
      const tenantId = await seedTenant("mfa");
      const owner = await seedUser(tenantId, "OWNER");

      const result = await auth.login({
        tenantId,
        email: owner.email,
        password: owner.password,
      });

      // The historical hole: this used to succeed because provisioning set the
      // flag true with nothing behind it. OWNER can move money and export PII.
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("MFA_ENROLMENT_REQUIRED");
      // A challenge is still issued, or the account could never enrol and would
      // be locked out of its own tenant permanently.
      expect(result.challenge).toBeDefined();
    });

    it("lets a never-enrolled privileged user bootstrap out of the deadlock", async () => {
      const tenantId = await seedTenant("mfa");
      const owner = await seedUser(tenantId, "OWNER");

      // 1. Password alone gets a challenge, not a session.
      const first = await auth.login({
        tenantId,
        email: owner.email,
        password: owner.password,
      });
      if (first.ok || first.challenge === undefined) throw new Error("expected a challenge");

      // 2. The challenge authorises enrolment and nothing else.
      const verified = await tokens.verifyMfaChallenge(first.challenge);
      if (verified === null) throw new Error("expected a valid challenge");
      const enrolment = await asAdmin(tenantId, () => mfa.beginEnrolment(verified.userId, ISSUER));

      // 3. Confirming activates the factor and yields the first real session.
      await asAdmin(tenantId, () =>
        mfa.completeEnrolment(verified.userId, currentCode(enrolment.secret)),
      );
      const session = await auth.issueSessionAfterEnrolment(tenantId, verified.userId);
      expect(session.accessToken).toBeDefined();
      expect(session.principal.roles).toEqual(["OWNER"]);

      // 4. From now on the account is genuinely two-factor.
      const later = await auth.login({
        tenantId,
        email: owner.email,
        password: owner.password,
      });
      expect(later.ok).toBe(false);
      if (later.ok) throw new Error("unreachable");
      expect(later.reason).toBe("MFA_REQUIRED");
    });

    it("locks the account after repeated wrong codes", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      await enrol(tenantId, user.id);

      for (let i = 0; i < 5; i += 1) {
        await auth.login({
          tenantId,
          email: user.email,
          password: user.password,
          mfaCode: "000000",
        });
      }

      const result = await auth.login({
        tenantId,
        email: user.email,
        password: user.password,
        mfaCode: "000000",
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // A correct password followed by wrong codes means someone HAS the
      // password and is working on the second factor.
      expect(result.reason).toBe("ACCOUNT_LOCKED");
    });
  });

  // ── Challenge tokens cannot be confused with sessions ──────────────────────

  describe("challenge token", () => {
    it("is rejected as an access token", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);

      const challenge = await tokens.issueMfaChallenge(user.id, tenantId);

      // It carries no roles and no permissions. If it authenticated, passing the
      // password step alone would be a full session.
      expect(await tokens.verifyAccessToken(challenge)).toBeNull();
      expect(await tokens.authenticate(challenge)).toBeNull();
    });

    it("rejects an ACCESS token presented as a challenge", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);

      const { token } = await tokens.issueAccessToken({
        userId: user.id,
        tenantId,
        actorType: "user",
        roles: ["DISPATCHER"],
        permissions: new Set(),
        hubScope: [],
        merchantId: null,
        sessionId: randomUUID(),
      });

      // Otherwise an existing session could skip the second factor.
      expect(await tokens.verifyMfaChallenge(token)).toBeNull();
    });

    it("rejects a tampered or unparseable challenge", async () => {
      expect(await tokens.verifyMfaChallenge("not-a-token")).toBeNull();
      expect(await tokens.verifyMfaChallenge("")).toBeNull();
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("clears the factor and burns outstanding recovery codes", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      const { recoveryCodes } = await enrol(tenantId, user.id);
      const admin = await seedUser(tenantId);

      await asAdmin(tenantId, () => mfa.reset(user.id, admin.id));

      const [row] = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ mfa_enabled: boolean; mfa_secret: string | null }[]>`
          select mfa_enabled, mfa_secret from users where id = ${user.id}
        `,
      );
      expect(row?.mfa_enabled).toBe(false);
      expect(row?.mfa_secret).toBeNull();

      // Codes from the previous enrolment must not survive it.
      const code = recoveryCodes[0];
      if (code === undefined) throw new Error("expected a recovery code");
      const result = await db.withTenant(
        (tx) => mfa.verifyChallenge(tx, user.id, code),
        asTenantId(tenantId),
      );
      expect(result.ok).toBe(false);

      // Burned, not deleted: DELETE is revoked so the evidence survives.
      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ count: string }[]>`
          select count(*)::text as count from mfa_recovery_codes where user_id = ${user.id}
        `,
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(10);
    });

    it("lets the user enrol again afterwards", async () => {
      const tenantId = await seedTenant("mfa");
      const user = await seedUser(tenantId);
      await enrol(tenantId, user.id);
      const admin = await seedUser(tenantId);

      await asAdmin(tenantId, () => mfa.reset(user.id, admin.id));

      const fresh = await enrol(tenantId, user.id);
      expect(fresh.recoveryCodes).toHaveLength(10);
    });
  });

  // ── Append-only guarantee on the codes table ───────────────────────────────

  describe("recovery code storage", () => {
    it("denies the application DELETE, so spent codes cannot be erased", async () => {
      const rows = await database.migrator<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
        where table_name = 'mfa_recovery_codes' and grantee = 'dp_app'
      `;
      const granted = new Set(rows.map((r) => r.privilege_type));

      expect(granted.has("SELECT")).toBe(true);
      expect(granted.has("INSERT")).toBe(true);
      // UPDATE is needed to MARK a code used.
      expect(granted.has("UPDATE")).toBe(true);
      // DELETE is not: a removed row cannot prove a code was already spent.
      expect(granted.has("DELETE")).toBe(false);
    });
  });
});
