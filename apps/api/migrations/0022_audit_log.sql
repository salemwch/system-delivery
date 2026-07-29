-- Audit log (docs/01-mvp-scope.md §4.1 #1.6, docs/07-security-architecture.md §10,
-- docs/06-database-design.md §4.9).
--
-- Append-only record of who did what. Not a debug log: it is the evidence
-- trail, and §10 lists what it MUST capture — authentication success and
-- failure, permission and role changes, feature-flag changes, shipment status
-- overrides, every ledger adjustment, remittance confirmations with variance,
-- settlement approvals, PII exports, tenant lifecycle changes, and every
-- Platform Admin action.
--
-- ⚠️ Two properties make this table different from every other one here.
--
-- 1. APPEND-ONLY, enforced twice. `dp_app` receives SELECT and INSERT only —
--    no UPDATE, no DELETE — and a trigger rejects both anyway. The grant is
--    the control; the trigger is what catches a future migration that widens
--    the grant by accident. An audit trail an attacker can edit is worse than
--    none, because it is trusted.
--
-- 2. PARTITIONED MONTHLY FROM DAY ONE (§7). Retention is 7 years and this is
--    the highest-volume business table after telemetry. Retrofitting
--    partitioning to a table that size is a painful migration, and unlike
--    `shipment_events` — where partitioning was deferred to keep unique
--    constraints real — nothing here needs a unique constraint that would
--    have to span partitions.

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id             UUID        NOT NULL DEFAULT uuidv7(),
  tenant_id      UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- WHO. `actor_type` mirrors the shipment ActorType vocabulary plus the
  -- unauthenticated case: a failed login has no user id yet, and that record is
  -- exactly the one a brute-force investigation needs.
  actor_type     TEXT        NOT NULL,
  actor_id       UUID,
  -- Denormalised on purpose. A user can be renamed or deleted; the audit
  -- record must still say who acted, seven years later, without a join to a
  -- row that may no longer exist.
  actor_label    TEXT,

  -- WHAT. `domain.action`, past tense, matching the event vocabulary
  -- (e.g. 'auth.login_failed', 'ledger.adjusted', 'user.role_granted').
  action         TEXT        NOT NULL,
  -- Coarse outcome so "show me everything that was refused" is an index scan
  -- rather than a JSONB search.
  outcome        TEXT        NOT NULL DEFAULT 'SUCCESS',

  -- ON WHAT.
  resource_type  TEXT        NOT NULL,
  resource_id    UUID,

  -- Before/after for the fields that changed, and nothing else (§10).
  -- The CALLER passes the fields it considers significant — this is never a
  -- blanket row dump, which is what keeps unrelated PII out of a table
  -- retained for seven years.
  changes        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Anything that gives the entry meaning but is not a field change: the
  -- variance on a remittance, the reason on a status override.
  context        JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- FROM WHERE.
  ip_address     INET,
  user_agent     TEXT,
  -- Ties an audit entry to the request that caused it and to every event and
  -- span that request produced (docs/09 §7.8).
  correlation_id UUID,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The partition key must be part of every unique constraint, so the primary
  -- key is (id, created_at) rather than id alone. `id` is UUIDv7 and therefore
  -- already time-ordered, so this costs nothing in practice.
  PRIMARY KEY (id, created_at),

  CONSTRAINT audit_log_actor_type_chk
    CHECK (actor_type IN ('USER','DRIVER','SYSTEM','API_CLIENT','ANONYMOUS','PLATFORM_ADMIN')),
  CONSTRAINT audit_log_outcome_chk
    CHECK (outcome IN ('SUCCESS','FAILURE','DENIED'))
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE audit_log IS
  'Append-only audit trail (docs/07-security-architecture.md §10). SELECT+INSERT only; UPDATE and DELETE are revoked AND rejected by trigger. Partitioned monthly, retained 7 years.';
COMMENT ON COLUMN audit_log.changes IS
  'Before/after for significant fields only, passed explicitly by the caller. Never a blanket row dump — secrets are redacted by AuditService before they reach here.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Partition management.
--
-- Idempotent so it is safe to call on every boot. The application calls it at
-- startup rather than relying on pg_cron, which is not guaranteed to be present
-- in every deployment target.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ensure_audit_log_partitions(months_ahead INTEGER DEFAULT 3)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  created INTEGER := 0;
  offset_month INTEGER;
  range_start DATE;
  range_end   DATE;
  part_name   TEXT;
