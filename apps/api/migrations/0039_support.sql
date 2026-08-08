-- Support — the conversation between a merchant and the courier's back office.
--
-- ── Why this is not `complaints` ────────────────────────────────────────────
--
-- A complaint is a CLAIM: something went wrong, a parcel was damaged or lost,
-- and in a COD market it is frequently a claim on money — which is why
-- `complaints` carries a severity, an SLA per type, and a reversing ledger
-- transaction for COD_DISPUTE. Every one of those fields exists to answer
-- "what do we owe, and when must we answer by".
--
-- A support ticket is a QUESTION. "How do I export my parcels?" "Can you change
-- my pickup time on Fridays?" "Why was I charged the return fee twice?" It has
-- no severity, no money attached, and no claim — and forcing it into
-- `complaints` would mean every complaint query has to exclude a type that is
-- not a complaint, and the dashboard's "open complaints" figure would count
-- questions.
--
-- The real distinguishing feature is the THREAD. A complaint is investigated
-- and resolved; a ticket is a back-and-forth, and the messages are the point.

CREATE TABLE IF NOT EXISTS support_tickets (
  id                   UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Human-quotable reference, what a merchant reads down the phone. Sequential
  -- per tenant, from a row-locked counter — see `support_ticket_sequences`.
  reference            TEXT        NOT NULL,

  subject              TEXT        NOT NULL,

  -- OPEN | PENDING_MERCHANT | RESOLVED | CLOSED.
  --
  -- PENDING_MERCHANT is the one worth having: a ticket waiting on the person who
  -- raised it is NOT the courier's backlog, and counting it as such makes the
  -- queue permanently red through nobody's fault.
  status               TEXT        NOT NULL DEFAULT 'OPEN',

  -- BILLING | PICKUP | DELIVERY | ACCOUNT | TECHNICAL | OTHER. Routes the ticket
  -- to whoever answers that kind of question; deliberately not a severity.
  category             TEXT        NOT NULL DEFAULT 'OTHER',

  -- Who is asking. A ticket ALWAYS has a merchant: this is the merchant support
  -- channel, and a ticket with no merchant would be an internal note, which is
  -- what `notes` is for.
  merchant_id          UUID        NOT NULL,

  -- Optional context. A billing question about one parcel is easier to answer
  -- when the parcel is named.
  shipment_id          UUID,

  opened_by_user_id    UUID        NOT NULL,
  assigned_to_user_id  UUID,

  -- Denormalised from the thread so the queue can sort by "waiting longest"
  -- without aggregating messages on every read. Maintained by the application.
  last_message_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  closed_at            TIMESTAMPTZ,
  closed_by_user_id    UUID,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite, per 0036: a foreign key check bypasses RLS, so a single-column
  -- reference would accept another tenant's merchant.
  FOREIGN KEY (tenant_id, merchant_id)         REFERENCES merchants (tenant_id, id),
  FOREIGN KEY (tenant_id, shipment_id)         REFERENCES shipments (tenant_id, id) ON DELETE SET NULL (shipment_id),
  FOREIGN KEY (tenant_id, opened_by_user_id)   REFERENCES users     (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to_user_id) REFERENCES users     (tenant_id, id) ON DELETE SET NULL (assigned_to_user_id),
  FOREIGN KEY (tenant_id, closed_by_user_id)   REFERENCES users     (tenant_id, id),

  CONSTRAINT support_tickets_status_chk
    CHECK (status IN ('OPEN', 'PENDING_MERCHANT', 'RESOLVED', 'CLOSED')),
  CONSTRAINT support_tickets_category_chk
    CHECK (category IN ('BILLING', 'PICKUP', 'DELIVERY', 'ACCOUNT', 'TECHNICAL', 'OTHER')),
  CONSTRAINT support_tickets_subject_chk
    CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  -- Closed is a pair or neither: a closure with no closer records nothing.
  CONSTRAINT support_tickets_closed_chk
    CHECK (num_nonnulls(closed_at, closed_by_user_id) IN (0, 2))
);

CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_reference_uq
  ON support_tickets (tenant_id, reference);

-- The composite-FK target for `support_messages` below. Declared HERE, before
-- the child table: Postgres resolves a foreign key at CREATE TABLE time, so a
-- unique index written after the referencing table fails with "no unique
-- constraint matching given keys".
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_tenant_id_uq
  ON support_tickets (tenant_id, id);

-- The back office's queue: what is OPEN, longest-waiting first. Partial, because
-- a closed ticket is never in it and there will be far more of those.
CREATE INDEX IF NOT EXISTS support_tickets_queue_idx
  ON support_tickets (tenant_id, last_message_at)
  WHERE status IN ('OPEN', 'PENDING_MERCHANT');

