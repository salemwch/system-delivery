import { Module } from "@nestjs/common";

import { ConfigController } from "./api/config.controller.js";
import { ConfigBootstrapService } from "./application/config-bootstrap.service.js";
import { FeatureService } from "./application/feature.service.js";
import { OutboxService } from "./application/outbox.service.js";
import { AuditService } from "./application/audit.service.js";
import { OperatingConfigService } from "./application/operating-config.service.js";
import { TenantService } from "./application/tenant.service.js";
import { NOTIFICATION_PROVIDER } from "./domain/notification-provider.js";
import { ChannelRoutingProvider } from "./infrastructure/channel-routing.provider.js";
import { ConsoleNotificationProvider } from "./infrastructure/console-notification.provider.js";

/**
 * Platform context (docs/04-context-map.md §3.1).
 *
 * Cross-cutting mechanics only — no business rules. Layer 0: depends on nothing
 * but shared infrastructure.
 */
@Module({
  controllers: [ConfigController],
  providers: [
    OutboxService,
    FeatureService,
    TenantService,
    ConfigBootstrapService,
    AuditService,
    OperatingConfigService,
    // The single binding of the outbound-message transport. Both `notification`
    // (business notifications) and `identity` (driver OTP) consume it, so it is
    // bound once here rather than in each.
    //
    // The router picks a real transport per CHANNEL from config: SMS and PUSH have
    // nothing in common below this port. Both default to console, so a
    // misconfigured deployment logs rather than reaching a real handset.
    ConsoleNotificationProvider,
    { provide: NOTIFICATION_PROVIDER, useClass: ChannelRoutingProvider },
  ],
  exports: [
    OutboxService,
    FeatureService,
    TenantService,
    AuditService,
    OperatingConfigService,
    NOTIFICATION_PROVIDER,
  ],
})
export class PlatformModule {}
