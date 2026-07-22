import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseService } from "../src/shared/database/database.service.js";
import { asTenantId } from "../src/shared/database/tenant-context.js";
import type { TenantId } from "../src/shared/database/tenant-context.js";
import { createTenant, createTestDatabase, deleteTenants } from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * Cross-tenant isolation suite — the most important test in this codebase.
 *
 * A cross-tenant data leak is the one failure this platform cannot recover
 * from: in a SaaS serving competing courier companies, a single leak ends the
 * business (docs/07-security-architecture.md §2.1).
 *
 * These tests assert the DATABASE refuses cross-tenant access, not that the
 * application remembers to filter. Application-level filtering is defence in
 * depth; Row-Level Security is the actual boundary. Every test here would still
 * pass if the ORM emitted a query with no WHERE clause at all — that is the
 * entire point.
 *
 * This suite is a BLOCKING CI gate.
 */
/** PostgreSQL SQLSTATE for a policy violation (insufficient_privilege). */
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

interface PgErrorShape {
  readonly code: string | undefined;
  readonly message: string;
}

/**
 * Drizzle wraps driver errors, so the RLS message is not on the outer error.
 * Walk the `cause` chain to the original postgres error and read its SQLSTATE —
 * asserting on a code is more precise than matching on message text anyway.
 */
function unwrapPgError(error: unknown): PgErrorShape {
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === "object") {
      const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (typeof candidate.code === "string") {
        return {
          code: candidate.code,
          message: typeof candidate.message === "string" ? candidate.message : "",
        };
      }
      current = candidate.cause;
      continue;
    }
    break;
  }

  return { code: undefined, message: error instanceof Error ? error.message : String(error) };
}

/** Asserts a promise rejects specifically because Row-Level Security blocked it. */
async function expectRlsViolation(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }

  expect(caught, "expected the operation to be rejected by RLS, but it succeeded").toBeDefined();

  const pgError = unwrapPgError(caught);
  expect(pgError.code).toBe(SQLSTATE_INSUFFICIENT_PRIVILEGE);
  expect(pgError.message).toMatch(/row-level security/i);
}

