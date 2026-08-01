import { Controller, Get, Param } from "@nestjs/common";

import { TenantService } from "../../platform/index.js";
import { Public } from "./request-context.js";

interface TenantLookupResponse {
  readonly id: string;
  readonly name: string;
}

/**
 * Public slug → tenant id, so a login form can ask for an email and a password
 * instead of a UUID.
 *
 * ⚠️ Every authenticated endpoint takes `tenantId` as a UUID, which is correct
 * internally and impossible at a login screen — no merchant is going to type
 * `019fb576-c0b9-…`. A client resolves its courier's slug here once, then logs
 * in normally. The slug is already public: it appears in every tracking URL a
 * recipient receives by SMS.
 *
 * What this discloses is that a given slug exists and what the courier is
 * called — both of which are on the tracking page already — plus an opaque
 * uuid that grants nothing without credentials. It deliberately returns nothing
 * else: no plan, no status, no counts.
 *
 * Lives in `identity` rather than `platform` because `platform` is a peer at
 * layer 0 and importing `@Public` there would close a module cycle
 * (docs/04-context-map.md §2.1) — the same reason `ConfigController` carries no
 * authorization decorator.
 */
@Controller("v1/tenants")
export class TenantLookupController {
  constructor(private readonly tenants: TenantService) {}

  @Get("by-slug/:slug")
  @Public()
  async bySlug(@Param("slug") slug: string): Promise<TenantLookupResponse> {
    // `resolveBySlug` throws NotFoundError for an unknown OR suspended tenant,
    // which is the same 404 either way — a suspended courier's existence is not
    // something to advertise.
    const tenantId = await this.tenants.resolveBySlug(slug);
    const profile = await this.tenants.profileOf(tenantId);
    return { id: tenantId, name: profile.name };
  }
}
