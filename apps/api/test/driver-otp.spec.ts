import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AuthService } from "../src/modules/identity/application/auth.service.js";
import type { OtpService } from "../src/modules/identity/application/otp.service.js";
import { UserService } from "../src/modules/identity/application/user.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { buildAuthStack } from "./auth.factory.js";
import type { CapturingNotificationProvider } from "./auth.factory.js";

/**
 * Driver phone/OTP login (docs/01-mvp-scope.md §4.1 #1.4).
 *
 * ⚠️ Drivers previously had NO working login path at all — the DRIVER role and
 * the token type existed, but nothing issued one, so the whole Android app
 * (§4.4) had no way in.
 *
 * An OTP is a credential, so most of what follows is about refusals: a replayed
 * code, a brute-forced code, an expired one, a rate-limited request, and — the
 * one that is easiest to get wrong — a response that would tell an attacker
 * whether a phone number belongs to a real driver.
 */
describe("driver otp", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let auth: AuthService;
  let otp: OtpService;
  let sms: CapturingNotificationProvider;
  let usersService: UserService;
  let createdTenants: string[] = [];

  const PHONE = "+21620555001";

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

  /** Creates an ACTIVE driver login on `phone`. */
  async function seedDriver(
    tenantId: string,
    phone: string,
    role: "DRIVER" | "DISPATCHER" = "DRIVER",
  ): Promise<string> {
    const created = await asAdmin(tenantId, () =>
      usersService.create({
        email: email("driver"),
        fullName: "Test Driver",
        phone,
        roles: [role],
      }),
    );
    return created.user.id;
  }

  /** Requests a code and returns what the SMS actually carried. */
  async function requestCode(tenantId: string, phone: string): Promise<string | null> {
    await auth.requestDriverOtp(tenantId, phone);
    return sms.lastCodeFor(phone);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const stack = buildAuthStack(db);
    ({ auth, otp, sms } = stack);
    usersService = new UserService(db, stack.passwords, new OutboxService(), stack.audit);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
    sms.clear();
  });

  afterAll(async () => {
    await database.close();
  });

  // ── The happy path ─────────────────────────────────────────────────────────

  describe("login", () => {
    it("sends a code and exchanges it for a driver session", async () => {
      const tenantId = await seedTenant("otp");
      const userId = await seedDriver(tenantId, PHONE);

      const code = await requestCode(tenantId, PHONE);
      expect(code).toMatch(/^\d{6}$/u);
      if (code === null) throw new Error("expected a code");

      const result = await auth.verifyDriverOtp(tenantId, PHONE, code);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");

      expect(result.session.principal.userId).toBe(userId);
      // `driver`, not `user`: it selects the longer driver token TTL and is what
      // the telemetry and shift endpoints check.
      expect(result.session.principal.actorType).toBe("driver");
      expect(result.session.principal.roles).toEqual(["DRIVER"]);
    });

    it("issues a token that carries driver permissions", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      const code = await requestCode(tenantId, PHONE);
      if (code === null) throw new Error("expected a code");

      const result = await auth.verifyDriverOtp(tenantId, PHONE, code);
      if (!result.ok) throw new Error("expected a session");

      // The permissions the Android app actually needs.
      expect(result.session.principal.permissions.has("telemetry:write")).toBe(true);
      expect(result.session.principal.permissions.has("shipment:deliver")).toBe(true);
      expect(result.session.principal.permissions.has("cod:collect")).toBe(true);
      // And not the ones it must never have.
      expect(result.session.principal.permissions.has("user:manage")).toBe(false);
      expect(result.session.principal.permissions.has("ledger:adjust")).toBe(false);
    });

    it("sends the message in the driver's own language", async () => {
      const tenantId = await seedTenant("otp");
      await asAdmin(tenantId, () =>
        usersService.create({
          email: email("ar"),
          fullName: "سائق",
          phone: PHONE,
          locale: "ar",
          roles: ["DRIVER"],
        }),
      );

      await auth.requestDriverOtp(tenantId, PHONE);
      const message = sms.sent.at(-1);
      // Arabic, because a driver who reads Arabic gets Arabic.
      expect(message?.body).toContain("رمز الدخول");
      expect(message?.channel).toBe("SMS");
    });
  });

  // ── The enumeration oracle, which is the easy mistake ──────────────────────

  describe("driver enumeration", () => {
    it("answers identically for a registered and an unregistered number", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);

      const known = await auth.requestDriverOtp(tenantId, PHONE);
      const unknown = await auth.requestDriverOtp(tenantId, "+21620555999");

      // A different shape here would let anyone enumerate a courier's fleet one
      // number at a time. The roster is competitive information and the numbers
      // are personal data.
      expect(known).toEqual(unknown);
    });

    it("does NOT send a message for an unregistered number", async () => {
      const tenantId = await seedTenant("otp");

      await auth.requestDriverOtp(tenantId, "+21620555998");

      // The response claimed a code was on its way; no SMS was actually sent.
      expect(sms.sent).toHaveLength(0);
    });

    it("does NOT send to a DISABLED driver, and says so to nobody", async () => {
      const tenantId = await seedTenant("otp");
      const userId = await seedDriver(tenantId, PHONE);
      const admin = await seedDriver(tenantId, "+21620555002", "DISPATCHER");
      await asAdmin(tenantId, () => usersService.disable(userId, "left", admin));
      sms.clear();

      const outcome = await auth.requestDriverOtp(tenantId, PHONE);

      expect(outcome.ok).toBe(true);
      expect(sms.sent).toHaveLength(0);
    });

    it("refuses OTP login for a non-driver account that happens to have a phone", async () => {
      const tenantId = await seedTenant("otp");
      // A dispatcher with a phone on file. OTP is the DRIVER channel; letting
      // any account with a number bypass its password would be a downgrade
      // attack on every other role, including the MFA-required ones.
      await seedDriver(tenantId, PHONE, "DISPATCHER");

      await auth.requestDriverOtp(tenantId, PHONE);
      expect(sms.sent).toHaveLength(0);
    });
  });

  // ── The code is a credential ───────────────────────────────────────────────

  describe("code handling", () => {
    it("stores the code hashed, never in the clear", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      const code = await requestCode(tenantId, PHONE);
      if (code === null) throw new Error("expected a code");

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ code_hash: string }[]>`select code_hash from otp_codes`,
      );

      // A database read must not yield a working login.
      expect(rows[0]?.code_hash).toMatch(/^\$argon2id\$/u);
      expect(JSON.stringify(rows)).not.toContain(code);
    });

    it("is single-use — the same code never works twice", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      const code = await requestCode(tenantId, PHONE);
      if (code === null) throw new Error("expected a code");

      const first = await auth.verifyDriverOtp(tenantId, PHONE, code);
      expect(first.ok).toBe(true);

      const second = await auth.verifyDriverOtp(tenantId, PHONE, code);
      expect(second.ok).toBe(false);
    });

    it("retires the previous code when a new one is requested", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);

      const first = await requestCode(tenantId, PHONE);
      if (first === null) throw new Error("expected a code");

      // Past the resend cooldown.
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`update otp_codes set created_at = now() - interval '2 minutes'`,
      );
      const second = await requestCode(tenantId, PHONE);
      if (second === null) throw new Error("expected a second code");

      // Two live codes at once doubles the guessing surface.
      const stale = await auth.verifyDriverOtp(tenantId, PHONE, first);
      expect(stale.ok).toBe(false);

      const fresh = await auth.verifyDriverOtp(tenantId, PHONE, second);
      expect(fresh.ok).toBe(true);
    });

    it("refuses an expired code", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      const code = await requestCode(tenantId, PHONE);
      if (code === null) throw new Error("expected a code");

      // Ages the whole row rather than pulling `expires_at` back on its own —
      // the `expires_at > created_at` constraint correctly rejects that, and
      // moving both is what actually happens as time passes.
      await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx`
          update otp_codes
          set created_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes'
        `,
      );

      const result = await auth.verifyDriverOtp(tenantId, PHONE, code);
      expect(result.ok).toBe(false);
    });

    it("kills the code after five wrong guesses", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      const code = await requestCode(tenantId, PHONE);
      if (code === null) throw new Error("expected a code");

      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i += 1) {
        await auth.verifyDriverOtp(tenantId, PHONE, wrong);
      }

      // A 6-digit code is one-in-a-million per guess — which only means
      // anything if the guesses are finite. Even the RIGHT code is now dead.
      const result = await auth.verifyDriverOtp(tenantId, PHONE, code);
      expect(result.ok).toBe(false);

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ consumed_at: Date | null }[]>`select consumed_at from otp_codes`,
      );
      // Consumed outright rather than left to expire, so it stops being a
      // candidate for the next guess.
      expect(rows[0]?.consumed_at).not.toBeNull();
    });

    it("refuses a code issued for a different phone", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      const other = "+21620555003";
      await seedDriver(tenantId, other);

      const code = await requestCode(tenantId, PHONE);
      if (code === null) throw new Error("expected a code");

      const result = await auth.verifyDriverOtp(tenantId, other, code);
      expect(result.ok).toBe(false);
    });

    it("refuses a code from another tenant", async () => {
      const tenantA = await seedTenant("otp-a");
      const tenantB = await seedTenant("otp-b");
      await seedDriver(tenantA, PHONE);
      await seedDriver(tenantB, PHONE);

      const codeA = await requestCode(tenantA, PHONE);
      if (codeA === null) throw new Error("expected a code");

      // Same number, different courier. RLS scopes the lookup, so tenant B
      // never sees tenant A's code.
      const result = await auth.verifyDriverOtp(tenantB, PHONE, codeA);
      expect(result.ok).toBe(false);
    });
  });

  // ── Rate limiting: SMS costs money and lands on a real handset ─────────────

  describe("rate limiting", () => {
    it("refuses a second request inside the resend cooldown", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);

      const first = await auth.requestDriverOtp(tenantId, PHONE);
      expect(first.ok).toBe(true);

      const second = await auth.requestDriverOtp(tenantId, PHONE);
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("unreachable");
      expect(second.reason).toBe("RATE_LIMITED");
      expect(second.retryAfterSeconds).toBeGreaterThan(0);

      // The cost of getting this wrong is a bill and a harassed stranger.
      expect(sms.sent).toHaveLength(1);
    });

    it("caps the number of codes per phone in the window", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);

      // Three requests, each past the cooldown but inside the window.
      for (let i = 0; i < 3; i += 1) {
        await auth.requestDriverOtp(tenantId, PHONE);
        await withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update otp_codes set created_at = created_at - interval '2 minutes'`,
        );
      }

      const blocked = await auth.requestDriverOtp(tenantId, PHONE);
      // Otherwise a caller drips messages at the cooldown interval forever.
      expect(blocked.ok).toBe(false);
    });

    it("rate-limits an UNREGISTERED number too", async () => {
      const tenantId = await seedTenant("otp");
      const stranger = "+21620555997";

      await auth.requestDriverOtp(tenantId, stranger);
      const second = await auth.requestDriverOtp(tenantId, stranger);

      // If only known numbers were limited, the rate-limit response itself
      // would become the enumeration oracle the endpoint is designed to avoid.
      expect(second.ok).toBe(false);
    });
  });

  // ── The trail ──────────────────────────────────────────────────────────────

  describe("audit", () => {
    it("records a successful driver login", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      const code = await requestCode(tenantId, PHONE);
      if (code === null) throw new Error("expected a code");

      await auth.verifyDriverOtp(tenantId, PHONE, code, { ipAddress: "196.203.1.9" });

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string; actor_type: string; context: Record<string, unknown> }[]>`
          select action, actor_type, context from audit_log
          where resource_type = 'driver' order by id desc
        `,
      );
      const entry = rows.find((r) => r.action === "auth.login_succeeded");
      expect(entry?.actor_type).toBe("DRIVER");
      expect(entry?.context["channel"]).toBe("OTP");
    });

    it("records a failed verification without the code", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);
      await requestCode(tenantId, PHONE);

      await auth.verifyDriverOtp(tenantId, PHONE, "000000");

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ action: string; context: Record<string, unknown> }[]>`
          select action, context from audit_log where resource_type = 'driver'
        `,
      );
      const failure = rows.find((r) => r.action === "auth.login_failed");
      expect(failure).toBeDefined();
      expect(JSON.stringify(rows)).not.toContain("000000");
    });
  });

  // ── Storage guarantees ─────────────────────────────────────────────────────

  describe("otp_codes table", () => {
    it("denies the application DELETE, so an attacker cannot erase the evidence", async () => {
      const rows = await database.migrator<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
        where table_name = 'otp_codes' and grantee = 'dp_app'
      `;
      const granted = new Set(rows.map((r) => r.privilege_type));

      expect(granted.has("SELECT")).toBe(true);
      expect(granted.has("INSERT")).toBe(true);
      // UPDATE marks a code consumed.
      expect(granted.has("UPDATE")).toBe(true);
      // The rows record how many codes a number asked for and how many wrong
      // guesses it took — that is the record of an attack.
      expect(granted.has("DELETE")).toBe(false);
    });

    it("enforces one login per phone per tenant", async () => {
      const tenantId = await seedTenant("otp");
      await seedDriver(tenantId, PHONE);

      // Two accounts on one number would make "whose session does this code
      // mint?" ambiguous.
      await expect(seedDriver(tenantId, PHONE)).rejects.toThrow();
    });

    it("exposes the OTP service directly for a service-level check", async () => {
      const tenantId = await seedTenant("otp");
      await asAdmin(tenantId, async () => {
        const outcome = await otp.request("+21620555996", { deliver: false });
        expect(outcome.ok).toBe(true);
      });
      // `deliver: false` means no message even though the request succeeded.
      expect(sms.sent).toHaveLength(0);
    });
  });
});