BEGIN
  IF months_ahead < 0 THEN
    RAISE EXCEPTION 'months_ahead must not be negative';
  END IF;

  -- From the current month forward. The current month is always included, so a
  -- deployment that has been down for a while still has somewhere to write.
  FOR offset_month IN 0..months_ahead LOOP
    range_start := date_trunc('month', now())::date + (offset_month || ' months')::interval;
    range_end   := range_start + INTERVAL '1 month';
    part_name   := 'audit_log_' || to_char(range_start, 'YYYYMM');

    IF to_regclass(part_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
        part_name, range_start, range_end
      );

      -- ⚠️ Required, not defensive. `ALTER DEFAULT PRIVILEGES` in
      -- infra/docker/initdb/02-roles.sql grants dp_app full DML on every table
      -- dp_migrator creates — including each partition made here. Privileges
      -- are checked on the table NAMED in a query, so without this a caller
      -- could bypass the parent's restriction with
      -- `DELETE FROM audit_log_202608`. The trigger would still stop them; this
      -- makes sure they never get that far.
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM dp_app', part_name);

      created := created + 1;
    END IF;
  END LOOP;

  RETURN created;
END;
$$;

COMMENT ON FUNCTION ensure_audit_log_partitions(INTEGER) IS
  'Idempotently creates monthly audit_log partitions from the current month forward. Called at application startup.';

-- Twelve months of runway from the first deploy, so the table survives a long
-- gap in maintenance without falling back to the default partition.
SELECT ensure_audit_log_partitions(12);

-- ─────────────────────────────────────────────────────────────────────────────
-- The default partition is a safety net, not a destination.
--
-- Without it, an INSERT with no matching partition FAILS — and because audit
-- writes share the transaction of the action they describe, that failure would
-- roll back the business operation too. A missed partition would become an
-- outage. Rows landing here are a monitoring signal, not data loss.
--
-- Caveat, deliberately accepted: a concrete partition cannot later be attached
-- for a range the default already holds rows for, without moving them first.
-- With twelve months of runway plus a startup job, reaching this is a
-- long-standing operational failure, and the rows are recoverable.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log_default PARTITION OF audit_log DEFAULT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes.
--
-- Declared on the partitioned parent so every existing AND future partition
-- inherits them — a partition created next year must not silently lack the
-- index the investigation query depends on.
-- ─────────────────────────────────────────────────────────────────────────────

-- "What happened to this shipment?" — docs/06 §6.1, the primary access pattern.
CREATE INDEX IF NOT EXISTS audit_log_resource_idx
  ON audit_log (tenant_id, resource_type, resource_id, created_at DESC);

-- "What did this person do?" — the second investigation, and the one that
-- matters after a compromised account.
CREATE INDEX IF NOT EXISTS audit_log_actor_idx
  ON audit_log (tenant_id, actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- "Show me every refusal" — brute force, permission probing. Partial, because
-- refusals are a small fraction of rows and the successful ones are noise here.
CREATE INDEX IF NOT EXISTS audit_log_failures_idx
  ON audit_log (tenant_id, action, created_at DESC)
  WHERE outcome <> 'SUCCESS';

-- Straight chronological browse, the default screen.
CREATE INDEX IF NOT EXISTS audit_log_tenant_time_idx
  ON audit_log (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only enforcement.
--
-- Belt and braces, and both are load-bearing:
--   * the REVOKE is what actually stops `dp_app`;
--   * the trigger is what stops a future migration that widens the grant, and
--     what stops the table OWNER — who is not subject to grants at all.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_log_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- The ONE permitted delete: the tenant itself is gone, and this row is being
  -- removed by the FK cascade. A cascade fires only after the parent row has
  -- already been deleted, so "no tenant" is a reliable signal that this is one.
  --
  -- Not a hole: deleting a `tenants` row requires privileges `dp_app` does not
  -- have, and anyone able to drop a whole tenant is far past the point this
  -- trigger could defend. Same reasoning as the manifest I14 trigger in 0017.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'audit_log is append-only; % is not permitted (docs/07-security-architecture.md §10)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_reject_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- Enabled on the parent; declarative partitioning applies the parent's policies
-- to rows reached through it, and `dp_app` holds privileges on the parent only,
-- so a partition cannot be addressed directly to get around them.
--
-- No merchant narrowing (unlike 0020): a merchant has no `audit:read`
-- permission at all, so there is nothing to narrow.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_isolation ON audit_log;
CREATE POLICY audit_log_isolation ON audit_log
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ⚠️ REVOKE, not a narrower GRANT.
--
-- `ALTER DEFAULT PRIVILEGES` in infra/docker/initdb/02-roles.sql already grants
-- dp_app SELECT, INSERT, UPDATE and DELETE on every table dp_migrator creates.
-- A `GRANT SELECT, INSERT` here would therefore be a NO-OP that reads like a
-- restriction — the append-only property would be a comment, not a control.
-- Same reasoning as `ledger_entries` (0012) and `shipment_events` (0006).
GRANT SELECT, INSERT ON audit_log TO dp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM dp_app;

-- The parent's ACL governs queries that name the parent. A partition is its own
-- table with its own ACL and its own default-privilege grant, so each one is
-- revoked too — otherwise `DELETE FROM audit_log_202607` would be permitted
-- where `DELETE FROM audit_log` is not.
DO $$
DECLARE
  part_name TEXT;
BEGIN
  FOR part_name IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = 'audit_log'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM dp_app', part_name);
  END LOOP;
END
$$;
