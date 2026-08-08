/**
 * Platform context public API (docs/04-context-map.md §3.1).
 *
 * Cross-cutting mechanics only — no business rules. Everything other modules
 * may use from `platform` is exported here; nothing else is reachable.
 */
export { PlatformModule } from "./platform.module.js";
export { OutboxService } from "./application/outbox.service.js";
export { FeatureService } from "./application/feature.service.js";
export { TenantService } from "./application/tenant.service.js";
export type { TenantProfile } from "./application/tenant.service.js";
export { AuditService, ensureAuditPartitions } from "./application/audit.service.js";
export { OperatingConfigService } from "./application/operating-config.service.js";
export { DeadLetterService } from "./application/dead-letter.service.js";
export type { DeadLetterPage, ReplayOutcome } from "./application/dead-letter.service.js";
export type {
  FailureReasonView,
  ReattemptDecision,
} from "./application/operating-config.service.js";
export {
  addWorkingHours,
  nextWorkingInstant,
  parseTimeToMinutes,
  localPartsOf,
  instantAtLocalTime,
} from "./domain/working-calendar.js";
export type { WorkingCalendar, WorkingDay, IsoWeekday } from "./domain/working-calendar.js";
export type {
  AuditInput,
  AuditQuery,
  AuditPage,
  AuditActorType,
  AuditOutcome,
  FieldChange,
} from "./application/audit.service.js";
export { AUDIT_ACTIONS, isAuditAction } from "./domain/audit-actions.js";
export { updateTenantProfileSchema } from "./domain/tenant-dtos.js";
export type { UpdateTenantProfileInput } from "./domain/tenant-dtos.js";
export type { AuditAction } from "./domain/audit-actions.js";

export {
  OutboxRelayService,
  RELAY_DATABASE,
  RELAY_LOGGER,
} from "./application/outbox-relay.service.js";
export type { RelayLogger, DrainSummary } from "./application/outbox-relay.service.js";

export {
  EventStreamConsumer,
  CONSUMER_DATABASE,
  CONSUMER_LOGGER,
} from "./application/event-stream-consumer.js";
export type { ConsumerLogger, ConsumeSummary } from "./application/event-stream-consumer.js";

export { EVENT_PUBLISHER } from "./domain/event-publisher.js";
export type { EventPublisher, PublishableEvent } from "./domain/event-publisher.js";
export { ValkeyStreamEventPublisher } from "./infrastructure/valkey-stream.publisher.js";

/**
 * The outbound-message transport port.
 *
 * Lives in `platform` rather than in `notification` because `identity` needs the
 * same transport to deliver a driver's OTP, and `identity` is layer 0 — it
 * cannot depend on a layer-3 module. A transport is cross-cutting mechanics, not
 * a business rule, so this is exactly what platform is for.
 */
export { NOTIFICATION_PROVIDER } from "./domain/notification-provider.js";
export type {
  NotificationProvider,
  NotificationChannel,
  OutboundMessage,
  DeliveryReceipt,
} from "./domain/notification-provider.js";
export { ConsoleNotificationProvider } from "./infrastructure/console-notification.provider.js";

export { EVENT_HANDLER, REPLAY_HANDLERS } from "./domain/consumed-event.js";
export type { ConsumedEvent, EventHandler } from "./domain/consumed-event.js";

export {
  tenants,
  tenantFeatures,
  outbox,
  processedEvents,
  deadLetterEvents,
  auditLog,
  failureReasons,
  workingHours,
  holidays,
  slaTemplates,
} from "./domain/schema.js";
export type {
  Tenant,
  NewTenant,
  TenantFeature,
  NewTenantFeature,
  OutboxRow,
  NewOutboxRow,
  ProcessedEvent,
  NewProcessedEvent,
  DeadLetterEvent,
  NewDeadLetterEvent,
  AuditEntry,
  NewAuditEntry,
} from "./domain/schema.js";

export {
  FEATURE_KEYS,
  DEFAULT_FEATURES,
  FEATURE_DEPENDENCIES,
  isFeatureKey,
} from "./domain/feature-keys.js";
export type { FeatureKey } from "./domain/feature-keys.js";

export { assertValidEventType } from "./domain/domain-event.js";
export type { DomainEventInput } from "./domain/domain-event.js";
export type { ProvisionTenantInput } from "./application/tenant.service.js";
