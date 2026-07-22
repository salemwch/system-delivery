-- Transactional outbox (docs/03-event-storming.md §2.3, ADR-004).
--
-- The outbox is what makes event publication atomic with the state change it
-- describes. A domain module writes its business rows AND an outbox row in the
-- SAME transaction; a separate relay later reads unpublished rows and delivers
-- them. Without this, publishing is a dual write — commit the shipment, then
-- publish separately — and a crash between the two either loses the event or
-- fires one for a rolled-back change. Neither is acceptable when money is
-- involved.
--
-- Tenant-scoped DATA table: RLS ENABLED and FORCED, like every other.

CREATE TABLE IF NOT EXISTS outbox (
  -- BIGINT identity, not UUID: this column defines PUBLICATION ORDER, and a
  -- monotonic sequence is what the relay reads in order. UUIDv7 is time-ordered
  -- but a gap-free counter is clearer for "everything after offset N".
  seq            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The event's own identity, carried in the envelope. This is the consumer's
  -- idempotency key — consumers dedupe on it under at-least-once delivery.
  event_id       UUID        NOT NULL DEFAULT uuidv7(),

  tenant_id      UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- domain.fact, past tense, e.g. 'shipment.delivered' (event-storming §2.1).
  event_type     TEXT        NOT NULL,
  event_version  SMALLINT    NOT NULL DEFAULT 1,

  -- Ordering is guaranteed per aggregate_id, which is the partition key.
  aggregate_type TEXT        NOT NULL,
  aggregate_id   UUID        NOT NULL,

  -- correlation_id ties one user action to everything it causes; causation_id
  -- is the event/command that directly produced this one. Both are essential
  -- for tracing asynchronous fan-out.
  correlation_id UUID,
  causation_id   UUID,

  payload        JSONB       NOT NULL,

  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- business time
  published_at   TIMESTAMPTZ,                          -- NULL until relayed
  attempts       SMALLINT    NOT NULL DEFAULT 0,
  last_error     TEXT,

  CONSTRAINT outbox_event_type_chk    CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT outbox_event_version_chk CHECK (event_version >= 1),
  CONSTRAINT outbox_attempts_chk      CHECK (attempts >= 0)
);

-- The relay scans ONLY unpublished rows, oldest first. A partial index keeps
-- that scan tiny regardless of how large the table grows, because published
-- rows drop out of the index entirely.
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox (seq)
  WHERE published_at IS NULL;

-- event_id is globally unique: it is the consumer idempotency key and a
-- duplicate would let the same event be processed twice.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_event_id_uq ON outbox (event_id);

CREATE INDEX IF NOT EXISTS outbox_tenant_idx ON outbox (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security. The outbox holds one row per business event and every
-- row names its tenant; isolation is identical to any other data table.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_isolation ON outbox;
CREATE POLICY outbox_isolation ON outbox
  FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- The relay updates published_at and attempts; domain code only ever inserts.
GRANT SELECT, INSERT, UPDATE ON outbox TO dp_app;

COMMENT ON TABLE outbox IS
  'Transactional outbox. Domain modules insert an event row in the same transaction as the business write; a relay publishes unpublished rows in seq order. Makes event publication atomic with the state change (ADR-004).';
