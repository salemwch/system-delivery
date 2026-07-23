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

export {
  OutboxRelayService,
  RELAY_DATABASE,
  RELAY_LOGGER,
} from "./application/outbox-relay.service.js";
export type { RelayLogger, DrainSummary } from "./application/outbox-relay.service.js";

export { EVENT_PUBLISHER } from "./domain/event-publisher.js";
export type { EventPublisher, PublishableEvent } from "./domain/event-publisher.js";
export { ValkeyStreamEventPublisher } from "./infrastructure/valkey-stream.publisher.js";

export { tenants, tenantFeatures, outbox } from "./domain/schema.js";
export type {
  Tenant,
  NewTenant,
  TenantFeature,
  NewTenantFeature,
  OutboxRow,
  NewOutboxRow,
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
