-- Nouveaux clients — the queue of shippers asking to be taken on.
--
-- ── Why this is NOT a status on `merchants` ─────────────────────────────────
--
-- The obvious design adds PENDING_APPROVAL to `merchants.status`. It is wrong
-- for three reasons, and each one costs real work later:
--
--   1. A merchant is a party the courier has a relationship with. An applicant
--      is a stranger who filled in a form. Giving them the same table means
--      every merchant query in the codebase — the picker, the settlement run,
--      the invoice draft, the address book — must remember to exclude a status
--      that did not exist when it was written. One that forgets bills a
--      stranger.
--   2. `merchants` is referenced by shipments, invoices, users and settlements.
--      A rejected applicant would leave a permanent row in the table those
--      point at, and `merchants_tenant_code_uq` would burn a code on someone
--      who was turned away.
--   3. The application carries fields a merchant does not have — why they are
--      applying, expected volume, who rejected them and why — which would sit
--      NULL on every real merchant forever.
--
-- So: an application is its own entity, and APPROVING one CREATES a merchant.
-- The two are linked by `merchant_id`, which is how the queue shows what
-- happened without either table pretending to be the other.

CREATE TABLE IF NOT EXISTS merchant_applications (
  id                   UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- ── What the applicant told us ────────────────────────────────────────────
  business_name        TEXT        NOT NULL,
  contact_name         TEXT        NOT NULL,
  -- E.164, normalised before it arrives. The identity of an applicant in
  -- Tunisia is their phone number; email is frequently absent.
  contact_phone        TEXT        NOT NULL,
  contact_email        TEXT,
  city                 TEXT,
  address_line         TEXT,
  -- Parcels per month, as claimed. The first question a courier asks, and the
  -- one that decides whether a commercial visits. Unverified by definition.
  expected_volume      INTEGER,
  message              TEXT,

  -- PUBLIC_FORM — they applied themselves. STAFF — a commercial logged a lead
  -- they met. The distinction matters: a lead a salesperson vouches for is not
  -- the same risk as an anonymous form submission.
  source               TEXT        NOT NULL DEFAULT 'PUBLIC_FORM',

  -- ── The decision ──────────────────────────────────────────────────────────
  status               TEXT        NOT NULL DEFAULT 'PENDING',
  -- The merchant this became. Set only on approval, and never cleared: it is
  -- the record of what the decision produced.
  merchant_id          UUID,
  decided_at           TIMESTAMPTZ,
  decided_by_user_id   UUID,
  -- Required on rejection. "We said no" without a reason is not a decision
  -- anyone can review, and a rejected applicant who phones back deserves an
  -- answer better than a shrug.
  decision_reason      TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite, like every tenant-scoped key since 0036: a foreign key check
  -- bypasses RLS, so a single-column reference would accept another tenant's
  -- merchant as the outcome of this tenant's decision.
  FOREIGN KEY (tenant_id, merchant_id)        REFERENCES merchants (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by_user_id) REFERENCES users     (tenant_id, id),

  CONSTRAINT merchant_applications_status_chk
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT merchant_applications_source_chk
    CHECK (source IN ('PUBLIC_FORM', 'STAFF')),
  CONSTRAINT merchant_applications_volume_chk
    CHECK (expected_volume IS NULL OR expected_volume BETWEEN 0 AND 1000000),

  -- The three shapes a row may take, spelled out. Without this a row can claim
  -- to be APPROVED with no merchant, or PENDING with a decision date — states
  -- the UI would render as something that never happened.
  CONSTRAINT merchant_applications_decision_chk CHECK (
    (status = 'PENDING'
       AND merchant_id IS NULL AND decided_at IS NULL
       AND decided_by_user_id IS NULL AND decision_reason IS NULL)
    OR (status = 'APPROVED'
       AND merchant_id IS NOT NULL AND decided_at IS NOT NULL
       AND decided_by_user_id IS NOT NULL)
    OR (status = 'REJECTED'
       AND merchant_id IS NULL AND decided_at IS NOT NULL
       AND decided_by_user_id IS NOT NULL AND decision_reason IS NOT NULL)
  )
);

-- ⚠️ ABUSE CONTROL, and the reason the public endpoint can exist at all.
--
-- One PENDING application per phone per tenant. A repeated submission from the
-- same number hits this and is reported to the applicant as success — the
-- endpoint is unauthenticated, so it must never confirm that a number is
-- already known.
--
-- Partial, so an applicant rejected in January can apply again in June.
CREATE UNIQUE INDEX IF NOT EXISTS merchant_applications_pending_phone_uq
  ON merchant_applications (tenant_id, contact_phone)
  WHERE status = 'PENDING';

-- The queue: this tenant's PENDING applications, oldest first, because the
-- oldest is the one that has been waiting longest.
CREATE INDEX IF NOT EXISTS merchant_applications_queue_idx
  ON merchant_applications (tenant_id, created_at)
  WHERE status = 'PENDING';

-- The history tab, and the per-tenant hourly cap the intake enforces.
CREATE INDEX IF NOT EXISTS merchant_applications_tenant_created_idx
  ON merchant_applications (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- Tenant isolation only, and NO portfolio narrowing — deliberately. An
-- application is a LEAD, and a lead belongs to the sales team until someone
-- takes it. A commercial who approves one becomes its account manager (the
-- merchant is created under their ambient context), and from that moment the
-- merchant it produced is narrowed by I25 like any other. Narrowing the queue
-- itself would mean nobody could see a lead nobody owns yet.
--
-- The INSERT policy is what makes the public endpoint safe: a row may only be
-- written into the tenant the request resolved to.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE merchant_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_applications FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_applications_isolation ON merchant_applications;
CREATE POLICY merchant_applications_isolation ON merchant_applications
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- No DELETE. A rejection is a record, not an absence — and an applicant who
-- disputes the decision needs it to still be there.
GRANT SELECT, INSERT, UPDATE ON merchant_applications TO dp_app;

COMMENT ON TABLE merchant_applications IS
  'Nouveaux clients — shippers asking to be taken on. Approving one CREATES a '
  'merchant; the application is never a merchant itself.';
COMMENT ON INDEX merchant_applications_pending_phone_uq IS
  'One pending application per phone per tenant. The unauthenticated intake '
  'relies on this, and reports a duplicate as success so it cannot be used to '
  'test whether a number is known.';
