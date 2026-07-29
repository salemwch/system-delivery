import { Module } from "@nestjs/common";

import { PlatformModule } from "../platform/index.js";
import { NotificationService } from "./application/notification.service.js";
import { NotificationEventHandler } from "./application/notification-event.handler.js";
import { TemplateService } from "./application/template.service.js";
import { TemplateController } from "./api/template.controller.js";

/**
 * Notification context (docs/04-context-map.md §3.11) — Layer 3.
 *
 * Purely reactive: it consumes events and exposes almost nothing. Nobody calls it
 * to trigger business behaviour — the {@link NotificationEventHandler} is driven
 * by the platform's generic stream consumer (wired in the core-worker composition
 * root, which binds it as the EVENT_HANDLER). Depends only on `platform`
 * (FeatureService for the SMS_ENABLED gate) and the shared database.
 *
 * The provider is bound through the {@link NOTIFICATION_PROVIDER} port; at MVP the
 * only binding is the no-send logging provider (CLAUDE.md scope §4 / MVP-O1) — a
 * real aggregator implements the same port with no caller change.
 */
@Module({
  // The NOTIFICATION_PROVIDER binding lives in PlatformModule, which is where
  // the port itself now lives: `identity` needs it to deliver a driver's OTP,
  // and identity is layer 0, so the transport abstraction cannot sit in a
  // layer-3 module. One port, one binding, two consumers.
  imports: [PlatformModule],
  controllers: [TemplateController],
  providers: [NotificationService, NotificationEventHandler, TemplateService],
  exports: [NotificationService, NotificationEventHandler, TemplateService],
})
export class NotificationModule {}
