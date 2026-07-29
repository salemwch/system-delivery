-- Complaints / réclamations (docs/01-mvp-scope.md §4.2 #2.13,
-- docs/02-domain-model.md §3.20).
--
-- The record of something going wrong and what was done about it. Not a support
-- inbox: in a COD market a complaint is frequently a claim on money, and
-- `type = COD_DISPUTE` is the mechanism that answers hotspot H8 — what happens
-- to collected cash when a delivery is later disputed. The answer is a
-- REVERSING ledger transaction, never an edit to the original.

-- ─────────────────────────────────────────────────────────────────────────────
-- complaints
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaints (
  id                 UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Human-quotable reference. What a merchant reads down the phone.
  code               TEXT        NOT NULL,

  type               TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'OPEN',
  severity           TEXT        NOT NULL DEFAULT 'MEDIUM',

  -- Subject context. All optional: a complaint about driver conduct may name no
  -- shipment, and one raised before a parcel exists may name only a merchant.
  shipment_id        UUID        REFERENCES shipments (id) ON DELETE SET NULL,
  merchant_id        UUID        REFERENCES merchants (id) ON DELETE SET NULL,
  recipient_id       UUID        REFERENCES recipients (id) ON DELETE SET NULL,
  driver_id          UUID        REFERENCES drivers (id) ON DELETE SET NULL,

  -- Who complained. `raised_by_id` is null for a RECIPIENT, who has no account.
  raised_by_type     TEXT        NOT NULL,
  raised_by_id       UUID,

  description        TEXT        NOT NULL,
  -- Object-storage keys (photos of damage). Keys only — the bytes live in S3.
  attachment_keys    TEXT[]      NOT NULL DEFAULT '{}',

  assigned_to_user_id UUID,

  -- Computed from tenant config per type (rule 6). Breaches surface on the
  -- dashboard, which is why this is a column and not a derived value.
  sla_due_at         TIMESTAMPTZ,

  resolution         TEXT,
  resolved_at        TIMESTAMPTZ,
  resolved_by_user_id UUID,

  -- Set when a COD_DISPUTE resolution posts a reversal, so the same dispute
  -- cannot reverse the money twice.
  reversal_transaction_id UUID,

  -- Client-supplied, unique per tenant. The driver app and the merchant portal
  -- both retry, and a duplicated complaint splits one dispute into two
  -- half-investigations. Same mechanism as `shipment_events` (0006).
  idempotency_key    TEXT        NOT NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT complaints_type_chk CHECK (
    type IN ('DAMAGED','LOST','LATE','WRONG_ITEM','DRIVER_CONDUCT','COD_DISPUTE','OTHER')
  ),
  CONSTRAINT complaints_status_chk CHECK (
    status IN ('OPEN','INVESTIGATING','RESOLVED','REJECTED','ESCALATED')
  ),
  CONSTRAINT complaints_severity_chk CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  CONSTRAINT complaints_raised_by_chk CHECK (
    raised_by_type IN ('MERCHANT','RECIPIENT','STAFF')
  ),

  -- ⚠️ Rule 2, enforced by the DATABASE rather than by service code.
  --
  -- A complaint cannot reach RESOLVED or REJECTED without a non-empty
  -- resolution. A closed complaint with no recorded outcome is not a record of
  -- anything — it is the absence of one, and six months later nobody can say
  -- what was decided or why. This is the kind of rule that erodes the moment it
  -- lives only in a service method.
  CONSTRAINT complaints_resolution_chk CHECK (
    status NOT IN ('RESOLVED','REJECTED')
    OR (resolution IS NOT NULL AND length(btrim(resolution)) > 0)
  ),
  CONSTRAINT complaints_resolved_at_chk CHECK (
    (status IN ('RESOLVED','REJECTED')) = (resolved_at IS NOT NULL)
  )
);

COMMENT ON TABLE complaints IS
  'Operational complaint and claim tracking (docs/02-domain-model.md §3.20). Never deleted — status is the lifecycle. COD_DISPUTE resolution posts a reversing ledger transaction (hotspot H8).';
COMMENT ON COLUMN complaints.reversal_transaction_id IS
  'The reversing ledger transaction posted on COD_DISPUTE resolution. Non-null means the money has already been reversed; it is what stops a second reversal.';

CREATE UNIQUE INDEX IF NOT EXISTS complaints_tenant_code_uq
  ON complaints (tenant_id, code);

-- The idempotency guarantee. A UNIQUE index rather than a pre-flight SELECT,
-- which has a TOCTOU gap: two concurrent retries can both find nothing.
CREATE UNIQUE INDEX IF NOT EXISTS complaints_tenant_idempotency_uq
  ON complaints (tenant_id, idempotency_key);

-- The queue view: "what is open, worst first". Partial — resolved complaints
-- are history and are read by id or by report, never scanned by this path.
CREATE INDEX IF NOT EXISTS complaints_open_idx
  ON complaints (tenant_id, severity, created_at DESC)
  WHERE status NOT IN ('RESOLVED','REJECTED');

