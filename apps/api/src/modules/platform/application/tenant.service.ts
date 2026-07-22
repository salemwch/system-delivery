import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { TenantContext, asTenantId } from "../../../shared/database/index.js";
import type { TenantId, TenantTransaction } from "../../../shared/database/index.js";
import { DEFAULT_FEATURES } from "../domain/feature-keys.js";
import type { FeatureKey } from "../domain/feature-keys.js";
import { tenantFeatures, tenants } from "../domain/schema.js";
import { OutboxService } from "./outbox.service.js";

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
  constructor(private readonly outbox: OutboxService) {}

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
}
