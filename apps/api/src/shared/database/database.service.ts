import { Inject, Injectable } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { SpanKind } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

import { withSpan } from "../observability/index.js";
import { TenantContext } from "./tenant-context.js";
import type { TenantId } from "./tenant-context.js";
import { POSTGRES_CLIENT } from "./database.tokens.js";

/**
 * Schema-agnostic by design.
 *
 * `shared/` sits below every domain module in the layering
 * (docs/04-context-map.md §2.1), so it must not import module schemas — doing
 * so inverts the dependency graph and the boundary lint rejects it.
 *
 * Each module builds its own typed Drizzle instance over the shared client
 * using the tables it owns, which also preserves exclusive table ownership
 * (docs/04-context-map.md §1). This service owns the connection, the
 * transaction boundary, and tenant scoping — nothing about any domain.
 */
export type Database = PostgresJsDatabase<Record<string, never>>;
export type TenantTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Database access with mandatory tenant scoping.
 *
 * Every tenant-scoped query runs inside a transaction that sets
 * `app.current_tenant_id`, which PostgreSQL Row-Level Security reads. The
 * application connects as `dp_app`, a role WITHOUT `BYPASSRLS`, so even a query
 * that forgets its `WHERE tenant_id = ...` clause returns only the current
 * tenant's rows.
 *
 * See docs/07-security-architecture.md §5.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly db: Database;

  constructor(@Inject(POSTGRES_CLIENT) private readonly client: Sql) {
    this.db = drizzle(this.client);
  }

  /**
   * Runs `fn` inside a transaction scoped to the ambient tenant.
   *
   * WHY `set_config(..., true)` AND NOT `SET LOCAL`:
   *
   *   1. `SET LOCAL x = $1` is not valid SQL — SET does not accept bind
   *      parameters. Building the statement by string concatenation would be a
   *      SQL-injection sink on a security-critical value. `set_config()` is a
   *      normal function call and takes a real bind parameter.
   *   2. The third argument `true` means *transaction-local*. This is essential:
   *      with PgBouncer transaction pooling the connection returns to the pool
   *      after every transaction, so a session-scoped setting would be
   *      inherited by the NEXT tenant's query — a silent cross-tenant data leak
   *      with no error message.
   *
   * These two facts are why this method exists and why no code path may open a
   * raw transaction of its own.
   */
  async withTenant<T>(fn: (tx: TenantTransaction) => Promise<T>, tenantId?: TenantId): Promise<T> {
    const scopedTenantId = tenantId ?? TenantContext.requireTenantId();

    // A manual CLIENT span: postgres.js is not covered by any OpenTelemetry
    // instrumentation, so this is the only place the database appears in a trace.
    // No-op when telemetry is disabled. The tenant id is deliberately NOT an
    // attribute — it is a tenant identifier, not something to fan traces out by.
    return withSpan(
      "db.transaction",
      { kind: SpanKind.CLIENT, attributes: { "db.system": "postgresql", scoped: true } },
      () =>
        this.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.current_tenant_id', ${scopedTenantId}, true)`,
          );
          return fn(tx);
        }),
    );
  }

  /**
   * Escape hatch for genuinely tenant-independent work: migrations, the tenant
   * registry itself, and platform-admin tooling.
   *
   * Deliberately named to be conspicuous in review. It does not set a tenant
   * context, so RLS-protected tables return nothing — which is the correct
   * fail-closed behaviour, not a bug.
   */
  async withoutTenantScope<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return withSpan(
      "db.transaction",
      { kind: SpanKind.CLIENT, attributes: { "db.system": "postgresql", scoped: false } },
      () => this.db.transaction(fn),
    );
  }

  /** Liveness probe. Returns false rather than throwing so callers can degrade. */
  async isHealthy(): Promise<boolean> {
    try {
      await this.client`select 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