-- "What went wrong with this parcel?" — reached from the shipment detail screen.
CREATE INDEX IF NOT EXISTS complaints_shipment_idx
  ON complaints (tenant_id, shipment_id)
  WHERE shipment_id IS NOT NULL;

-- The merchant portal's own list, narrowed by RLS below.
CREATE INDEX IF NOT EXISTS complaints_merchant_idx
  ON complaints (tenant_id, merchant_id, created_at DESC)
  WHERE merchant_id IS NOT NULL;

-- SLA breach sweep: "open and overdue".
CREATE INDEX IF NOT EXISTS complaints_sla_idx
  ON complaints (tenant_id, sla_due_at)
  WHERE sla_due_at IS NOT NULL AND status NOT IN ('RESOLVED','REJECTED');

CREATE INDEX IF NOT EXISTS complaints_assignee_idx
  ON complaints (tenant_id, assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- complaint_activity — the append-only trail (rule 5).
--
-- Status changes and comments are ENTRIES, never overwrites. A complaint whose
-- history can be rewritten is worth nothing in a dispute, which is precisely
-- when it is read.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaint_activity (
  id            UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  complaint_id  UUID        NOT NULL REFERENCES complaints (id) ON DELETE CASCADE,

  -- STATUS_CHANGED | COMMENT | ASSIGNED | ATTACHMENT_ADDED | REVERSAL_POSTED
  kind          TEXT        NOT NULL,
  -- Present on STATUS_CHANGED, so the trail reconstructs the lifecycle.
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT,

  actor_type    TEXT        NOT NULL DEFAULT 'STAFF',
  actor_id      UUID,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT complaint_activity_kind_chk CHECK (
    kind IN ('STATUS_CHANGED','COMMENT','ASSIGNED','ATTACHMENT_ADDED','REVERSAL_POSTED')
  ),
  -- A status entry that names no transition explains nothing.
  CONSTRAINT complaint_activity_status_chk CHECK (
    kind <> 'STATUS_CHANGED' OR to_status IS NOT NULL
  )
);

COMMENT ON TABLE complaint_activity IS
  'Append-only activity trail (domain §3.20 rule 5). UPDATE and DELETE are revoked from dp_app — the history of a dispute must not be rewritable.';

CREATE INDEX IF NOT EXISTS complaint_activity_complaint_idx
  ON complaint_activity (complaint_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- `complaints` carries `merchant_id`, so it takes the SAME merchant narrowing as
-- shipments (invariant I24, migration 0020) — a merchant sees their own
-- complaints and never a rival's.
--
-- ⚠️ `current_merchant_allows` fails closed on a NULL merchant_id, which is
-- correct here: a complaint with no merchant belongs to the courier's own
-- operations (driver conduct, an internal claim) and is none of a merchant's
-- business.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS complaints_isolation ON complaints;
CREATE POLICY complaints_isolation ON complaints
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
  );

ALTER TABLE complaint_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_activity FORCE  ROW LEVEL SECURITY;

-- The activity trail has no merchant_id of its own; it inherits the parent's
-- visibility. Written as EXISTS against `complaints`, which is itself narrowed,
-- so the narrowing is expressed once rather than duplicated (and cannot drift).
DROP POLICY IF EXISTS complaint_activity_isolation ON complaint_activity;
CREATE POLICY complaint_activity_isolation ON complaint_activity
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM complaints c WHERE c.id = complaint_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM complaints c WHERE c.id = complaint_id)
  );

-- ⚠️ REVOKE, not a narrower GRANT (see 0022 and initdb/02-roles.sql).
--
-- `complaints`: never deleted (rule 7) — status is the lifecycle.
-- `complaint_activity`: append-only (rule 5) — no UPDATE either.
GRANT SELECT, INSERT, UPDATE ON complaints TO dp_app;
REVOKE DELETE, TRUNCATE ON complaints FROM dp_app;

GRANT SELECT, INSERT ON complaint_activity TO dp_app;
REVOKE UPDATE, DELETE, TRUNCATE ON complaint_activity FROM dp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-tenant complaint SLA hours, feeding `sla_due_at` (rule 6).
--
-- Config as DATA, never code (docs/01 §4.1 #1.8). A tenant that promises a
-- 4-hour response on a damaged parcel and 48 hours on a late one must be able to
-- say so without a deploy.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaint_sla_policies (
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  type        TEXT        NOT NULL,
  -- Hours from creation to the promised resolution.
  due_hours   INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, type),
  CONSTRAINT complaint_sla_type_chk CHECK (
    type IN ('DAMAGED','LOST','LATE','WRONG_ITEM','DRIVER_CONDUCT','COD_DISPUTE','OTHER')
  ),
  CONSTRAINT complaint_sla_hours_chk CHECK (due_hours > 0 AND due_hours <= 8760)
);

ALTER TABLE complaint_sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_sla_policies FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS complaint_sla_policies_isolation ON complaint_sla_policies;
CREATE POLICY complaint_sla_policies_isolation ON complaint_sla_policies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON complaint_sla_policies TO dp_app;
REVOKE TRUNCATE ON complaint_sla_policies FROM dp_app;
