-- Event-consumer infrastructure + the notification context (docs/03-event-storming
-- §2.3, docs/04-context-map.md §3.11). Layer 3 (notification) plus two
-- cross-cutting consumer tables the platform's generic stream consumer owns.
--
-- The relay PUBLISHES the outbox to the Valkey stream; this is the first thing
-- that CONSUMES it. Consumers read with XREADGROUP and, per the event-storming
-- guarantees (§2.3): they record every processed eventId and no-op on repeats
-- (at-least-once delivery means duplicates are normal), and a poison message that
-- fails MAX_DELIVERIES times goes to a per-tenant DLQ — never silently dropped.
--
-- Every table here is tenant-scoped with ENABLE + FORCE RLS. The consumer runs as
-- dp_app in the worker and sets tenant context from the envelope's tenantId before
-- writing, so RLS is enforced on the async path exactly as on the request path.

-- ─────────────────────────────────────────────────────────────────────────────
-- processed_events — the idempotency ledger (event-storming §2.3, Idempotency).
-- One row per (consumer_group, event_id) the consumer has durably handled.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_events (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  consumer_group  TEXT NOT NULL,
  event_id        UUID NOT NULL,
  event_type      TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- eventId is globally unique, so a group processes each event at most once. This
-- unique is what makes a redelivered message a clean no-op.
CREATE UNIQUE INDEX IF NOT EXISTS processed_events_group_event_uq
  ON processed_events (consumer_group, event_id);
CREATE INDEX IF NOT EXISTS processed_events_tenant_idx ON processed_events (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- dead_letter_events — the per-consumer, per-tenant DLQ (event-storming §62).
-- A message that exhausts its retries lands here for inspection + replay, and an
-- alert fires; it never blocks the consumer group or is dropped.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dead_letter_events (
  id              UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  consumer_group  TEXT NOT NULL,
  event_id        UUID NOT NULL,
  event_type      TEXT NOT NULL,
  -- The Valkey stream entry id, so the message can be traced/replayed.
  stream_id       TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  error           TEXT NOT NULL,
  delivery_count  INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,

  CONSTRAINT dead_letter_status_chk CHECK (status IN ('PENDING', 'RESOLVED', 'DISCARDED')),
  CONSTRAINT dead_letter_delivery_chk CHECK (delivery_count > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dead_letter_group_event_uq
  ON dead_letter_events (consumer_group, event_id);
CREATE INDEX IF NOT EXISTS dead_letter_tenant_status_idx
  ON dead_letter_events (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- notification_templates — per-tenant, per-locale message bodies.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
  id           UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  locale       TEXT NOT NULL,
  channel      TEXT NOT NULL,
  -- `{{placeholder}}` tokens are substituted from the event params at send time.
  body         TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_templates_locale_chk CHECK (locale IN ('ar', 'fr', 'en')),
  CONSTRAINT notification_templates_channel_chk CHECK (channel IN ('SMS', 'PUSH', 'EMAIL'))
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_templates_key_uq
  ON notification_templates (tenant_id, key, locale, channel);

-- ─────────────────────────────────────────────────────────────────────────────
-- notification_log — the audit record of every message the platform decided to
-- send (or deliberately skipped). Append + status update; never hard-deleted.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_log (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- The event that triggered this message; the pair below dedupes a redelivery.
  event_id            UUID,
  correlation_id      UUID,
  channel             TEXT NOT NULL,
  template_key        TEXT NOT NULL,
  locale              TEXT NOT NULL,
  -- Operational recipient (phone / device token). Stored like shipments.recipient_phone.
  recipient           TEXT NOT NULL,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  error               TEXT,
  params              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,

  CONSTRAINT notification_log_channel_chk CHECK (channel IN ('SMS', 'PUSH', 'EMAIL')),
  CONSTRAINT notification_log_status_chk CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED'))
);

-- One notification per (event, template) — the consumer is idempotent, but this
-- is the last-resort guard against a double send for the same trigger. A NULL
-- event_id (a manual / eventless notification) is distinct in a unique index, so
-- those never collide; only event-triggered sends dedupe.
CREATE UNIQUE INDEX IF NOT EXISTS notification_log_event_template_uq
  ON notification_log (tenant_id, event_id, template_key, channel);
CREATE INDEX IF NOT EXISTS notification_log_tenant_created_idx
  ON notification_log (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security + grants.
--
--   processed_events  — append-only: REVOKE UPDATE, DELETE, TRUNCATE.
--   dead_letter_events — status is updated (RESOLVED); REVOKE DELETE, TRUNCATE.
--   notification_templates — mutable config; REVOKE only TRUNCATE.
--   notification_log — append + status update; REVOKE DELETE, TRUNCATE (audit).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'processed_events', 'dead_letter_events', 'notification_templates', 'notification_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      || 'USING (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid) '
      || 'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)',
      tbl || '_isolation', tbl
    );
  END LOOP;

  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON processed_events FROM dp_app';
  EXECUTE 'REVOKE DELETE, TRUNCATE ON dead_letter_events FROM dp_app';
  EXECUTE 'REVOKE TRUNCATE ON notification_templates FROM dp_app';
  EXECUTE 'REVOKE DELETE, TRUNCATE ON notification_log FROM dp_app';
END
$$;

COMMENT ON TABLE processed_events IS
  'Consumer idempotency ledger (event-storming §2.3). One row per (consumer_group, event_id) durably handled; a redelivery is a no-op.';
COMMENT ON TABLE dead_letter_events IS
  'Per-consumer, per-tenant DLQ (event-storming §62). Poison messages land here for inspection + replay; never dropped, never block the group.';
COMMENT ON TABLE notification_log IS
  'Audit of every message sent or deliberately skipped. Append + status update; never hard-deleted.';
