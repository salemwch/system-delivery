import path from "node:path";
import process from "node:process";

import postgres from "postgres";
import type { Sql } from "postgres";

import { runMigrations } from "../src/shared/database/migrator.js";

/**
 * Integration-test database harness.
 *
 * Tests run against a REAL PostgreSQL with the real extensions, roles, and
 * Row-Level Security policies. This is not negotiable: RLS cannot be verified
 * against a mock or an SQLite substitute, and RLS is the platform's primary
 * defence against cross-tenant data exposure.
 *
 * Two ways to provide that database:
 *   - TEST_DATABASE_URL / TEST_MIGRATION_DATABASE_URL set (local dev, CI service
 *     container) — use it directly. Fast.
 *   - Otherwise, start a disposable container via Testcontainers. Hermetic, and
 *     what CI uses when no service container is provided.
 */

export interface TestDatabase {
  /** Connected as dp_app — NO BYPASSRLS. What the application uses. */
  readonly app: Sql;
  /** Connected as dp_migrator — owns the schema. Used only for fixtures. */
  readonly migrator: Sql;
  readonly appUrl: string;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

async function startEphemeralContainer(): Promise<{
  appUrl: string;
  migratorUrl: string;
  stop: () => Promise<void>;
}> {
  const { GenericContainer, Wait } = await import("testcontainers");

  const container = await new GenericContainer(
    "timescale/timescaledb-ha:pg18@sha256:9702ce302f55817ee9cff9d5b4f45dfe31415b7e58bdfde6b512e8dd1ee927a0",
  )
    .withEnvironment({
      POSTGRES_DB: "delivery_test",
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
    })
    .withBindMounts([
      {
        source: path.resolve(import.meta.dirname, "../../../infra/docker/initdb"),
        target: "/docker-entrypoint-initdb.d",
        mode: "ro",
      },
    ])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  return {
    appUrl: `postgresql://dp_app:app_dev_password@${host}:${port}/delivery_test`,
    migratorUrl: `postgresql://dp_migrator:migrator_dev_password@${host}:${port}/delivery_test`,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const providedApp = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  const providedMigrator =
    process.env["TEST_MIGRATION_DATABASE_URL"] ?? process.env["MIGRATION_DATABASE_URL"];

  let appUrl: string;
  let migratorUrl: string;
  let stopContainer: (() => Promise<void>) | undefined;

  if (providedApp !== undefined && providedMigrator !== undefined) {
    appUrl = providedApp;
    migratorUrl = providedMigrator;
  } else {
    const container = await startEphemeralContainer();
    appUrl = container.appUrl;
    migratorUrl = container.migratorUrl;
    stopContainer = container.stop;
  }

  const migrator = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
  const app = postgres(appUrl, { max: 2, prepare: false, onnotice: () => undefined });

  await runMigrations(migrator, MIGRATIONS_DIR);

  return {
    app,
    migrator,
    appUrl,
    async close() {
      await app.end({ timeout: 5 });
      await migrator.end({ timeout: 5 });
      if (stopContainer !== undefined) {
        await stopContainer();
      }
    },
  };
}

/**
 * Runs a raw query with tenant context bound.
 *
 * Required for ANY direct read of a tenant-scoped table, even as dp_migrator:
 * those tables use FORCE ROW LEVEL SECURITY, so the owner is subject to policy
 * too and an unscoped query correctly returns zero rows. A test that forgets
 * this sees an empty result and misreads it as missing data.
 */
export async function withTenantContext<T>(
  migrator: Sql,
  tenantId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return migrator.begin(async (tx) => {
    await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Creates an isolated tenant with a unique slug, returning its id. */
export async function createTenant(migrator: Sql, label: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const rows = await migrator<{ id: string }[]>`
    insert into tenants (name, slug, status, country_code, default_currency, default_timezone)
    values (${`Test ${label}`}, ${`test-${label}-${suffix}`}, 'ACTIVE', 'TN', 'TND', 'Africa/Tunis')
    returning id
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("failed to create test tenant");
  }
  return row.id;
}

/** Removes tenants created by a test run. Cascades to tenant_features. */
export async function deleteTenants(migrator: Sql, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) {
    return;
  }
  await migrator`delete from tenants where id = any(${migrator.array(tenantIds)}::uuid[])`;
}
