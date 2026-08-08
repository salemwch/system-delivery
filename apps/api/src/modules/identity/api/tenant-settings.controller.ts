import { Body, Controller, Get, Put } from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { AppConfigService } from "../../../shared/config/index.js";
import { TenantService, updateTenantProfileSchema } from "../../platform/index.js";
import type { TenantProfile } from "../../platform/index.js";
import { RequirePermissions } from "./request-context.js";

/**
 * The email transport's state. No credential appears here — see the endpoint.
 */
interface EmailStatusResponse {
  /** `console` means messages are logged, never sent. */
  readonly provider: string;
  readonly configured: boolean;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly host: string;
}

interface ProfileResponse {
  readonly name: string;
  readonly timezone: string;
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
  /** Read-only, and returned so a settings screen can show what it cannot change. */
  readonly defaultCurrency: string;
  readonly countryCode: string;
}

/**
 * Général — the courier's own identity and languages.
 *
 * ⚠️ Reading is open to any authenticated member of the tenant: the courier's own
 * name and timezone are on every document they print, and gating them behind
 * `tenant:update` would mean a dispatcher's app shell could not render a date in
 * the right zone. WRITING is `tenant:update`, held by OWNER only.
 *
 * ⚠️ LIVES IN `identity`, NOT `platform`, and that is not arbitrary. `platform`
 * is layer 0 and depends on NOTHING — importing an authorization decorator from
 * `identity` (its layer-0 peer, which already depends on platform) would close a
 * module cycle the boundary lint rejects. `identity` owns the decorators and may
 * read platform, so the controller belongs here and the service stays there.
 *
 * Deliberately NOT part of `ConfigController` either: that endpoint is the
 * app-shell bootstrap and carries no permission at all by design, so putting a
 * mutation beside it invites the next one to inherit the same absence.
 */
@Controller("v1/tenant")
export class TenantSettingsController {
  constructor(
    private readonly tenants: TenantService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * E-mail — whether a transport is bound, and which address it sends from.
   *
   * ⚠️ READ-ONLY, AND DELIBERATELY SO. The obvious feature is a form for SMTP
   * host, username and password — and it would mean storing a live SMTP
   * PASSWORD in the database, which is a credential store this system does not
   * have and should not grow for one integration. Secrets live in the
   * deployment's own secret store; the screen tells an operator what is
   * currently wired and where to change it.
   *
   * Returns no credential of any kind — not the username, and obviously not the
   * password. Only what is safe to read back: the provider name and the From
   * address that already appears in the header of every message sent.
   */
  @Get("email-status")
  @RequirePermissions("tenant:update")
  emailStatus(): EmailStatusResponse {
    const provider = this.config.get("NOTIFICATION_EMAIL_PROVIDER");
    return {
      provider,
      configured: provider !== "console",
      fromAddress: this.config.get("SMTP_FROM_ADDRESS"),
      fromName: this.config.get("SMTP_FROM_NAME"),
      host: this.config.get("SMTP_HOST"),
    };
  }

  @Get("profile")
  async profile(): Promise<ProfileResponse> {
    return toResponse(await this.tenants.profile());
  }

  @Put("profile")
  @RequirePermissions("tenant:update")
  async update(
    @Body(zodBody(updateTenantProfileSchema)) body: z.infer<typeof updateTenantProfileSchema>,
  ): Promise<ProfileResponse> {
    return toResponse(await this.tenants.updateProfile(body));
  }
}

function toResponse(profile: TenantProfile): ProfileResponse {
  return {
    name: profile.name,
    timezone: profile.timezone,
    defaultLocale: profile.defaultLocale,
    supportedLocales: profile.supportedLocales,
    defaultCurrency: profile.defaultCurrency,
    countryCode: profile.countryCode,
  };
}
