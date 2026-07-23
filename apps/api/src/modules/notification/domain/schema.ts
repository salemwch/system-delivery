import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Notification module schema (docs/04-context-map.md §3.11).
 *
 * The authoritative DDL — RLS policies, grants (append + status-update on the
 * log), and constraints — is migration `0010_notifications.sql`. These give the
 * query builder its types; they are not the source of truth.
 */

export const notificationTemplates = pgTable(
  "notification_templates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    key: text("key").notNull(),
    /** ar | fr | en — templates are per-tenant AND per-locale (§3.11). */
    locale: text("locale").notNull(),
    /** SMS | PUSH | EMAIL. */
    channel: text("channel").notNull(),
    /** `{{placeholder}}` tokens substituted from the event params at send time. */
    body: text("body").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_templates_key_uq").on(
      table.tenantId,
      table.key,
      table.locale,
      table.channel,
    ),
  ],
);

export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    /** The event that triggered this message; the unique below dedupes redelivery. */
    eventId: uuid("event_id"),
    correlationId: uuid("correlation_id"),
    channel: text("channel").notNull(),
    templateKey: text("template_key").notNull(),
    locale: text("locale").notNull(),
    /** Operational recipient (phone / device token). */
    recipient: text("recipient").notNull(),
    body: text("body"),
    /** PENDING | SENT | FAILED | SKIPPED. */
    status: text("status").notNull().default("PENDING"),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    params: jsonb("params")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("notification_log_event_template_uq").on(
      table.tenantId,
      table.eventId,
      table.templateKey,
      table.channel,
    ),
    index("notification_log_tenant_created_idx").on(table.tenantId, table.createdAt),
  ],
);

export type NotificationTemplate = typeof notificationTemplates.$inferSelect;
export type NewNotificationTemplate = typeof notificationTemplates.$inferInsert;
export type NotificationLogRow = typeof notificationLog.$inferSelect;
export type NewNotificationLogRow = typeof notificationLog.$inferInsert;
