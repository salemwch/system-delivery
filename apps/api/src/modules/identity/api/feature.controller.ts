import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { z } from "zod";

import { TenantContext } from "../../../shared/database/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { zodBody } from "../../../shared/http/index.js";
import { FEATURE_KEYS, FeatureService, isFeatureKey } from "../../platform/index.js";
import { RequirePermissions } from "./request-context.js";

const setFeatureSchema = z.strictObject({ enabled: z.boolean() });

interface FeatureResponse {
  readonly key: string;
  readonly enabled: boolean;
}

/**
 * Options — the per-tenant feature flags.
 *
 * ⚠️ Flags are how per-tenant behaviour is expressed AT ALL (invariant I17):
 * nothing in this codebase branches on a literal tenant id, so turning COD off
 * for one courier IS this switch. That makes this a consequential screen rather
 * than a cosmetic one, and `feature:manage` is OWNER-only for that reason.
 *
 * ⚠️ LIVES IN `identity`, NOT `platform`, for the same reason as
 * `TenantSettingsController`: platform is layer 0 and depends on nothing, so
 * importing an authorization decorator from its layer-0 peer would close a
 * module cycle. `identity` owns the decorators and may read platform.
 */
@Controller("v1/features")
export class FeatureController {
  constructor(private readonly features: FeatureService) {}

  /**
   * Every known flag with its current state.
   *
   * The full catalogue, not only what is on: a screen that listed only enabled
   * flags would give an operator no way to turn one on.
   */
  @Get()
  @RequirePermissions("feature:manage")
  async list(): Promise<{ readonly data: readonly FeatureResponse[] }> {
    const tenantId = TenantContext.requireTenantId();
    const enabled = new Set(await this.features.enabledKeys(tenantId));
    return { data: FEATURE_KEYS.map((key) => ({ key, enabled: enabled.has(key) })) };
  }

  @Put(":key")
  @RequirePermissions("feature:manage")
  async set(
    @Param("key") key: string,
    @Body(zodBody(setFeatureSchema)) body: z.infer<typeof setFeatureSchema>,
  ): Promise<FeatureResponse> {
    // Narrowed before use: the key is a path segment, and an unknown one would
    // otherwise be written as a row nothing ever reads — a flag that appears to
    // be set and does nothing.
    if (!isFeatureKey(key)) {
      throw new NotFoundError("Feature");
    }

    const tenantId = TenantContext.requireTenantId();
    await this.features.setEnabled(tenantId, key, body.enabled);
    return { key, enabled: body.enabled };
  }
}
