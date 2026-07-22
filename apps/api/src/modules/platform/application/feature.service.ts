import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { DatabaseService } from "../../../shared/database/index.js";
import type { TenantId } from "../../../shared/database/index.js";
import { FeatureNotEntitledError } from "../../../shared/errors/index.js";
import type { FeatureKey } from "../domain/feature-keys.js";
import { tenantFeatures } from "../domain/schema.js";

/**
 * Feature-flag resolution (docs/02-domain-model.md §3.17).
 *
 * The one rule that governs everything here: FAIL CLOSED. If a flag cannot be
 * resolved — no row, an expired trial, or an error — the answer is `false`.
 * A billing or availability failure must never hand out paid capability.
 *
 * Enforcement of a flag happens in three places (docs §3.17 rule 7): the API
 * guard, the UI, and event consumers. This service is the shared resolver they
 * all call.
 *
 * NOTE ON CACHING: reads currently hit PostgreSQL directly. The interface is
 * deliberately shaped so a Valkey cache with explicit invalidation on
 * `tenant.feature_changed` can be added later without touching a single caller.
 * A direct read is correct; caching is an optimisation, not a correctness
 * requirement, and is added when feature checks show up in query profiles.
 */
@Injectable()
export class FeatureService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Whether a feature is enabled for a tenant right now.
   *
   * A row must exist, be enabled, and either have no expiry or not yet have
   * expired. Anything else — including no row at all — resolves to `false`.
   */
  async isEnabled(tenantId: TenantId, key: FeatureKey): Promise<boolean> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ enabled: tenantFeatures.enabled, expiresAt: tenantFeatures.expiresAt })
        .from(tenantFeatures)
        .where(and(eq(tenantFeatures.tenantId, tenantId), eq(tenantFeatures.featureKey, key)))
        .limit(1);

      const row = rows[0];
      if (row === undefined || !row.enabled) {
        return false;
      }
      if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
        return false;
      }
      return true;
    }, tenantId);
  }

  /**
   * Throws FeatureNotEntitledError (403) when the feature is not enabled.
   *
   * For use at the API boundary and in guards, so a disabled feature returns a
   * clean, documented error rather than a generic failure deeper in the stack.
   */
  async requireEnabled(tenantId: TenantId, key: FeatureKey): Promise<void> {
    if (!(await this.isEnabled(tenantId, key))) {
      throw new FeatureNotEntitledError(key);
    }
  }

  /**
   * All enabled feature keys for a tenant.
   *
   * Returned to a client at login so the UI can render the correct application
   * from the first paint (docs/05-api-contracts.md §2). This is a hint for the
   * UI, never the security boundary — the guards are.
   */
  async enabledKeys(tenantId: TenantId): Promise<FeatureKey[]> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ key: tenantFeatures.featureKey })
        .from(tenantFeatures)
        .where(
          and(
            eq(tenantFeatures.tenantId, tenantId),
            eq(tenantFeatures.enabled, true),
            sql`(${tenantFeatures.expiresAt} is null or ${tenantFeatures.expiresAt} > now())`,
          ),
        );
      return rows.map((row) => row.key as FeatureKey);
    }, tenantId);
  }
}
