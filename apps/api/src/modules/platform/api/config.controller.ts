import { Controller, Get } from "@nestjs/common";

import { ConfigBootstrapService } from "../application/config-bootstrap.service.js";
import type { BootstrapConfig } from "../application/config-bootstrap.service.js";

/**
 * The app-shell bootstrap: everything a client needs before it can render
 * anything — enabled features, currency exponent, locales, failure reasons.
 *
 * Deliberately carries NO `@RequirePermissions`. AuthGuard is global and
 * deny-by-default, so this route still requires a valid session; what it does
 * not do is gate the app shell behind a domain permission. Requiring, say,
 * `shipment:read` here would lock a finance-only or fleet-only user out of the
 * UI entirely — every authenticated member of a tenant needs their own tenant's
 * config to boot.
 *
 * That also keeps `platform` (layer 0) free of any dependency on `identity`
 * (layer 0). The two are peers and `identity` already depends on `platform`, so
 * importing an authorization decorator here would close a module cycle
 * (docs/04-context-map.md §2.1). RLS scopes the response to the caller's tenant.
 */
@Controller("v1/config")
export class ConfigController {
  constructor(private readonly bootstrap: ConfigBootstrapService) {}

  @Get("bootstrap")
  async getBootstrap(): Promise<BootstrapConfig> {
    return this.bootstrap.getBootstrap();
  }
}
