import path from "node:path";
import process from "node:process";

import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";

import {
  DEFAULT_FAILURE_REASONS,
  DEFAULT_SLA_TEMPLATES,
  DEFAULT_WORKING_WEEK,
} from "../src/modules/platform/domain/operating-defaults.js";
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
  /** Connected as dp_relay — cross-tenant on `outbox` only. What the relay uses. */
  readonly relay: Sql;
  readonly appUrl: string;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../migrations");

async function startEphemeralContainer(): Promise<{
  appUrl: string;
  migratorUrl: string;
  relayUrl: string;
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
    relayUrl: `postgresql://dp_relay:relay_dev_password@${host}:${port}/delivery_test`,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const providedApp = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  const providedMigrator =
    process.env["TEST_MIGRATION_DATABASE_URL"] ?? process.env["MIGRATION_DATABASE_URL"];
  const providedRelay = process.env["TEST_RELAY_DATABASE_URL"] ?? process.env["RELAY_DATABASE_URL"];

  let appUrl: string;
  let migratorUrl: string;
  let relayUrl: string;
  let stopContainer: (() => Promise<void>) | undefined;

  if (providedApp !== undefined && providedMigrator !== undefined && providedRelay !== undefined) {
    appUrl = providedApp;
    migratorUrl = providedMigrator;
    relayUrl = providedRelay;
  } else {
    const container = await startEphemeralContainer();
    appUrl = container.appUrl;
    migratorUrl = container.migratorUrl;
    relayUrl = container.relayUrl;
    stopContainer = container.stop;
  }

  const migrator = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
  const app = postgres(appUrl, { max: 2, prepare: false, onnotice: () => undefined });
  const relay = postgres(relayUrl, { max: 4, prepare: false, onnotice: () => undefined });

  await runMigrations(migrator, MIGRATIONS_DIR);

  return {
    app,
    migrator,
    relay,
    appUrl,
    async close() {
      await app.end({ timeout: 5 });
      await relay.end({ timeout: 5 });
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
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return migrator.begin(async (tx) => {
    await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Creates an isolated tenant with a unique slug, returning its id.
 *
 * ⚠️ Seeds the operating-config defaults, because `TenantService.provision`
 * does. A test tenant without them behaves like no tenant production will ever
 * have — `decideReattempt` finds no `CUSTOMER_REFUSED` row, fails open, and a
 * test asserting the refusal policy passes against the wrong behaviour. The
 * defaults come from the same constants provisioning uses, so the two cannot
 * drift.
 *
 * ⚠️ ONE TRANSACTION, and that is not tidiness. Inserting the tenant and then
 * seeding it separately means a failed seed leaves a tenant row the caller never
 * received an id for — so `createdTenants.push(...)` never runs and `afterEach`
 * cannot clean it. Tests run against the DEV database, so those rows accumulate
 * there for real. Diagnosed by exactly that: 24 orphans after one broken run.
 *
 * The `set_config` is what makes the seed possible at all: the four
 * operating-config tables are FORCE RLS and `dp_migrator` owns them, and FORCE
 * binds the owner too — without a tenant context every INSERT fails its
 * WITH CHECK. It must come AFTER the tenant row exists, which is also why the
 * whole thing is one transaction rather than a scoped helper.
 */
export async function createTenant(migrator: Sql, label: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return migrator.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into tenants (name, slug, status, country_code, default_currency, default_timezone)
      values (${`Test ${label}`}, ${`test-${label}-${suffix}`}, 'ACTIVE', 'TN', 'TND', 'Africa/Tunis')
      returning id
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("failed to create test tenant");
    }
    await tx`select set_config('app.current_tenant_id', ${row.id}, true)`;
    await insertOperatingDefaults(tx, row.id);
    return row.id;
  });
}

async function insertOperatingDefaults(migrator: TransactionSql, tenantId: string): Promise<void> {
  for (const reason of DEFAULT_FAILURE_REASONS) {
    await migrator`
      insert into failure_reasons
        (tenant_id, code, labels, allows_reattempt, fault, display_order, active)
      values (${tenantId}, ${reason.code}, ${migrator.json(reason.labels)},
              ${reason.allowsReattempt}, ${reason.fault}, ${reason.displayOrder}, true)
      on conflict (tenant_id, code) do nothing
    `;
  }
  for (const day of DEFAULT_WORKING_WEEK) {
    await migrator`
      insert into working_hours (tenant_id, day_of_week, opens_at, closes_at, is_working)
      values (${tenantId}, ${day.dayOfWeek}, ${day.opensAt}::time, ${day.closesAt}::time,
              ${day.isWorking})
      on conflict (tenant_id, day_of_week) do nothing
    `;
  }
  for (const template of DEFAULT_SLA_TEMPLATES) {
    await migrator`
      insert into sla_templates
        (tenant_id, service_level, delivery_hours, reattempt_delay_hours, max_attempts)
      values (${tenantId}, ${template.serviceLevel}, ${template.deliveryHours},
              ${template.reattemptDelayHours}, ${template.maxAttempts})
      on conflict (tenant_id, service_level) do nothing
    `;
  }
}

/**
 * Removes tenants created by a test run. Cascades to every tenant-scoped table.
 *
 * The `set_config` is not decoration. A custom GUC set transaction-locally
 * reverts to the EMPTY STRING when that transaction ends — not to unset — and
 * this pooled connection has usually just been used by `withTenantContext`. Any
 * policy or trigger evaluated during the cascade then runs
 * `current_setting('app.current_tenant_id', true)::uuid` against `''`, which is
 * a cast error rather than a false predicate.
 *
 * NO_TENANT is a real, valid UUID that matches nothing, so the cascade proceeds
 * and every policy simply evaluates to false. Production never hits this: every
 * request goes through `withTenant`, which always sets a genuine tenant id.
 */
export async function deleteTenants(migrator: Sql, tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) {
    return;
  }
  await migrator.begin(async (tx) => {
    await tx`select set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000000', true)`;
    await tx`select set_config('app.current_merchant_id', '', true)`;
    await tx`delete from tenants where id = any(${migrator.array(tenantIds)}::uuid[])`;
  });
}