-- The merchant's own list, and the per-merchant panel.
CREATE INDEX IF NOT EXISTS support_tickets_merchant_idx
  ON support_tickets (merchant_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS support_tickets_assignee_idx
  ON support_tickets (tenant_id, assigned_to_user_id, last_message_at)
  WHERE assigned_to_user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- The reference counter.
--
-- Same shape as `invoice_sequences` (0032) and for a weaker version of the same
-- reason: a support reference is quoted on the phone, so it must be short and
-- readable, which a UUID is not. A gap here is not a legal problem — nobody
-- audits support tickets — so this could have used a sequence; it does not,
-- because having two mechanisms for "the next human-readable number" in one
-- schema is how one of them eventually gets the locking wrong.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_ticket_sequences (
  tenant_id   UUID    NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (tenant_id, year),
  CONSTRAINT support_ticket_sequences_year_chk CHECK (year BETWEEN 2000 AND 2999)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The thread.
--
-- ⚠️ `visibility` IS THE LOAD-BEARING COLUMN. A back-office team needs to say
-- "this merchant always underpays, do not extend credit" on the ticket without
-- the merchant reading it. INTERNAL messages are invisible to a merchant login —
-- enforced by RLS below, not by a filter some future endpoint might forget.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_messages (
  id                UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id         UUID        NOT NULL,

  body              TEXT        NOT NULL,

  -- PUBLIC — both sides read it. INTERNAL — staff only.
  visibility        TEXT        NOT NULL DEFAULT 'PUBLIC',

  author_user_id    UUID        NOT NULL,
  -- Denormalised so the thread renders "merchant" or "courier" without joining
  -- roles, and so it stays correct after the author's roles change.
  author_side       TEXT        NOT NULL,

  attachment_keys   TEXT[]      NOT NULL DEFAULT '{}',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, ticket_id)      REFERENCES support_tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES users           (tenant_id, id),

  CONSTRAINT support_messages_visibility_chk CHECK (visibility IN ('PUBLIC', 'INTERNAL')),
  CONSTRAINT support_messages_side_chk       CHECK (author_side IN ('MERCHANT', 'COURIER')),
  CONSTRAINT support_messages_body_chk       CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  -- A merchant cannot write an internal note; the concept is meaningless from
  -- their side and the combination would be invisible to its own author.
  CONSTRAINT support_messages_internal_chk
    CHECK (visibility = 'PUBLIC' OR author_side = 'COURIER')
);

CREATE INDEX IF NOT EXISTS support_messages_thread_idx
  ON support_messages (ticket_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- Tickets take the MERCHANT narrowing (I24) — a merchant reads their own
-- tickets and no one else's — but NOT the portfolio narrowing (I25). A
-- commercial is a salesperson, and support is the back office's job; giving them
-- the thread would mean a merchant's billing dispute is readable by whoever
-- sold them the account.
--
-- ⚠️ MESSAGES ADD ONE MORE PREDICATE: a merchant login never sees an INTERNAL
-- message. Enforced here rather than in a query filter, because a filter is one
-- forgotten WHERE clause away from showing a merchant what the back office said
-- about them.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE  ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages FORCE  ROW LEVEL SECURITY;
ALTER TABLE support_ticket_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_sequences FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_tickets_isolation ON support_tickets;
CREATE POLICY support_tickets_isolation ON support_tickets
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
  );

DROP POLICY IF EXISTS support_messages_isolation ON support_messages;
CREATE POLICY support_messages_isolation ON support_messages
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    -- Inherit the ticket's visibility, expressed ONCE so the two cannot drift.
    AND EXISTS (SELECT 1 FROM support_tickets t WHERE t.id = ticket_id)
    -- …and never show a merchant an internal note.
    AND (
      visibility = 'PUBLIC'
      OR COALESCE(current_setting('app.current_merchant_id', true), '') = ''
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM support_tickets t WHERE t.id = ticket_id)
    AND (
      visibility = 'PUBLIC'
      OR COALESCE(current_setting('app.current_merchant_id', true), '') = ''
    )
  );

DROP POLICY IF EXISTS support_ticket_sequences_isolation ON support_ticket_sequences;
CREATE POLICY support_ticket_sequences_isolation ON support_ticket_sequences
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- No DELETE on either: a support thread is the record of what was promised.
GRANT SELECT, INSERT, UPDATE ON support_tickets          TO dp_app;
GRANT SELECT, INSERT         ON support_messages         TO dp_app;
GRANT SELECT, INSERT, UPDATE ON support_ticket_sequences TO dp_app;

COMMENT ON TABLE support_tickets IS
  'Support — the merchant/back-office conversation. A ticket is a QUESTION; a '
  'complaint is a CLAIM. Never merged with complaints.';
COMMENT ON COLUMN support_messages.visibility IS
  'INTERNAL messages are invisible to a merchant login, enforced by RLS rather '
  'than by a query filter that a future endpoint could forget.';
COMMENT ON COLUMN support_tickets.status IS
  'PENDING_MERCHANT exists so a ticket waiting on the person who raised it does '
  'not count as the courier''s backlog.';
