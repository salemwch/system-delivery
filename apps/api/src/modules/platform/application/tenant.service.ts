import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";

import { DatabaseService, TenantContext, asTenantId } from "../../../shared/database/index.js";
import type { TenantId, TenantTransaction } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { DEFAULT_FEATURES } from "../domain/feature-keys.js";
import type { FeatureKey } from "../domain/feature-keys.js";
import { tenantFeatures, tenants } from "../domain/schema.js";
import { OperatingConfigService } from "./operating-config.service.js";
import { OutboxService } from "./outbox.service.js";

/** The tenant's display identity — what appears on anything it prints or sends. */
export interface TenantProfile {
  readonly name: string;
  /** IANA zone. Dates render in the courier's own wall-clock time, never UTC. */
  readonly timezone: string;
  readonly defaultLocale: string;
}

/** Everything needed to stand up a new courier company. */
export interface ProvisionTenantInput {
  readonly name: string;
  /** URL-safe, globally unique, immutable — appears in tracking URLs. */
  readonly slug: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
  readonly defaultTimezone: string;
  readonly defaultLocale?: "ar" | "fr" | "en";
  readonly plan?: string;
  /** Overrides the per-plan feature defaults where a key is present. */
  readonly featureOverrides?: Partial<Record<FeatureKey, boolean>>;
}

@Injectable()
export class TenantService {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly operatingConfig: OperatingConfigService,
  ) {}

  /**
   * Provisions a tenant, its default feature flags, and a `tenant.provisioned`
   * event, all in the CALLER'S transaction.
   *
   * This is a control-plane operation. It must run on a connection privileged
   * to insert into `tenants` — the migration role, not the request-path
   * `dp_app` role, which has only SELECT there. Provisioning deliberately lives
   * off the request path (docs/02-domain-model.md §10.2).
   *
   * The sequence matters: the tenant row is created first, then the
   * transaction's tenant context is set to the new id, so the feature rows and
   * the outbox event pass their WITH CHECK policies.
   */
  async provision(tx: TenantTransaction, input: ProvisionTenantInput): Promise<TenantId> {
    const insertedTenant = await tx
      .insert(tenants)
      .values({
        name: input.name,
        slug: input.slug,
        status: "ACTIVE",
        countryCode: input.countryCode,
        defaultCurrency: input.defaultCurrency,
        defaultTimezone: input.defaultTimezone,
        defaultLocale: input.defaultLocale ?? "fr",
        ...(input.plan === undefined ? {} : { plan: input.plan }),
      })
      .returning({ id: tenants.id });

    const created = insertedTenant[0];
    if (created === undefined) {
      throw new Error("Tenant insert returned no row");
    }
    const tenantId = asTenantId(created.id);

    // From here on the transaction is scoped to the new tenant, so feature and
    // outbox writes satisfy Row-Level Security.
    await tx.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);

    const featureRows = Object.entries({ ...DEFAULT_FEATURES, ...input.featureOverrides }).map(
      ([key, enabled]) => ({
        tenantId,
        featureKey: key,
        enabled,
        source: "PLAN" as const,
      }),
    );
    await tx.insert(tenantFeatures).values(featureRows);

    // ⚠️ Failure reasons, working hours and SLA templates, in the SAME
    // transaction. Migration 0026 seeded these with a `CROSS JOIN tenants`,
    // which only ever reached the tenants that existed when it ran — so every
    // courier onboarded afterwards had an empty failure taxonomy, and
    // `decideReattempt` failed open on `CUSTOMER_REFUSED` and sent a driver back
    // to someone who had already said no.
    await this.operatingConfig.seedDefaults(tx, tenantId);

    // Ambient context lets OutboxService enforce the tenant on the envelope.
    // The transaction config above is what RLS reads; this is what the service
    // reads. They are set to the same id.
    await TenantContext.run({ tenantId, actorType: "system" }, async () => {
      await this.outbox.publish(tx, {
        eventType: "tenant.provisioned",
        aggregateType: "tenant",
        aggregateId: tenantId,
        payload: {
          name: input.name,
          slug: input.slug,
          plan: input.plan ?? "PILOT",
          defaultCurrency: input.defaultCurrency,
          defaultTimezone: input.defaultTimezone,
          enabledFeatures: featureRows.filter((row) => row.enabled).map((row) => row.featureKey),
        },
      });
    });

    return tenantId;
  }

  /**
   * The profile of a NAMED tenant, for callers that have just resolved one and
   * hold no ambient context — the public slug lookup being the only such caller.
   *
   * Runs inside a context scoped to that id, so RLS applies exactly as it would
   * for a logged-in member: this reads one tenant's own row, never a scan.
   */
  async profileOf(tenantId: TenantId): Promise<TenantProfile> {
    return TenantContext.run({ tenantId, actorType: "system" }, () => this.profile());
  }

  /**
   * The current tenant's own name, timezone and default language.
   *
   * Exists for anything that renders on the tenant's behalf — printed paperwork
   * puts its name on the letterhead and its dates in its own wall-clock time.
   * Deliberately narrow: three display fields, not the whole row, so this cannot
   * become a way for another context to read a tenant's plan or status.
   *
   * Scoped by `withTenant`, so a tenant can only ever resolve itself.
   */
  async profile(): Promise<TenantProfile> {
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const rows = await tx
        .select({
          name: tenants.name,
          timezone: tenants.defaultTimezone,
          defaultLocale: tenants.defaultLocale,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Tenant");
      }
      return row;
    });
  }

  /**
   * Public slug → tenant id, for unauthenticated entry points.
   *
   * ⚠️ Goes through `resolve_tenant_id_by_slug`, a SECURITY DEFINER function
   * (migration 0029), and NOT through an ordinary select. `tenants` is FORCE RLS
   * with `USING (id = current_setting('app.current_tenant_id'))`, and this is
   * called by the PUBLIC tracking endpoint before any tenant context exists —
   * because discovering the tenant is the whole point. A plain select therefore
   * matched nothing and the tracking page answered "Tenant not found" for every
   * request, always.
   *
   * The function returns only a uuid, and only for an ACTIVE tenant. It is
   * deliberately narrower than an RLS policy would be: RLS is row-level, so
   * "readable by anyone" would expose each tenant's name, plan and status too.
   */
  async resolveBySlug(slug: string): Promise<TenantId> {
    return this.database.withoutTenantScope(async (tx) => {
      const rows = await tx.execute<{ id: string | null }>(
        sql`select resolve_tenant_id_by_slug(${slug}) as id`,
      );
      const id = rows[0]?.id;
      if (id === null || id === undefined) {
        throw new NotFoundError("Tenant");
      }
      return asTenantId(id);
    });
  }
}
