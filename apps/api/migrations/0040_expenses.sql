-- Les dépenses — what the courier spends, and where the money came from.
--
-- Fuel, vehicle repairs, hub rent, a driver's phone credit. Every courier tracks
-- these, and today there is nowhere to put them: the ledger knows what the
-- business COLLECTS and what it OWES merchants, and nothing about what it pays
-- out.
--
-- ── The integration that makes this worth building ──────────────────────────
--
-- An expense paid from the hub cash box REDUCES THE CASH THAT BOX HOLDS. That is
-- the same figure `cashInField` reconciles against, so an untracked fuel payment
-- shows up as a hub being short — and the hub manager gets asked where the money
-- went, when the answer is "into the tank of the van outside".
--
-- Recording the expense as a real double-entry transaction against HUB_CASH
-- makes the reconciliation come out right, which is why this posts to the ledger
-- rather than living in a spreadsheet beside it.

-- ─────────────────────────────────────────────────────────────────────────────
-- The chart of expenses.
--
-- Per-tenant, because one courier's categories are not another's, and because
-- an accountant will want them to match whatever their bookkeeper uses.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_categories (
  id           UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Short code an accountant recognises: FUEL, MAINT, RENT, SALARY.
  code         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  name_ar      TEXT,

  -- Soft retirement. A category that stops being used keeps its rows: past
  -- expenses reference it, and deleting one would orphan a year of accounts.
  active       BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT expense_categories_code_chk CHECK (length(btrim(code)) BETWEEN 1 AND 50),
  CONSTRAINT expense_categories_name_chk CHECK (length(btrim(name)) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_code_uq
  ON expense_categories (tenant_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_tenant_id_uq
  ON expense_categories (tenant_id, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- The expense itself.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id                 UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Human-quotable, sequential per tenant per year: DEP-2026-00042.
  reference          TEXT        NOT NULL,

  category_id        UUID        NOT NULL,

  -- Minor units against an explicit currency, like every other amount here.
  -- Strictly positive: a negative expense is a refund, which is its own event
  -- and not an edit to this row.
  amount_minor       BIGINT      NOT NULL,
  currency           TEXT        NOT NULL REFERENCES currencies (code),

  -- When the money was actually spent, which is frequently not when it was
  -- entered. A DATE, not a timestamp: nobody records the minute they bought
  -- diesel, and a timestamp would invite a timezone bug for no gain.
  spent_on           DATE        NOT NULL,

  description        TEXT        NOT NULL,
  -- Object-storage key for the photographed receipt. The key only — the bytes
  -- live in S3, like complaint attachments.
  receipt_key        TEXT,
  -- The supplier's own invoice number, when there is one. What an auditor asks
  -- for, and what stops the same fuel bill being entered twice by two people.
  supplier_reference TEXT,

  -- ── Attribution ───────────────────────────────────────────────────────────
  -- All optional and independent: fuel belongs to a vehicle AND a driver, rent
  -- to a hub alone, and an accountant's fee to none of them.
  driver_id          UUID,
  vehicle_id         UUID,
  hub_id             UUID,

  -- ── Where the money came from ─────────────────────────────────────────────
  -- HUB_CASH: out of a hub's cash box, which reduces the cash that hub holds
  -- and therefore what `cashInField` expects to find.
  -- BANK: a transfer, which touches no cash box.
  paid_from          TEXT        NOT NULL,
  -- Required when paid_from = 'HUB_CASH': the box the money left.
  paid_from_hub_id   UUID,

  -- DRAFT | APPROVED | REJECTED. Only APPROVED posts to the ledger.
  status             TEXT        NOT NULL DEFAULT 'DRAFT',

  -- The ledger transaction this produced, set on approval. Its presence is what
  -- makes double-posting impossible: the service refuses to approve a row that
  -- already has one.
  transaction_id     UUID,

  recorded_by_user_id UUID       NOT NULL,
  approved_by_user_id UUID,
  approved_at        TIMESTAMPTZ,
  decision_reason    TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite, per 0036: an FK check bypasses RLS.
  FOREIGN KEY (tenant_id, category_id)         REFERENCES expense_categories (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id)           REFERENCES drivers  (tenant_id, id) ON DELETE SET NULL (driver_id),
  FOREIGN KEY (tenant_id, vehicle_id)          REFERENCES vehicles (tenant_id, id) ON DELETE SET NULL (vehicle_id),
  FOREIGN KEY (tenant_id, hub_id)              REFERENCES hubs     (tenant_id, id) ON DELETE SET NULL (hub_id),
  FOREIGN KEY (tenant_id, paid_from_hub_id)    REFERENCES hubs     (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by_user_id) REFERENCES users    (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by_user_id) REFERENCES users    (tenant_id, id),

  CONSTRAINT expenses_amount_chk    CHECK (amount_minor > 0),
  CONSTRAINT expenses_status_chk    CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED')),
  CONSTRAINT expenses_paid_from_chk CHECK (paid_from IN ('HUB_CASH', 'BANK')),
  CONSTRAINT expenses_desc_chk      CHECK (length(btrim(description)) BETWEEN 1 AND 500),

  -- Cash leaves a specific box, or it is not cash.
  CONSTRAINT expenses_cash_source_chk CHECK (
    (paid_from = 'HUB_CASH' AND paid_from_hub_id IS NOT NULL)
    OR (paid_from = 'BANK'  AND paid_from_hub_id IS NULL)
  ),

  -- The three shapes a row may take. An APPROVED expense with no ledger
  -- transaction would be money spent that the accounts never saw.
  CONSTRAINT expenses_decision_chk CHECK (
    (status = 'DRAFT'
       AND transaction_id IS NULL AND approved_by_user_id IS NULL
       AND approved_at IS NULL)
    OR (status = 'APPROVED'
       AND transaction_id IS NOT NULL AND approved_by_user_id IS NOT NULL
       AND approved_at IS NOT NULL)
    OR (status = 'REJECTED'
       AND transaction_id IS NULL AND approved_by_user_id IS NOT NULL
       AND approved_at IS NOT NULL AND decision_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS expenses_reference_uq
  ON expenses (tenant_id, reference);

-- ⚠️ THE SAME SUPPLIER INVOICE, ENTERED TWICE, IS THE COMMONEST ERROR IN EXPENSE
-- BOOKKEEPING — two people both enter the fuel bill and the month is overstated.
-- Partial, so a rejected duplicate does not block a corrected re-entry, and only
-- when a supplier reference exists (a market purchase has none).
CREATE UNIQUE INDEX IF NOT EXISTS expenses_supplier_reference_uq
  ON expenses (tenant_id, supplier_reference)
  WHERE supplier_reference IS NOT NULL AND status <> 'REJECTED';

-- The approval queue: what is waiting, oldest first.
CREATE INDEX IF NOT EXISTS expenses_pending_idx
  ON expenses (tenant_id, created_at)
  WHERE status = 'DRAFT';

-- The report: this tenant's approved spend over a period, by category.
CREATE INDEX IF NOT EXISTS expenses_reporting_idx
  ON expenses (tenant_id, spent_on DESC, category_id)
  WHERE status = 'APPROVED';

CREATE INDEX IF NOT EXISTS expenses_vehicle_idx
  ON expenses (vehicle_id, spent_on DESC) WHERE vehicle_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_hub_idx
  ON expenses (hub_id, spent_on DESC) WHERE hub_id IS NOT NULL;

-- The reference counter, same shape as invoices and support tickets.
CREATE TABLE IF NOT EXISTS expense_sequences (
  tenant_id   UUID    NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (tenant_id, year),
  CONSTRAINT expense_sequences_year_chk CHECK (year BETWEEN 2000 AND 2999)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- The ledger needs somewhere to put the debit.
--
-- Double-entry: an approved expense DEBITS an EXPENSE account (spending rises)
-- and CREDITS the source of the funds — HUB_CASH (the box holds less) or BANK.
-- Both sides already exist except the expense account itself.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_type_chk;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_type_chk CHECK (account_type IN (
  'DRIVER_CASH', 'HUB_CASH', 'MERCHANT_PAYABLE',
  'PLATFORM_REVENUE', 'BANK', 'WRITE_OFF', 'CUSTOMER_RECEIVABLE',
  -- New. Owner is the TENANT: expenses are not owned by a driver or a hub even
  -- when attributed to one, because the attribution is a reporting dimension
  -- and not a balance anybody holds.
  'EXPENSE'
));

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_type_chk;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_chk CHECK (entry_type IN (
  'COD_COLLECTED', 'COD_REMITTED', 'SETTLEMENT', 'ADJUSTMENT', 'WRITE_OFF', 'REVERSAL',
  'EXPENSE'
));

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- Plain tenant isolation, no sub-tenant narrowing — and note what that means: a
-- MERCHANT holds no expense permission at all, so they never reach these rows.
-- What the courier spends is nobody else's business.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_categories FORCE  ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE  ROW LEVEL SECURITY;
ALTER TABLE expense_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_sequences FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_categories_isolation ON expense_categories;
CREATE POLICY expense_categories_isolation ON expense_categories
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS expenses_isolation ON expenses;
CREATE POLICY expenses_isolation ON expenses
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS expense_sequences_isolation ON expense_sequences;
CREATE POLICY expense_sequences_isolation ON expense_sequences
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- No DELETE on expenses: an approved one has posted to the ledger, and the
-- ledger is append-only. A mistake is corrected by a reversing adjustment.
GRANT SELECT, INSERT, UPDATE ON expense_categories TO dp_app;
GRANT SELECT, INSERT, UPDATE ON expenses           TO dp_app;
GRANT SELECT, INSERT, UPDATE ON expense_sequences  TO dp_app;

COMMENT ON TABLE expenses IS
  'Les dépenses. An APPROVED expense posts a real double-entry transaction — '
  'DEBIT EXPENSE, CREDIT the source — so cash paid from a hub box reduces what '
  'cashInField expects that hub to hold.';
COMMENT ON INDEX expenses_supplier_reference_uq IS
  'The same supplier invoice entered twice is the commonest expense-keeping '
  'error. Excludes REJECTED so a corrected re-entry is possible.';
