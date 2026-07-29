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
export { TemplateService } from "./application/template.service.js";
export type { SendCommand } from "./application/notification.service.js";

// NOTIFICATION_PROVIDER and its implementations moved to `platform`: identity
// needs the same transport to deliver a driver's OTP, and identity is layer 0.
// Import them from `platform`, not from here.

export {
  NOTIFICATION_LOCALES,
  DEFAULT_TEMPLATES,
  defaultTemplateBody,
  renderTemplate,
  toLocale,
  estimateSegments,
} from "./domain/templates.js";
export type { Locale } from "./domain/templates.js";

export { notificationTemplates, notificationLog } from "./domain/schema.js";
export type {
  NotificationTemplate,
  NewNotificationTemplate,
  NotificationLogRow,
  NewNotificationLogRow,
} from "./domain/schema.js";