describe("cross-tenant isolation", () => {
  let database: TestDatabase;
  let service: DatabaseService;
  let tenantA: TenantId;
  let tenantB: TenantId;
  let featureOfA: string;
  let featureOfB: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    service = new DatabaseService(database.app);

    tenantA = asTenantId(await createTenant(database.migrator, "alpha"));
    tenantB = asTenantId(await createTenant(database.migrator, "beta"));

    // Seed one feature row per tenant, as migrator (bypasses nothing — it owns
    // the table and FORCE RLS applies, so we set context explicitly).
    const seed = async (tenantId: TenantId, key: string): Promise<string> => {
      const rows = await database.migrator.begin(async (tx) => {
        await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
        return tx<{ id: string }[]>`
          insert into tenant_features (tenant_id, feature_key, enabled, source)
          values (${tenantId}, ${key}, true, 'PLAN')
          returning id
        `;
      });
      const row = rows[0];
      if (row === undefined) {
        throw new Error("failed to seed tenant feature");
      }
      return row.id;
    };

    featureOfA = await seed(tenantA, "COD_ENABLED");
    featureOfB = await seed(tenantB, "COD_ENABLED");
  });

  afterAll(async () => {
    await deleteTenants(database.migrator, [tenantA, tenantB]);
    await database.close();
  });

  describe("role configuration", () => {
    it("connects as a role WITHOUT bypassrls", async () => {
      const rows = await database.app<{ current_user: string; rolbypassrls: boolean }[]>`
        select current_user, r.rolbypassrls
        from pg_roles r
        where r.rolname = current_user
      `;

      expect(rows[0]?.current_user).toBe("dp_app");
      // If this is ever true, every policy in the system is decorative.
      expect(rows[0]?.rolbypassrls).toBe(false);
    });

    it("cannot create tables (no DDL privileges)", async () => {
      await expect(database.app`create table isolation_probe (id int)`).rejects.toThrow(
        /permission denied/i,
      );
    });

    it("has RLS ENABLED and FORCED on every tenant-scoped data table", async () => {
      // Tenant-scoped DATA tables must be FORCED: without it the table owner
      // silently bypasses every policy. Every table added from here on belongs
      // in this list.
      const dataTables = ["tenant_features"];

      const rows = await database.migrator<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname = any(${database.migrator.array(dataTables)}::text[])
        order by c.relname
      `;

      expect(rows).toHaveLength(dataTables.length);
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} must have RLS forced`).toBe(true);
      }
    });

    it("has RLS enabled but NOT forced on the tenant registry", async () => {
      // `tenants` is control-plane data. The provisioning path (dp_migrator,
      // the owner) must be able to create tenants, so FORCE is deliberately
      // off. dp_app is not the owner and has no BYPASSRLS, so it remains
      // confined to its own row — proven by the read-isolation tests below.
      const rows = await database.migrator<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        select c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'tenants'
      `;

      expect(rows[0]?.relrowsecurity).toBe(true);
      expect(rows[0]?.relforcerowsecurity).toBe(false);
    });
  });

  describe("read isolation", () => {
    it("tenant A sees only its own rows", async () => {
      const rows = await service.withTenant(
        async (tx) => tx.execute<{ tenant_id: string }>("select tenant_id from tenant_features"),
        tenantA,
      );

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.tenant_id).toBe(tenantA);
      }
    });

    it("tenant A cannot read tenant B's row even by direct id", async () => {
      const rows = await service.withTenant(
        async (tx) =>
          tx.execute<{ id: string }>(`select id from tenant_features where id = '${featureOfB}'`),
        tenantA,
      );

      // Not an error — simply invisible. Existence is not disclosed.
      expect(rows).toHaveLength(0);
    });

    it("tenant B cannot read tenant A's row (isolation is symmetric)", async () => {
      const rows = await service.withTenant(
        async (tx) =>
          tx.execute<{ id: string }>(`select id from tenant_features where id = '${featureOfA}'`),
        tenantB,
      );

      expect(rows).toHaveLength(0);
    });

    it("a tenant reads only its own row from the tenants registry", async () => {
      const rows = await service.withTenant(
        async (tx) => tx.execute<{ id: string }>("select id from tenants"),
        tenantA,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(tenantA);
    });
  });

  describe("write isolation", () => {
    it("tenant A cannot UPDATE tenant B's row", async () => {
      const affected = await service.withTenant(
        async (tx) =>
          tx.execute(`update tenant_features set enabled = false where id = '${featureOfB}'`),
        tenantA,
      );

      expect(affected.length).toBe(0);

      // Confirm B's row is genuinely untouched.
      const check = await service.withTenant(
        async (tx) =>
          tx.execute<{ enabled: boolean }>(
            `select enabled from tenant_features where id = '${featureOfB}'`,
          ),
        tenantB,
      );
      expect(check[0]?.enabled).toBe(true);
    });

    it("tenant A cannot DELETE tenant B's row", async () => {
      await service.withTenant(
        async (tx) => tx.execute(`delete from tenant_features where id = '${featureOfB}'`),
        tenantA,
      );

      const check = await service.withTenant(
        async (tx) =>
          tx.execute<{ id: string }>(`select id from tenant_features where id = '${featureOfB}'`),
        tenantB,
      );
      expect(check).toHaveLength(1);
    });

    it("tenant A cannot INSERT a row belonging to tenant B (WITH CHECK)", async () => {
      // A USING-only policy would allow this write and only hide it afterwards.
      // WITH CHECK is what makes it fail.
      await expectRlsViolation(
        service.withTenant(
          async (tx) =>
            tx.execute(
              `insert into tenant_features (tenant_id, feature_key, enabled, source)
               values ('${tenantB}', 'SMUGGLED_FEATURE', true, 'PLAN')`,
            ),
          tenantA,
        ),
      );

      // And nothing was actually written.
      const rows = await service.withTenant(
        async (tx) =>
          tx.execute<{ id: string }>(
            "select id from tenant_features where feature_key = 'SMUGGLED_FEATURE'",
          ),
        tenantB,
      );
      expect(rows).toHaveLength(0);
    });

    it("tenant A cannot re-assign its own row to tenant B", async () => {
      await expectRlsViolation(
        service.withTenant(
          async (tx) =>
            tx.execute(
              `update tenant_features set tenant_id = '${tenantB}' where id = '${featureOfA}'`,
            ),
          tenantA,
        ),
      );

      // The row still belongs to tenant A.
      const rows = await service.withTenant(
        async (tx) =>
          tx.execute<{ tenant_id: string }>(
            `select tenant_id from tenant_features where id = '${featureOfA}'`,
          ),
        tenantA,
      );
      expect(rows[0]?.tenant_id).toBe(tenantA);
    });
  });

  describe("fail-closed behaviour", () => {
    it("returns zero rows when no tenant context is set", async () => {
      // The dp_app role default is the all-zero UUID, so an unscoped query
      // matches nothing rather than everything.
      const rows = await database.app`select id from tenant_features`;
      expect(rows).toHaveLength(0);
    });

    it("throws rather than silently querying when no ambient context is bound", async () => {
      await expect(service.withTenant(async (tx) => tx.execute("select 1"))).rejects.toThrow(
        /No tenant context bound/,
      );
    });
  });

  describe("connection pooling safety", () => {
    it("does not leak tenant context to the next transaction on the same connection", async () => {
      // THE PGBOUNCER SCENARIO. `SET LOCAL` / set_config(..., true) is
      // transaction-scoped; a session-scoped `SET` would persist here and be
      // inherited by the next tenant's query — a silent cross-tenant leak.
      await service.withTenant(async (tx) => tx.execute("select 1"), tenantA);

      const leaked = await database.app<{ value: string }[]>`
        select current_setting('app.current_tenant_id', true) as value
      `;

      expect(leaked[0]?.value).not.toBe(tenantA);
      expect(leaked[0]?.value).toBe("00000000-0000-0000-0000-000000000000");
    });

    it("restores the fail-closed default after a transaction rolls back", async () => {
      await expect(
        service.withTenant(async (tx) => {
          await tx.execute("select 1");
          throw new Error("deliberate rollback");
        }, tenantA),
      ).rejects.toThrow("deliberate rollback");

      const rows = await database.app`select id from tenant_features`;
      expect(rows).toHaveLength(0);
    });
  });
});
