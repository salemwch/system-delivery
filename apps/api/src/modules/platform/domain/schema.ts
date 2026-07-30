import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Platform module schema.
 *
 * Column naming is snake_case in the database and camelCase in TypeScript, per
 * docs/02-domain-model.md §1. Drizzle maps between them explicitly so neither
 * layer has to compromise.
 *
 * The authoritative DDL — including Row-Level Security policies, grants, and
 * constraints — lives in apps/api/migrations. These definitions give the query
 * builder its types; they are not the source of truth for the schema.
 */

/** docs/02-domain-model.md §3.1 — the root of all isolation. */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text("name").notNull(),
    /** URL-safe, globally unique, immutable — appears in tracking URLs. */
    slug: text("slug").notNull(),
    status: text("status").notNull().default("PROVISIONING"),
    countryCode: text("country_code").notNull(),
    /** Immutable once any ledger entry exists (docs §3.1 rule 2). */
    defaultCurrency: text("default_currency").notNull(),
    defaultTimezone: text("default_timezone").notNull(),
    defaultLocale: text("default_locale").notNull().default("fr"),
    supportedLocales: text("supported_locales")
      .array()
      .notNull()
      .default(sql`ARRAY['ar','fr','en']`),
    plan: text("plan").notNull().default("PILOT"),
    region: text("region").notNull().default("eu-central"),
    settings: jsonb("settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tenants_slug_key").on(table.slug),
    index("tenants_status_idx").on(table.status),
  ],
);

/**
 * docs/02-domain-model.md §3.17 — per-tenant capability toggles.
 *
 * This is the entity that prevents `if (tenantId === '...')` spreading through
 * the codebase (invariant I17). It is also the first tenant-scoped table, so it
 * is what the cross-tenant isolation suite exercises.
 */
