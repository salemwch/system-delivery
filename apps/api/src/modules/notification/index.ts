/**
 * Notification context public API (docs/04-context-map.md §3.11).
 *
 * Purely reactive — it exposes almost nothing by design. The event handler is
 * driven by the platform stream consumer; the service and provider port are here
 * so the core-worker composition root can wire them.
 */
export { NotificationModule } from "./notification.module.js";
export { NotificationService } from "./application/notification.service.js";
export { NotificationEventHandler } from "./application/notification-event.handler.js";
export type { SendCommand } from "./application/notification.service.js";

export { NOTIFICATION_PROVIDER } from "./domain/notification-provider.js";
export type {
  NotificationProvider,
  NotificationChannel,
  OutboundMessage,
  DeliveryReceipt,
} from "./domain/notification-provider.js";
export { ConsoleNotificationProvider } from "./infrastructure/console-notification.provider.js";

export {
  NOTIFICATION_LOCALES,
  DEFAULT_TEMPLATES,
  defaultTemplateBody,
  renderTemplate,
  toLocale,
} from "./domain/templates.js";
export type { Locale } from "./domain/templates.js";

export { notificationTemplates, notificationLog } from "./domain/schema.js";
export type {
  NotificationTemplate,
  NewNotificationTemplate,
  NotificationLogRow,
  NewNotificationLogRow,
} from "./domain/schema.js";
