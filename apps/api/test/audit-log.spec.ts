import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { AuthService } from "../src/modules/identity/application/auth.service.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { MfaService } from "../src/modules/identity/application/mfa.service.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import { TokenService } from "../src/modules/identity/application/token.service.js";
import { UserService } from "../src/modules/identity/application/user.service.js";
import {
  AuditService,
  ensureAuditPartitions,
} from "../src/modules/platform/application/audit.service.js";
import { AUDIT_ACTIONS, isAuditAction } from "../src/modules/platform/domain/audit-actions.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { ValidationError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";
import { stubConfig } from "./config.stub.js";

/**
 * The audit trail (docs/07-security-architecture.md §10).
 *
 * An audit log is only worth having if it cannot be edited and cannot be
 * skipped. These tests attack both properties directly rather than asserting
 * that writing one works — a trail that is trusted and wrong is worse than no
 * trail at all.
 */
describe("audit log", () => {
  let database: TestDatabase;
  let db: DatabaseService;
  let audit: AuditService;
  let usersService: UserService;
  let merchants: MerchantService;
  let auth: AuthService;
  let createdTenants: string[] = [];

  async function asAdmin<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      {
        tenantId: asTenantId(tenantId),
        actorType: "user",
        actorId: ACTING_USER,
        requestId: REQUEST_ID,
        ipAddress: "196.203.1.5",
        userAgent: "Mozilla/5.0 (audit test)",
      },
      fn,
    );
  }

  const ACTING_USER = randomUUID();
  const REQUEST_ID = randomUUID();

  async function seedTenant(label: string): Promise<string> {
    const id = await createTenant(database.migrator, label);
    createdTenants.push(id);
    return id;
  }

  function email(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}@example.tn`;
  }

  /** Reads the trail directly, bypassing the service, so the query is not the thing under test. */
  async function rawEntries(
    tenantId: string,
  ): Promise<{ action: string; outcome: string; actor_type: string; changes: unknown }[]> {
    return withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ action: string; outcome: string; actor_type: string; changes: unknown }[]>`
        select action, outcome, actor_type, changes from audit_log order by id
      `,
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = new DatabaseService(database.app);
    audit = new AuditService(db);
    const outbox = new OutboxService();
    const passwords = new PasswordService();
    usersService = new UserService(db, passwords, outbox, audit);
    merchants = new MerchantService(db, outbox);
    auth = new AuthService(
      db,
      passwords,
      new TokenService(stubConfig()),
      audit,
      new MfaService(db, passwords, audit, new FieldCipher(randomBytes(32))),
    );
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  // ── Append-only, proven by attacking it ────────────────────────────────────

  describe("append-only", () => {
    it("refuses UPDATE even as the schema owner", async () => {
      const tenantId = await seedTenant("audit");
      await asAdmin(tenantId, () =>
        audit.write({ action: "pii.exported", resourceType: "shipment" }),
      );

      // dp_migrator OWNS the table. Grants do not restrain an owner, so this
      // proves the TRIGGER is doing the work, not just the REVOKE.
      await expect(
        withTenantContext(
          database.migrator,
          tenantId,
          (tx) => tx`update audit_log set action = 'tampered'`,
        ),
      ).rejects.toThrow(/append-only/u);
    });

    it("refuses DELETE even as the schema owner", async () => {
      const tenantId = await seedTenant("audit");
      await asAdmin(tenantId, () =>
        audit.write({ action: "pii.exported", resourceType: "shipment" }),
      );

      await expect(
        withTenantContext(database.migrator, tenantId, (tx) => tx`delete from audit_log`),
      ).rejects.toThrow(/append-only/u);
    });

    it("grants the application SELECT and INSERT only", async () => {
      const rows = await database.migrator<{ privilege_type: string }[]>`
        select privilege_type from information_schema.role_table_grants
        where table_name = 'audit_log' and grantee = 'dp_app'
      `;
      const granted = new Set(rows.map((r) => r.privilege_type));

      expect(granted.has("SELECT")).toBe(true);
      expect(granted.has("INSERT")).toBe(true);
      // The omission is the control. The trigger is the backstop for a future
      // migration that widens this by accident.
      expect(granted.has("UPDATE")).toBe(false);
      expect(granted.has("DELETE")).toBe(false);
    });
  });

  // ── Partitioning ───────────────────────────────────────────────────────────

  describe("partitioning", () => {
    it("is a partitioned table with monthly partitions already created", async () => {
      const [parent] = await database.migrator<{ partition_strategy: string | null }[]>`
        select p.partstrat as partition_strategy
        from pg_partitioned_table p
        join pg_class c on c.oid = p.partrelid
        where c.relname = 'audit_log'
      `;
      // 'r' = RANGE. Not asserted by reading the migration text — asserted
      // against what the database actually did with it.
      expect(parent?.partition_strategy).toBe("r");

      const partitions = await database.migrator<{ count: string }[]>`
        select count(*)::text as count from pg_class
        where relname like 'audit_log_2%' and relkind = 'r'
      `;
      // 12 months of runway created at migration time.
      expect(Number(partitions[0]?.count ?? 0)).toBeGreaterThanOrEqual(12);
    });

    it("has a default partition so an audit write can never fail for want of one", async () => {
      const [row] = await database.migrator<{ exists: boolean }[]>`
        select exists(
          select 1 from pg_class where relname = 'audit_log_default'
        ) as exists
      `;
      // Audit writes share the transaction of the action they describe, so a
      // missing partition would roll back the business operation too.
      expect(row?.exists).toBe(true);
    });

    it("creating partitions is idempotent", async () => {
      // Runs on every boot; a second call must create nothing and not throw.
      const created = await ensureAuditPartitions(db, 3);
      expect(created).toBe(0);
    });

    it("indexes are declared on the parent so future partitions inherit them", async () => {
      const rows = await database.migrator<{ indexname: string }[]>`
        select indexname from pg_indexes where tablename = 'audit_log'
      `;
      const names = rows.map((r) => r.indexname);
      expect(names).toContain("audit_log_resource_idx");
      expect(names).toContain("audit_log_actor_idx");
      // A partition created next year must not silently lack the index the
      // investigation query depends on.
      const [partitionIndexes] = await database.migrator<{ count: string }[]>`
        select count(*)::text as count from pg_indexes
        where tablename like 'audit_log_2%'
      `;
      expect(Number(partitionIndexes?.count ?? 0)).toBeGreaterThan(0);
    });
  });

  // ── Secrets never reach the table ──────────────────────────────────────────

  describe("redaction", () => {
    it("redacts credential-shaped field names in changes and context", async () => {
      const tenantId = await seedTenant("audit");
      await asAdmin(tenantId, () =>
        audit.write({
          action: "user.password_reset",
          resourceType: "user",
          changes: {
            passwordHash: { from: "$argon2id$OLD", to: "$argon2id$NEW" },
            mfaSecret: { from: "JBSWY3DP", to: "KRSXG5A" },
            fullName: { from: "Old Name", to: "New Name" },
          },
          context: { refreshToken: "rt_live_secret", reason: "forgot password" },
        }),
      );

      const [entry] = await rawEntries(tenantId);
      const changes = entry?.changes as Record<string, { from: string; to: string }>;

      // The FACT that a credential changed is what an audit trail is for; the
      // value is what must never be in one.
      expect(changes["passwordHash"]).toEqual({ from: "[redacted]", to: "[redacted]" });
      expect(changes["mfaSecret"]).toEqual({ from: "[redacted]", to: "[redacted]" });
      // Non-secret fields survive intact, or the trail would be useless.
      expect(changes["fullName"]).toEqual({ from: "Old Name", to: "New Name" });

      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain("$argon2id$OLD");
      expect(serialised).not.toContain("JBSWY3DP");
      expect(serialised).not.toContain("rt_live_secret");
    });

    it("matches secret field names case-insensitively and as substrings", async () => {
      const tenantId = await seedTenant("audit");
      await asAdmin(tenantId, () =>
        audit.write({
          action: "pii.exported",
          resourceType: "user",
          changes: {
            NEW_PASSWORD: { from: "a", to: "b" },
            api_key_id: { from: "c", to: "d" },
            totpSecret: { from: "e", to: "f" },
          },
        }),
      );

      const [entry] = await rawEntries(tenantId);
      const changes = entry?.changes as Record<string, { from: string; to: string }>;
      for (const field of ["NEW_PASSWORD", "api_key_id", "totpSecret"]) {
        expect(changes[field]).toEqual({ from: "[redacted]", to: "[redacted]" });
      }
    });
  });

  // ── The actor comes from context, not from the caller ──────────────────────

  describe("actor and origin", () => {
    it("fills actor, IP, user agent and correlation id from the request context", async () => {
      const tenantId = await seedTenant("audit");
      await asAdmin(tenantId, () =>
        audit.write({ action: "pii.exported", resourceType: "shipment" }),
      );

      const [row] = await withTenantContext(
        database.migrator,
        tenantId,
        (tx) => tx<
          {
            actor_id: string;
            actor_type: string;
            ip_address: string;
            user_agent: string;
            correlation_id: string;
          }[]
        >`
          select actor_id, actor_type, ip_address, user_agent, correlation_id from audit_log
        `,
      );

      // Taken from the verified context, never from an argument a call site
      // could get wrong.
      expect(row?.actor_id).toBe(ACTING_USER);
      expect(row?.actor_type).toBe("USER");
      expect(row?.ip_address).toBe("196.203.1.5");
      expect(row?.user_agent).toBe("Mozilla/5.0 (audit test)");
      // Ties the entry to the request and to every event and span it produced.
      expect(row?.correlation_id).toBe(REQUEST_ID);
    });

    it("records an unauthenticated actor when there is no context to read", async () => {
      const tenantId = await seedTenant("audit");
      // No TenantContext.run — the unauthenticated path.
      await audit.write({
        action: "auth.login_failed",
        outcome: "FAILURE",
        resourceType: "user",
        actorType: "ANONYMOUS",
        actorId: null,
        tenantId,
        ipAddress: "10.0.0.9",
      });

      const [entry] = await rawEntries(tenantId);
      expect(entry?.actor_type).toBe("ANONYMOUS");
      expect(entry?.outcome).toBe("FAILURE");
    });
  });

  // ── The mandatory events actually fire ─────────────────────────────────────

  describe("mandatory events (§10)", () => {
    it("records a successful login", async () => {
      const tenantId = await seedTenant("audit");
      const address = email("login");
      const created = await asAdmin(tenantId, () =>
        usersService.create({ email: address, fullName: "Login User", roles: ["DISPATCHER"] }),
      );
      const password = created.temporaryPassword;
      if (password === null) throw new Error("expected a generated password");

      await auth.login({ tenantId, email: address, password, ipAddress: "196.203.1.5" });

      const actions = (await rawEntries(tenantId)).map((e) => e.action);
      expect(actions).toContain("auth.login_succeeded");
    });

    it("records a failed login for an account that exists", async () => {
      const tenantId = await seedTenant("audit");
      const address = email("badpw");
      await asAdmin(tenantId, () =>
        usersService.create({ email: address, fullName: "Bad Password", roles: ["DISPATCHER"] }),
      );

      await auth.login({ tenantId, email: address, password: "definitely-not-the-password" });

      const entries = await rawEntries(tenantId);
      const failure = entries.find((e) => e.action === "auth.login_failed");
      expect(failure?.outcome).toBe("FAILURE");
    });

    it("records a failed login for an email that does not exist", async () => {
      const tenantId = await seedTenant("audit");

      await auth.login({
        tenantId,
        email: "nobody@example.tn",
        password: "whatever-it-does-not-matter",
      });

      // The response is deliberately indistinguishable from a wrong password;
      // the TRAIL is where the difference is recorded. Without this entry a
      // credential-stuffing sweep across many addresses is invisible.
      const entries = await rawEntries(tenantId);
      const failure = entries.find((e) => e.action === "auth.login_failed");
      expect(failure).toBeDefined();
      expect(failure?.actor_type).toBe("ANONYMOUS");
    });

    it("records the lockout as its own event, not just the failures", async () => {
      const tenantId = await seedTenant("audit");
      const address = email("lockout");
      await asAdmin(tenantId, () =>
        usersService.create({ email: address, fullName: "Lock Me", roles: ["DISPATCHER"] }),
      );

      for (let i = 0; i < 5; i += 1) {
        await auth.login({ tenantId, email: address, password: "wrong-password-here" });
      }

      const actions = (await rawEntries(tenantId)).map((e) => e.action);
      // The moment access changed — what an operator gets paged about.
      expect(actions).toContain("auth.account_locked");
    });

    it("records refresh-token reuse, the stolen-session signal", async () => {
      const tenantId = await seedTenant("audit");
      const address = email("reuse");
      const created = await asAdmin(tenantId, () =>
        usersService.create({ email: address, fullName: "Reuse", roles: ["DISPATCHER"] }),
      );
      const password = created.temporaryPassword;
      if (password === null) throw new Error("expected a generated password");

      const first = await auth.login({ tenantId, email: address, password });
      if (!first.ok) throw new Error("login should have succeeded");
      const original = first.session.refreshToken;

      await auth.refresh(tenantId, original);
      // Replaying the already-rotated token: a captured credential.
      await auth.refresh(tenantId, original);

      const actions = (await rawEntries(tenantId)).map((e) => e.action);
      expect(actions).toContain("auth.refresh_reuse_detected");
    });

    it("records user creation with the roles granted", async () => {
      const tenantId = await seedTenant("audit");
      const merchantId = await asAdmin(
        tenantId,
        async () => (await merchants.create({ name: "Boutique" })).id,
      );

      const created = await asAdmin(tenantId, () =>
        usersService.create({
          email: email("audited"),
          fullName: "Audited Merchant",
          roles: ["MERCHANT"],
          merchantId,
        }),
      );

      const [entry] = (await rawEntries(tenantId)).filter((e) => e.action === "user.created");
      const changes = entry?.changes as Record<string, { from: unknown; to: unknown }>;
      expect(changes["roles"]?.to).toEqual(["MERCHANT"]);
      expect(changes["merchantId"]?.to).toBe(merchantId);
      expect(created.user.id).toBeDefined();
    });

    it("records disable and enable with the status transition", async () => {
      const tenantId = await seedTenant("audit");
      const target = await asAdmin(tenantId, () =>
        usersService.create({ email: email("t"), fullName: "Target", roles: ["DISPATCHER"] }),
      );
      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("a"), fullName: "Admin", roles: ["OWNER"] }),
      );

      await asAdmin(tenantId, () =>
        usersService.disable(target.user.id, "offboarded", admin.user.id),
      );
      await asAdmin(tenantId, () => usersService.enable(target.user.id, admin.user.id));

      const actions = (await rawEntries(tenantId)).map((e) => e.action);
      expect(actions).toContain("user.disabled");
      expect(actions).toContain("user.enabled");
    });

    it("records a password reset WITHOUT the password", async () => {
      const tenantId = await seedTenant("audit");
      const target = await asAdmin(tenantId, () =>
        usersService.create({ email: email("r"), fullName: "Reset Me", roles: ["DISPATCHER"] }),
      );
      const admin = await asAdmin(tenantId, () =>
        usersService.create({ email: email("a2"), fullName: "Admin", roles: ["OWNER"] }),
      );

      const reset = await asAdmin(tenantId, () =>
        usersService.resetPassword(target.user.id, {}, admin.user.id),
      );
      const issued = reset.temporaryPassword;
      if (issued === null) throw new Error("expected a generated password");

      const entries = await rawEntries(tenantId);
      const entry = entries.find((e) => e.action === "user.password_reset");
      expect(entry).toBeDefined();
      // The new password must not be recoverable from the audit trail.
      expect(JSON.stringify(entries)).not.toContain(issued);
    });
  });

  // ── Rolling back the action rolls back the trail ───────────────────────────

  describe("transactional integrity", () => {
    it("does not record an action whose transaction rolled back", async () => {
      const tenantId = await seedTenant("audit");

      // A create that fails at the database: a merchant id that does not exist.
      await expect(
        asAdmin(tenantId, () =>
          usersService.create({
            email: email("ghost"),
            fullName: "Never Created",
            roles: ["MERCHANT"],
            merchantId: randomUUID(),
          }),
        ),
      ).rejects.toThrow();

      // The audit entry shares the transaction, so it is gone too. Otherwise
      // the trail would claim a user was created that never was.
      const entries = await rawEntries(tenantId);
      expect(entries.filter((e) => e.action === "user.created")).toHaveLength(0);
    });
  });

  // ── Reading it ─────────────────────────────────────────────────────────────

  describe("query", () => {
    it("filters by resource, actor, action and outcome, and paginates", async () => {
      const tenantId = await seedTenant("audit");
      const shipmentId = randomUUID();

      await asAdmin(tenantId, async () => {
        for (let i = 0; i < 3; i += 1) {
          await audit.write({
            action: "shipment.status_overridden",
            resourceType: "shipment",
            resourceId: shipmentId,
            context: { index: i },
          });
        }
        await audit.write({
          action: "pii.exported",
          resourceType: "user",
          outcome: "DENIED",
        });
      });

      const byResource = await asAdmin(tenantId, () =>
        audit.query({ resourceType: "shipment", resourceId: shipmentId }),
      );
      expect(byResource.items).toHaveLength(3);

      const denied = await asAdmin(tenantId, () => audit.query({ outcome: "DENIED" }));
      expect(denied.items).toHaveLength(1);
      expect(denied.items[0]?.action).toBe("pii.exported");

      const byActor = await asAdmin(tenantId, () => audit.query({ actorId: ACTING_USER }));
      expect(byActor.items).toHaveLength(4);

      const firstPage = await asAdmin(tenantId, () => audit.query({ limit: 2 }));
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await asAdmin(tenantId, () =>
        audit.query({ limit: 2, cursor: firstPage.nextCursor ?? undefined }),
      );
      expect(secondPage.items).toHaveLength(2);

      const ids = new Set([...firstPage.items, ...secondPage.items].map((e) => e.id));
      expect(ids.size).toBe(4);
    });

    it("newest first — a trail read oldest-first buries the incident", async () => {
      const tenantId = await seedTenant("audit");
      await asAdmin(tenantId, async () => {
        await audit.write({ action: "pii.exported", resourceType: "user" });
        await audit.write({ action: "ledger.adjusted", resourceType: "ledger" });
      });

      const page = await asAdmin(tenantId, () => audit.query({}));
      expect(page.items[0]?.action).toBe("ledger.adjusted");
    });

    it("rejects an unknown filter rather than ignoring it", async () => {
      const tenantId = await seedTenant("audit");
      await expect(
        asAdmin(tenantId, () => audit.query({ tenantId: randomUUID() })),
        // Silently ignoring a filter on an investigation endpoint would show
        // the investigator a different result set than they asked for.
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("never returns another tenant's trail", async () => {
      const tenantA = await seedTenant("audit-a");
      const tenantB = await seedTenant("audit-b");

      await asAdmin(tenantA, () => audit.write({ action: "pii.exported", resourceType: "user" }));

      const inB = await asAdmin(tenantB, () => audit.query({}));
      expect(inB.items).toHaveLength(0);
    });
  });

  // ── The catalogue ──────────────────────────────────────────────────────────

  describe("action catalogue", () => {
    it("covers every category §10 makes mandatory", () => {
      for (const required of [
        "auth.login_succeeded",
        "auth.login_failed",
        "user.role_granted",
        "feature.changed",
        "shipment.status_overridden",
        "ledger.adjusted",
        "remittance.confirmed_with_variance",
        "settlement.approved",
        "pii.exported",
        "tenant.provisioned",
        "platform_admin.tenant_accessed",
      ] as const) {
        expect(AUDIT_ACTIONS).toContain(required);
      }
    });

    it("narrows unknown strings", () => {
      expect(isAuditAction("auth.login_failed")).toBe(true);
      expect(isAuditAction("auth.definitely_not_an_action")).toBe(false);
    });
  });
});