export const tenantFeatures = pgTable(
  "tenant_features",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** From a compile-time registry, never free text (docs §3.17 rule 1). */
    featureKey: text("feature_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    /** Why the tenant has it: PLAN | OVERRIDE | TRIAL. */
    source: text("source").notNull().default("PLAN"),
    config: jsonb("config"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Mandatory for OVERRIDE — why this tenant got a manual exception. */
    reason: text("reason"),
    updatedByUserId: uuid("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tenant_features_tenant_key_uq").on(table.tenantId, table.featureKey),
    index("tenant_features_tenant_idx").on(table.tenantId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantFeature = typeof tenantFeatures.$inferSelect;
export type NewTenantFeature = typeof tenantFeatures.$inferInsert;

/**
 * docs/03-event-storming.md §2.3 — the transactional outbox.
 *
 * A domain module inserts an event row in the SAME transaction as its business
 * write; a relay publishes unpublished rows in `seq` order. This is what makes
 * event publication atomic with the state change (ADR-004).
 */
export const outbox = pgTable(
  "outbox",
  {
    seq: bigint("seq", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    eventId: uuid("event_id")
      .notNull()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** domain.fact, past tense, e.g. "shipment.delivered". */
    eventType: text("event_type").notNull(),
    eventVersion: smallint("event_version").notNull().default(1),
    aggregateType: text("aggregate_type").notNull(),
    /** Partition key — ordering is guaranteed per aggregate. */
    aggregateId: uuid("aggregate_id").notNull(),
    correlationId: uuid("correlation_id"),
    causationId: uuid("causation_id"),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** The relay claims a row only when this is `<= now()`. Advanced on failure. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: smallint("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** W3C trace-context captured at produce time; carried to the consumer's span. */
    traceparent: text("traceparent"),
    tracestate: text("tracestate"),
  },
  (table) => [
    uniqueIndex("outbox_event_id_uq").on(table.eventId),
    index("outbox_tenant_idx").on(table.tenantId),
  ],
);

export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = typeof outbox.$inferInsert;

/**
 * docs/03-event-storming.md §2.3 (Idempotency) — the consumer idempotency ledger.
 *
 * One row per (consumer_group, event_id) a consumer has durably handled. The
 * generic stream consumer checks this before handling and records it after, so a
 * redelivered event (at-least-once delivery) is a clean no-op. Tenant-scoped +
 * FORCE RLS; the authoritative DDL is migration `0010_notifications.sql`.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    consumerGroup: text("consumer_group").notNull(),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("processed_events_group_event_uq").on(table.consumerGroup, table.eventId),
    index("processed_events_tenant_idx").on(table.tenantId),
  ],
);

/**
 * docs/03-event-storming.md §62 — the per-consumer, per-tenant dead-letter queue.
 *
 * A poison message that exhausts its retries lands here for inspection + replay,
 * and an alert fires. It never blocks the consumer group and is never dropped.
 */
export const deadLetterEvents = pgTable(
  "dead_letter_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    consumerGroup: text("consumer_group").notNull(),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    streamId: text("stream_id").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text("error").notNull(),
    deliveryCount: integer("delivery_count").notNull().default(1),
    /** PENDING | RESOLVED | DISCARDED. */
    status: text("status").notNull().default("PENDING"),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).notNull().defaultNow(),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("dead_letter_group_event_uq").on(table.consumerGroup, table.eventId),
    index("dead_letter_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export type ProcessedEvent = typeof processedEvents.$inferSelect;
export type NewProcessedEvent = typeof processedEvents.$inferInsert;
export type DeadLetterEvent = typeof deadLetterEvents.$inferSelect;
export type NewDeadLetterEvent = typeof deadLetterEvents.$inferInsert;

/**
 * docs/07-security-architecture.md §10 — the append-only audit trail.
 *
 * The authoritative DDL is `migrations/0022_audit_log.sql`: monthly RANGE
 * partitioning, SELECT+INSERT grants only, and a trigger that rejects UPDATE
 * and DELETE. None of that is expressible here, so this definition exists to
 * give the query builder its types and nothing more.
 *
 * The primary key in the database is `(id, created_at)` — a partitioned table
 * requires its partition key in every unique constraint. `id` alone is declared
 * here because it is a UUIDv7 and therefore already unique; the composite only
 * matters to Postgres.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** USER | DRIVER | SYSTEM | API_CLIENT | ANONYMOUS | PLATFORM_ADMIN. */
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    /** Denormalised: the actor row may be renamed or gone in seven years. */
    actorLabel: text("actor_label"),
    /** `domain.action`, past tense — e.g. `auth.login_failed`. */
    action: text("action").notNull(),
    /** SUCCESS | FAILURE | DENIED. */
    outcome: text("outcome").notNull().default("SUCCESS"),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    /** Before/after for significant fields only — never a blanket row dump. */
    changes: jsonb("changes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    context: jsonb("context")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_resource_idx").on(
      table.tenantId,
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
    index("audit_log_tenant_time_idx").on(table.tenantId, table.createdAt),
  ],
);

export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;

/**
 * Per-tenant operating configuration (migration 0026).
 *
 * Config as DATA (docs/01 §4.1 #1.8) — these were TypeScript constants, which
 * meant a courier could not change its own failure taxonomy or working week
 * without a deploy.
 */
export const failureReasons = pgTable(
  "failure_reasons",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** SCREAMING_SNAKE, stable — written to `shipment_events.reason_code`. */
    code: text("code").notNull(),
    /** Per-locale labels for the driver app's picker. */
    labels: jsonb("labels")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** False → the parcel returns instead of consuming its remaining attempts. */
    allowsReattempt: boolean("allows_reattempt").notNull().default(true),
    /** RECIPIENT | COURIER | MERCHANT | EXTERNAL. */
    fault: text("fault").notNull().default("RECIPIENT"),
    displayOrder: smallint("display_order").notNull().default(100),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("failure_reasons_tenant_code_uq").on(table.tenantId, table.code)],
);

export const workingHours = pgTable("working_hours", {
  tenantId: uuid("tenant_id").notNull(),
  /** ISO-8601: 1 = Monday … 7 = Sunday. */
  dayOfWeek: smallint("day_of_week").notNull(),
  /** LOCAL wall-clock `HH:MM:SS` in the tenant's timezone, never UTC. */
  opensAt: text("opens_at").notNull(),
  closesAt: text("closes_at").notNull(),
  isWorking: boolean("is_working").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const holidays = pgTable("holidays", {
  tenantId: uuid("tenant_id").notNull(),
  /** A local calendar date — a holiday is a day, not an instant. */
  day: date("day").notNull(),
  label: text("label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const slaTemplates = pgTable(
  "sla_templates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** STANDARD | EXPRESS | SCHEDULED — the same set as `shipments.service_level`. */
    serviceLevel: text("service_level").notNull(),
    /** WORKING hours, not elapsed. */
    deliveryHours: integer("delivery_hours").notNull(),
    reattemptDelayHours: integer("reattempt_delay_hours").notNull().default(24),
    maxAttempts: smallint("max_attempts").notNull().default(3),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("sla_templates_tenant_level_uq").on(table.tenantId, table.serviceLevel)],
);

export type FailureReasonRow = typeof failureReasons.$inferSelect;
export type SlaTemplateRow = typeof slaTemplates.$inferSelect;
