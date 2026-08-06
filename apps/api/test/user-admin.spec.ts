import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import type { AuthService } from "../src/modules/identity/application/auth.service.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { UserService } from "../src/modules/identity/application/user.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { buildAuthStack } from "./auth.factory.js";

/**
 * User administration — the endpoint that mints the logins a courier hands out.
 *
 * The merchant portal is unusable without it: the *expéditeur* does not
 * self-register (docs/01-mvp-scope.md §5), so someone has to create the account
 * and pass on the credentials. These tests hold that flow to its promises —
 * a created account really can sign in, a disabled one really cannot, and the
 * invariant that keeps merchants apart (I23) is refused in both directions.
 */
describe("user administration", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let usersService: UserService;
  let merchants: MerchantService;
  let auth: AuthService;
  let createdTenants: string[] = [];

  async function asAdmin<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  async function seedMerchant(tenantId: string, name: string): Promise<string> {
    return asAdmin(tenantId, async () => (await merchants.create({ name })).id);
  }

  /** A unique address per call — the unique index is (tenant_id, lower(email)). */
  function email(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}@example.tn`;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const passwords = new PasswordService();
    const audit = new AuditService(db);
    usersService = new UserService(db, passwords, outbox, audit);
    merchants = new MerchantService(db, outbox, new AuditService(db));
    auth = buildAuthStack(db).auth;
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Creating a login ───────────────────────────────────────────────────────

  describe("create", () => {
    it("mints a merchant login that can actually sign in", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Ines");
      const address = email("ines");

      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: address,
          fullName: "Ines Trabelsi",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );

      // The generated password is returned exactly once, here.
      expect(created.temporaryPassword).not.toBeNull();
      expect(created.user.merchantId).toBe(merchantId);
      expect(created.user.roles).toEqual(["MERCHANT"]);
      expect(created.user.status).toBe("ACTIVE");

      const password = created.temporaryPassword;
      if (password === null) throw new Error("expected a generated password");

      // The whole point: those credentials work.
      const result = await auth.login({ tenantId, email: address, password });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("login should have succeeded");

      // And the token carries the merchant scope that RLS narrows on (I24).
      expect(result.session.principal.merchantId).toBe(merchantId);
      expect(result.session.principal.roles).toEqual(["MERCHANT"]);
    });

    it("accepts an administrator-supplied password instead of generating one", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Karim");
      const address = email("karim");
      const chosen = "chosen-password-that-is-long-enough";

      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: address,
          fullName: "Karim Ben Salah",
          password: chosen,
          roles: ["MERCHANT"],
          merchantId,
        }),
      );

      // Nothing to return: the caller already knows it.
      expect(created.temporaryPassword).toBeNull();

      const result = await auth.login({ tenantId, email: address, password: chosen });
      expect(result.ok).toBe(true);
    });

    it("stores the password only as a hash", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Hash");
      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: email("hash"),
          fullName: "Hash Test",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );
      const plaintext = created.temporaryPassword;
      if (plaintext === null) throw new Error("expected a generated password");

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ password_hash: string }[]>`
          select password_hash from users where id = ${created.user.id}
        `,
      );
      const stored = rows[0]?.password_hash ?? "";
      expect(stored).toMatch(/^\$argon2id\$/u);
      expect(stored).not.toContain(plaintext);
    });

    it("generates passwords with real entropy, never a fixed one", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Entropy");
      const seen = new Set<string>();

      for (let i = 0; i < 5; i += 1) {
        const created = await asAdmin(tenantId, () =>
          usersService.create({
            email: email(`entropy${String(i)}`),
            fullName: "Entropy Test",
            roles: ["MERCHANT"],
            merchantId,
          }),
        );
        if (created.temporaryPassword === null) throw new Error("expected a password");
        expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(24);
        seen.add(created.temporaryPassword);
      }

      expect(seen.size).toBe(5);
    });

    it("enables MFA for roles that require it, and not for those that do not", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique MFA");

      const finance = await asAdmin(tenantId, () =>
        usersService.create({
          email: email("finance"),
          fullName: "Finance User",
          roles: ["FINANCE"],
        }),
      );
      // FINANCE is fail-closed on MFA; without the flag the account could never
      // authenticate at all.
      expect(finance.user.mfaEnabled).toBe(true);

      const merchant = await asAdmin(tenantId, () =>
        usersService.create({
          email: email("merchantmfa"),
          fullName: "Merchant User",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );
      expect(merchant.user.mfaEnabled).toBe(false);
    });

    it("never exposes the password hash or MFA secret in its result", async () => {
      const tenantId = await seedTenant("useradmin");
      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: email("leak"),
          fullName: "Leak Test",
          roles: ["DISPATCHER"],
        }),
      );
      expect(Object.keys(created.user)).not.toContain("passwordHash");
      expect(Object.keys(created.user)).not.toContain("mfaSecret");
    });
  });

  // ── Invariant I23, refused in both directions ──────────────────────────────

  describe("invariant I23 (merchant scope)", () => {
    it("refuses the MERCHANT role without a merchantId", async () => {
      const tenantId = await seedTenant("useradmin");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("noscope"),
            fullName: "No Scope",
            roles: ["MERCHANT"],
          }),
        ),
        // Without a scope the narrowing matches nothing, so the account would
        // see the entire tenant — a privilege escalation, not a typo.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a merchantId on a role that is not MERCHANT", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Wrong");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("wrongscope"),
            fullName: "Wrong Scope",
            roles: ["DISPATCHER"],
            merchantId,
          }),
        ),
        // A dispatcher silently narrowed to one merchant stops seeing most of
        // their work and reads it as data loss.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses MERCHANT combined with any other role", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Mixed");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("mixed"),
            fullName: "Mixed Roles",
            roles: ["MERCHANT", "DISPATCHER"],
            merchantId,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a merchant that belongs to another tenant", async () => {
      const tenantA = await seedTenant("useradmin-a");
      const tenantB = await seedTenant("useradmin-b");
      const foreignMerchant = await seedMerchant(tenantB, "Rival Co");

      await expect(
        asAdmin(tenantA, () =>
          usersService.create({
            email: email("crosstenant"),
            fullName: "Cross Tenant",
            roles: ["MERCHANT"],
            merchantId: foreignMerchant,
          }),
        ),
        // The FK alone only proves the merchant exists; the constraint trigger
        // in migration 0019 is what proves it is OURS.
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses a merchantId that does not exist at all", async () => {
      const tenantId = await seedTenant("useradmin");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("ghost"),
            fullName: "Ghost Merchant",
            roles: ["MERCHANT"],
            merchantId: randomUUID(),
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Everything else the endpoint must refuse ───────────────────────────────

  describe("rejections", () => {
    it("refuses to mint a PLATFORM_ADMIN", async () => {
      const tenantId = await seedTenant("useradmin");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("platform"),
            fullName: "Escalation Attempt",
            roles: ["PLATFORM_ADMIN"],
          }),
        ),
        // Cross-tenant support access is granted out of band. A tenant that
        // could mint one could reach every other tenant.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses a duplicate email within the tenant", async () => {
      const tenantId = await seedTenant("useradmin");
      const address = email("dup");
      await asAdmin(tenantId, () =>
        usersService.create({ email: address, fullName: "First", roles: ["DISPATCHER"] }),
      );

      await expect(
        asAdmin(tenantId, () =>
          usersService.create({ email: address, fullName: "Second", roles: ["DISPATCHER"] }),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows the same email in a different tenant", async () => {
      const tenantA = await seedTenant("useradmin-a");
      const tenantB = await seedTenant("useradmin-b");
      const address = email("shared");

      await asAdmin(tenantA, () =>
        usersService.create({ email: address, fullName: "In A", roles: ["DISPATCHER"] }),
      );
      const inB = await asAdmin(tenantB, () =>
        usersService.create({ email: address, fullName: "In B", roles: ["DISPATCHER"] }),
      );

      // Email is unique per tenant, not globally (docs/02 §3.2 rule 1).
      expect(inB.user.email).toBe(address);
    });

    it("refuses a password shorter than the policy minimum", async () => {
      const tenantId = await seedTenant("useradmin");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("short"),
            fullName: "Short Password",
            password: "short",
            roles: ["DISPATCHER"],
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses an unknown key rather than silently ignoring it", async () => {
      const tenantId = await seedTenant("useradmin");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("strict"),
            fullName: "Strict Test",
            roles: ["DISPATCHER"],
            // A caller who believes they restricted something must not be told
            // the request succeeded.
            isSuperUser: true,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses an empty role list", async () => {
      const tenantId = await seedTenant("useradmin");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({ email: email("noroles"), fullName: "No Roles", roles: [] }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("refuses duplicate roles", async () => {
      const tenantId = await seedTenant("useradmin");
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("duproles"),
            fullName: "Dup Roles",
            roles: ["DISPATCHER", "DISPATCHER"],
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── Reading ────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns each user with their roles in a single query, and paginates", async () => {
      const tenantId = await seedTenant("useradmin");
      for (let i = 0; i < 3; i += 1) {
        await asAdmin(tenantId, () =>
          usersService.create({
            email: email(`list${String(i)}`),
            fullName: `User ${String(i)}`,
            roles: ["DISPATCHER"],
          }),
        );
      }

      const firstPage = await asAdmin(tenantId, () => usersService.list({ limit: 2 }));
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      // Roles are aggregated in the same statement — never a query per user.
      for (const user of firstPage.items) {
        expect(user.roles).toEqual(["DISPATCHER"]);
      }

      const secondPage = await asAdmin(tenantId, () =>
        usersService.list({ limit: 2, cursor: firstPage.nextCursor ?? undefined }),
      );
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();

      const ids = new Set([...firstPage.items, ...secondPage.items].map((u) => u.id));
      expect(ids.size).toBe(3);
    });

    it("filters by role, status and merchant", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Filter");

      await asAdmin(tenantId, () =>
        usersService.create({
          email: email("filter-dispatcher"),
          fullName: "Dispatcher",
          roles: ["DISPATCHER"],
        }),
      );
      const merchantUser = await asAdmin(tenantId, () =>
        usersService.create({
          email: email("filter-merchant"),
          fullName: "Merchant",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );

      const byRole = await asAdmin(tenantId, () => usersService.list({ role: "MERCHANT" }));
      expect(byRole.items.map((u) => u.id)).toEqual([merchantUser.user.id]);

      const byMerchant = await asAdmin(tenantId, () => usersService.list({ merchantId }));
      expect(byMerchant.items.map((u) => u.id)).toEqual([merchantUser.user.id]);

      const disabled = await asAdmin(tenantId, () => usersService.list({ status: "DISABLED" }));
      expect(disabled.items).toHaveLength(0);
    });

    it("never returns another tenant's users", async () => {
      const tenantA = await seedTenant("useradmin-a");
      const tenantB = await seedTenant("useradmin-b");

      const inA = await asAdmin(tenantA, () =>
        usersService.create({ email: email("iso-a"), fullName: "In A", roles: ["DISPATCHER"] }),
      );
      await asAdmin(tenantB, () =>
        usersService.create({ email: email("iso-b"), fullName: "In B", roles: ["DISPATCHER"] }),
      );

      const listedInB = await asAdmin(tenantB, () => usersService.list({}));
      expect(listedInB.items.map((u) => u.id)).not.toContain(inA.user.id);

      // Even naming the id directly — RLS, not a WHERE clause we might forget.
      await expect(
        asAdmin(tenantB, () => usersService.getById(inA.user.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Taking access away ─────────────────────────────────────────────────────

  describe("disable", () => {
    it("stops the login and revokes every live session", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Disable");
      const address = email("disable");

      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: address,
          fullName: "To Disable",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );
      const password = created.temporaryPassword;
      if (password === null) throw new Error("expected a generated password");

      const before = await auth.login({ tenantId, email: address, password });
      expect(before.ok).toBe(true);

      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("admin"), fullName: "Admin", roles: ["OWNER"] }),
      );

      const disabled = await asAdmin(tenantId, () =>
        usersService.disable(created.user.id, "left the platform", admin.user.id),
      );
      expect(disabled.status).toBe("DISABLED");

      // The password is still correct — the account is not.
      const after = await auth.login({ tenantId, email: address, password });
      expect(after.ok).toBe(false);

      // Sessions are revoked in the same transaction. Without this, the live
      // refresh token would keep minting access tokens indefinitely.
      const live = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ count: string }[]>`
          select count(*)::text as count from refresh_tokens
          where user_id = ${created.user.id} and revoked_at is null
        `,
      );
      expect(live[0]?.count).toBe("0");
    });

    it("refuses to let an administrator disable themselves", async () => {
      const tenantId = await seedTenant("useradmin");
      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("self"), fullName: "Self", roles: ["DISPATCHER"] }),
      );

      await expect(
        asAdmin(tenantId, () => usersService.disable(admin.user.id, "oops", admin.user.id)),
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("refuses to disable the tenant's last active OWNER", async () => {
      const tenantId = await seedTenant("useradmin");
      const owner = await asAdmin(tenantId, () =>
        usersService.create({ email: email("owner"), fullName: "Only Owner", roles: ["OWNER"] }),
      );
      const other = await asAdmin(tenantId, () =>
        usersService.create({ email: email("other"), fullName: "Other", roles: ["DISPATCHER"] }),
      );

      await expect(
        asAdmin(tenantId, () => usersService.disable(owner.user.id, "cleanup", other.user.id)),
        // A tenant with no active OWNER can never grant anyone access again.
      ).rejects.toBeInstanceOf(BusinessRuleError);
    });

    it("allows disabling an OWNER once a second one exists", async () => {
      const tenantId = await seedTenant("useradmin");
      const first = await asAdmin(tenantId, () =>
        usersService.create({ email: email("owner1"), fullName: "Owner One", roles: ["OWNER"] }),
      );
      const second = await asAdmin(tenantId, () =>
        usersService.create({ email: email("owner2"), fullName: "Owner Two", roles: ["OWNER"] }),
      );

      const disabled = await asAdmin(tenantId, () =>
        usersService.disable(first.user.id, "handover complete", second.user.id),
      );
      expect(disabled.status).toBe("DISABLED");
    });

    it("is idempotent — disabling twice is not an error", async () => {
      const tenantId = await seedTenant("useradmin");
      const target = await asAdmin(tenantId, () =>
        usersService.create({ email: email("twice"), fullName: "Twice", roles: ["DISPATCHER"] }),
      );
      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("admin2"), fullName: "Admin", roles: ["OWNER"] }),
      );

      await asAdmin(tenantId, () => usersService.disable(target.user.id, "first", admin.user.id));
      const again = await asAdmin(tenantId, () =>
        usersService.disable(target.user.id, "second", admin.user.id),
      );
      expect(again.status).toBe("DISABLED");
    });

    it("re-enables an account and clears any lockout", async () => {
      const tenantId = await seedTenant("useradmin");
      const address = email("reenable");
      const target = await asAdmin(tenantId, () =>
        usersService.create({
          email: address,
          fullName: "Re-enable",
          password: "a-password-long-enough-to-pass",
          roles: ["DISPATCHER"],
        }),
      );
      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("admin3"), fullName: "Admin", roles: ["OWNER"] }),
      );

      // Bank up a lockout, then disable and re-enable.
      for (let i = 0; i < 5; i += 1) {
        await auth.login({ tenantId, email: address, password: "wrong-password-entirely" });
      }
      await asAdmin(tenantId, () => usersService.disable(target.user.id, "locked", admin.user.id));
      const enabled = await asAdmin(tenantId, () =>
        usersService.enable(target.user.id, admin.user.id),
      );
      expect(enabled.status).toBe("ACTIVE");

      // "This person can work again" must mean exactly that.
      const result = await auth.login({
        tenantId,
        email: address,
        password: "a-password-long-enough-to-pass",
      });
      expect(result.ok).toBe(true);
    });
  });

  // ── Getting back in ────────────────────────────────────────────────────────

  describe("reset-password", () => {
    it("issues a working password, invalidates the old one, and revokes sessions", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Reset");
      const address = email("reset");

      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: address,
          fullName: "Forgetful Merchant",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );
      const original = created.temporaryPassword;
      if (original === null) throw new Error("expected a generated password");

      await auth.login({ tenantId, email: address, password: original });

      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("admin4"), fullName: "Admin", roles: ["OWNER"] }),
      );
      const reset = await asAdmin(tenantId, () =>
        usersService.resetPassword(created.user.id, {}, admin.user.id),
      );
      const replacement = reset.temporaryPassword;
      if (replacement === null) throw new Error("expected a new generated password");
      expect(replacement).not.toBe(original);

      // Asserted before signing in again — the reset itself must leave nothing
      // live, and a session created afterwards would mask that.
      const live = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ count: string }[]>`
          select count(*)::text as count from refresh_tokens
          where user_id = ${created.user.id} and revoked_at is null
        `,
      );
      expect(live[0]?.count).toBe("0");

      const withNew = await auth.login({ tenantId, email: address, password: replacement });
      expect(withNew.ok).toBe(true);

      const withOld = await auth.login({ tenantId, email: address, password: original });
      expect(withOld.ok).toBe(false);
    });

    it("refuses to reset a user in another tenant", async () => {
      const tenantA = await seedTenant("useradmin-a");
      const tenantB = await seedTenant("useradmin-b");
      const inA = await asAdmin(tenantA, () =>
        usersService.create({ email: email("victim"), fullName: "Victim", roles: ["DISPATCHER"] }),
      );
      const adminB = await asAdmin(tenantB, () =>
        usersService.create({ email: email("attacker"), fullName: "Attacker", roles: ["OWNER"] }),
      );

      await expect(
        asAdmin(tenantB, () => usersService.resetPassword(inA.user.id, {}, adminB.user.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── Editing ────────────────────────────────────────────────────────────────

  describe("update", () => {
    it("changes profile fields and leaves scope and roles alone", async () => {
      const tenantId = await seedTenant("useradmin");
      const merchantId = await seedMerchant(tenantId, "Boutique Update");
      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: email("update"),
          fullName: "Old Name",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );

      const updated = await asAdmin(tenantId, () =>
        usersService.update(created.user.id, { fullName: "New Name", locale: "ar" }),
      );

      expect(updated.fullName).toBe("New Name");
      expect(updated.locale).toBe("ar");
      // Neither is reachable through this endpoint — changing them would break
      // I23 without the caller asking for it.
      expect(updated.merchantId).toBe(merchantId);
      expect(updated.roles).toEqual(["MERCHANT"]);
    });

    it("refuses an empty update", async () => {
      const tenantId = await seedTenant("useradmin");
      const created = await asAdmin(tenantId, () =>
        usersService.create({ email: email("empty"), fullName: "Empty", roles: ["DISPATCHER"] }),
      );
      await expect(
        asAdmin(tenantId, () => usersService.update(created.user.id, {})),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── The audit trail ────────────────────────────────────────────────────────

  describe("events", () => {
    it("records the lifecycle in the outbox without leaking PII", async () => {
      const tenantId = await seedTenant("useradmin");
      const created = await asAdmin(tenantId, () =>
        usersService.create({ email: email("audit"), fullName: "Audit Me", roles: ["DISPATCHER"] }),
      );
      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("admin5"), fullName: "Admin", roles: ["OWNER"] }),
      );
      await asAdmin(tenantId, () =>
        usersService.disable(created.user.id, "offboarded", admin.user.id),
      );

      const rows = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<{ event_type: string; payload: Record<string, unknown> }[]>`
          select event_type, payload from outbox
          where aggregate_id = ${created.user.id} order by seq
        `,
      );

      expect(rows.map((r) => r.event_type)).toEqual(["user.created", "user.disabled"]);
      // The outbox is durable storage that fans out. A consumer reacting to
      // "a user was created" has no need for their name or email.
      for (const row of rows) {
        expect(JSON.stringify(row.payload)).not.toContain("Audit Me");
        expect(JSON.stringify(row.payload)).not.toContain("@example.tn");
      }
    });
  });
});
