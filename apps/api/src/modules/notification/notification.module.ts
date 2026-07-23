import { Module } from "@nestjs/common";

import { PlatformModule } from "../platform/index.js";
import { NotificationService } from "./application/notification.service.js";
import { NotificationEventHandler } from "./application/notification-event.handler.js";
import { NOTIFICATION_PROVIDER } from "./domain/notification-provider.js";
import { ConsoleNotificationProvider } from "./infrastructure/console-notification.provider.js";

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
  imports: [PlatformModule],
  providers: [
    NotificationService,
    NotificationEventHandler,
    { provide: NOTIFICATION_PROVIDER, useClass: ConsoleNotificationProvider },
  ],
  exports: [NotificationService, NotificationEventHandler],
})
export class NotificationModule {}
