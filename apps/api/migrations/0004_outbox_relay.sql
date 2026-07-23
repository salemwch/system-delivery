-- Outbox relay support (docs/03-event-storming.md §2.3, docs/06-database-design.md §4.8).
--
-- Two concerns, one migration:
--
--   1. Retry backoff. A publish can fail (Valkey unreachable). The relay must not
--      hammer a failing transport, nor let one poison row block the queue head
--      forever. `next_attempt_at` gates when a row becomes claimable again; the
--      relay sets it with capped exponential backoff on failure. Rows are never
--      dropped — a persistently unpublished row is surfaced by the oldest-age
--      alert instead (docs §4.8: "a stalled relay is silent and severe").
--
--   2. The relay identity. The relay is a CONTROL-PLANE process: it must read
--      EVERY tenant's outbox rows, in one global `seq`-ordered scan, so it cannot
--      be bound to a single tenant the way request-path `dp_app` is. It also holds
--      the row lock across the Valkey publish (that is what lets multiple relay
--      instances coordinate via FOR UPDATE SKIP LOCKED), so the cross-tenant read
--      must run inside the relay's own transaction — a self-committing function
--      cannot hold the lock. The minimal, auditable way to grant exactly that and
--      nothing more: a dedicated `dp_relay` role (created in 02-roles.sql — no
--      BYPASSRLS, not the schema owner) with SELECT+UPDATE on THIS table only, and
--      a permissive RLS policy scoped to THIS table only.
--
-- Blast radius of dp_relay if compromised: read and mark-published the outbox.
-- It cannot see or write any other tenant-scoped table, and cannot run DDL.

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN outbox.next_attempt_at IS
  'The relay claims a row only when next_attempt_at <= now(). Set to now() + capped exponential backoff on a publish failure, so a failing transport is retried with restraint and never blocks the queue head permanently.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Relay access. Combined with the existing tenant-scoped `outbox_isolation`
-- policy, PostgreSQL ORs permissive policies per role: dp_app stays restricted to
-- its tenant, while dp_relay resolves (tenant match OR true) = true and sees all
-- tenants. Restricting the policy TO dp_relay is what keeps that reach off every
-- other role.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, UPDATE ON outbox TO dp_relay;

DROP POLICY IF EXISTS outbox_relay_all ON outbox;
CREATE POLICY outbox_relay_all ON outbox
  AS PERMISSIVE
  FOR ALL
  TO dp_relay
  USING (true)
  WITH CHECK (true);
