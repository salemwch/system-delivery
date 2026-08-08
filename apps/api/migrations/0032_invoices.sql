-- Invoices and credit notes — factures et avoirs (docs/01-mvp-scope.md §7).
--
-- A courier in Tunisia bills its merchants for delivery services, and that
-- invoice is a TAX DOCUMENT, not a report. Three properties follow from that,
-- and every design choice below serves one of them:
--
--   1. THE NUMBER SEQUENCE IS GAPLESS. A tax authority reads a missing number
--      as a destroyed invoice. This is the single hardest requirement here and
--      the reason for `invoice_sequences` below.
--   2. AN ISSUED INVOICE IS IMMUTABLE. Not "we agree not to edit it" — the
--      database refuses. A correction is a separate CREDIT NOTE that references
--      the original.
--   3. THE TOTALS ARE ARITHMETIC, NOT OPINION. Line totals, subtotal, tax and
--      grand total are checked by the database, so a rounding bug cannot
--      silently produce an invoice that does not add up.

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-tenant billing configuration.
--
-- Rates live in DATA, not code. Tunisia's standard TVA is 19% today; it has
-- moved before and will again, and a tenant selling exempt services needs a
-- different rate entirely. A hardcoded 19 would mean a migration on every
-- change and no way to bill two tenants differently.
--
-- Stored as BASIS POINTS (1900 = 19.00%) so the rate itself is an integer.
-- A NUMERIC rate invites floating-point rounding into a tax calculation, which
-- is the one place it must never appear.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_settings (
  tenant_id            UUID PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,

  -- 1900 = 19.00%. Range allows 0 (exempt) to 100% and nothing absurd.
  vat_rate_bp          INTEGER     NOT NULL DEFAULT 1900,

  -- Timbre fiscal — the Tunisian stamp duty charged once per invoice, not per
  -- line and not proportional to the amount. 1000 = 1.000 TND at 3 decimals.
  -- Zero disables it for a tenant that does not charge it.
  stamp_duty_minor     BIGINT      NOT NULL DEFAULT 1000,

  -- What appears on the invoice as the issuer. NULL falls back to the tenant's
  -- own name; the fiscal id has no fallback because inventing one is worse than
  -- printing nothing.
  legal_name           TEXT,
  tax_identifier       TEXT,
  legal_address        TEXT,

  -- Net payment terms. 0 means due on issue.
  payment_terms_days   INTEGER     NOT NULL DEFAULT 30,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_vat_rate_chk    CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  CONSTRAINT billing_stamp_duty_chk  CHECK (stamp_duty_minor >= 0),
  CONSTRAINT billing_terms_chk       CHECK (payment_terms_days BETWEEN 0 AND 365)
);

COMMENT ON COLUMN billing_settings.vat_rate_bp IS
  'TVA in basis points (1900 = 19.00%). An integer, because a NUMERIC rate lets '
  'floating-point rounding into a tax calculation.';
COMMENT ON COLUMN billing_settings.stamp_duty_minor IS
  'Timbre fiscal in minor units — charged once per invoice, flat, not per line.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The number sequence.
--
-- ⚠️ WHY NOT A POSTGRES SEQUENCE. `nextval()` is non-transactional by design:
-- it does not roll back. An invoice insert that fails after taking a number
-- leaves that number permanently unused, and a gap in a tax sequence is exactly
-- what must never happen. Sequences are right for surrogate keys and wrong for
-- this.
--
-- A counter row with `SELECT … FOR UPDATE` serialises issuance instead. Two
-- concurrent issues queue rather than race, and a rollback returns the number.
-- The cost is that invoice issuance for one tenant-year is single-file — which
-- is correct: they must be, or the order is not defined.
--
-- Keyed by KIND as well as year: invoices and credit notes are separate legal
-- series and share no numbers.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_sequences (
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL,
  year        INTEGER     NOT NULL,
  last_number INTEGER     NOT NULL DEFAULT 0,

  PRIMARY KEY (tenant_id, kind, year),

  CONSTRAINT invoice_sequences_kind_chk CHECK (kind IN ('INVOICE', 'CREDIT_NOTE')),
  CONSTRAINT invoice_sequences_year_chk CHECK (year BETWEEN 2000 AND 2999),
  CONSTRAINT invoice_sequences_last_chk CHECK (last_number >= 0)
);

COMMENT ON TABLE invoice_sequences IS
  'Gapless per-tenant, per-kind, per-year counters. A row lock rather than a '
  'Postgres sequence: nextval() does not roll back, and a gap in a tax number '
  'series reads as a destroyed invoice.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices.
--
-- DRAFT is a working document: editable, no number, no legal weight. ISSUED is
-- the tax document: numbered, frozen, and from then on correctable only by a
-- credit note. There is no DELETE — a mistaken invoice is CANCELLED (only while
-- still a draft) or credited.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  merchant_id          UUID        NOT NULL REFERENCES merchants (id),

  kind                 TEXT        NOT NULL DEFAULT 'INVOICE',

  -- NULL until issued. That is the whole point: a draft holds no number, so a
  -- draft that is abandoned consumes nothing.
  number               TEXT,
  -- The year the number belongs to, kept so the uniqueness index and the
  -- sequence agree even if an invoice is issued just after midnight on 1 Jan.
  number_year          INTEGER,

  status               TEXT        NOT NULL DEFAULT 'DRAFT',

  -- The period being billed. Two invoices for the same merchant and period are
  -- allowed (a supplementary invoice is a real thing) — the constraint is on
  -- the NUMBER, not the period.
  period_from          DATE        NOT NULL,
  period_to            DATE        NOT NULL,

  issued_at            TIMESTAMPTZ,
  due_at               TIMESTAMPTZ,

  currency             TEXT        NOT NULL REFERENCES currencies (code),

  -- Every amount in minor units. TND has THREE decimals; a NUMERIC here would
  -- reintroduce the rounding this codebase avoids everywhere else.
  subtotal_minor       BIGINT      NOT NULL DEFAULT 0,
  vat_rate_bp          INTEGER     NOT NULL,
  vat_amount_minor     BIGINT      NOT NULL DEFAULT 0,
  stamp_duty_minor     BIGINT      NOT NULL DEFAULT 0,
  total_minor          BIGINT      NOT NULL DEFAULT 0,

  -- Snapshot of the issuer AND the customer at issue time. An invoice must
  -- still print correctly in five years when the merchant has moved and the
  -- courier has renamed itself; joining live rows would silently rewrite
  -- history.
  seller_name          TEXT,
  seller_tax_id        TEXT,
  seller_address       TEXT,
  buyer_name           TEXT,
  buyer_tax_id         TEXT,
  buyer_address        TEXT,

  -- Set on a credit note: the invoice it corrects.
  corrects_invoice_id  UUID REFERENCES invoices (id),
  notes                TEXT,

  created_by_user_id   UUID        NOT NULL,
  issued_by_user_id    UUID,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT invoices_kind_chk   CHECK (kind IN ('INVOICE', 'CREDIT_NOTE')),
  CONSTRAINT invoices_status_chk CHECK (status IN ('DRAFT', 'ISSUED', 'PAID', 'CANCELLED')),
  CONSTRAINT invoices_period_chk CHECK (period_to >= period_from),
  CONSTRAINT invoices_vat_rate_chk CHECK (vat_rate_bp BETWEEN 0 AND 10000),

  -- Amounts are non-negative on both kinds. A credit note is a NEGATIVE
  -- document by meaning, not by sign — storing it as a positive amount of the
  -- opposite kind keeps every total readable and every sum explicit about
  -- direction.
  CONSTRAINT invoices_amounts_chk CHECK (
    subtotal_minor >= 0 AND vat_amount_minor >= 0
    AND stamp_duty_minor >= 0 AND total_minor >= 0
  ),

  -- The arithmetic, enforced. A rounding bug cannot produce an invoice whose
  -- parts do not sum to its total.
  CONSTRAINT invoices_total_chk CHECK (
    total_minor = subtotal_minor + vat_amount_minor + stamp_duty_minor
  ),

  -- A number exists if and only if the document has been issued.
  CONSTRAINT invoices_number_chk CHECK (
    (status = 'DRAFT'     AND number IS NULL     AND number_year IS NULL) OR
    (status = 'CANCELLED' AND number IS NULL     AND number_year IS NULL) OR
    (status IN ('ISSUED', 'PAID') AND number IS NOT NULL AND number_year IS NOT NULL
     AND issued_at IS NOT NULL)
  ),

  -- Only a credit note corrects something, and it must say what.
  CONSTRAINT invoices_correction_chk CHECK (
    (kind = 'CREDIT_NOTE' AND corrects_invoice_id IS NOT NULL) OR
    (kind = 'INVOICE'     AND corrects_invoice_id IS NULL)
  )
);

-- The uniqueness that makes the series legally meaningful. Partial, because
-- drafts share a NULL number and NULLs do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_number_uq
  ON invoices (tenant_id, kind, number)
  WHERE number IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_tenant_merchant_idx
  ON invoices (tenant_id, merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_tenant_status_idx
  ON invoices (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_corrects_idx
  ON invoices (corrects_invoice_id)
  WHERE corrects_invoice_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Lines.
--
-- Free-text description plus quantity and unit price, rather than a foreign key
-- to shipments. An invoice line is usually an aggregate — "1 240 parcels
-- delivered, Aug 2026" — and the ones that are not are adjustments and fees
-- with no shipment behind them at all.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_lines (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id        UUID        NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,

  position          INTEGER     NOT NULL,
  description       TEXT        NOT NULL,
  quantity          INTEGER     NOT NULL DEFAULT 1,
  unit_price_minor  BIGINT      NOT NULL,
  line_total_minor  BIGINT      NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT invoice_lines_qty_chk   CHECK (quantity > 0),
  CONSTRAINT invoice_lines_price_chk CHECK (unit_price_minor >= 0),
  -- The line arithmetic, enforced for the same reason as the invoice total.
  CONSTRAINT invoice_lines_total_chk CHECK (line_total_minor = quantity * unit_price_minor)
);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_lines_position_uq
  ON invoice_lines (invoice_id, position);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON invoice_lines (invoice_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- IMMUTABILITY.
--
-- Once issued, an invoice may only move ISSUED → PAID or ISSUED → CANCELLED —
-- and even a cancellation keeps the number, because the number was already
-- reported. Nothing else about it can change, and its lines cannot change at
-- all.
--
-- SECURITY DEFINER for the same reason as the I23 triggers: an integrity check
-- must see the truth regardless of the caller's row-security context.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoices_enforce_immutability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;  -- A draft is a working document.
  END IF;

  -- The only permitted transitions after issue.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'ISSUED' AND NEW.status IN ('PAID', 'CANCELLED')) THEN
    RAISE EXCEPTION
      'invoice % is % and cannot become %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Everything that defines the document as a tax record.
  IF NEW.number          IS DISTINCT FROM OLD.number
     OR NEW.number_year  IS DISTINCT FROM OLD.number_year
     OR NEW.kind         IS DISTINCT FROM OLD.kind
     OR NEW.merchant_id  IS DISTINCT FROM OLD.merchant_id
     OR NEW.currency     IS DISTINCT FROM OLD.currency
     OR NEW.issued_at    IS DISTINCT FROM OLD.issued_at
     OR NEW.subtotal_minor    IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.vat_rate_bp       IS DISTINCT FROM OLD.vat_rate_bp
     OR NEW.vat_amount_minor  IS DISTINCT FROM OLD.vat_amount_minor
     OR NEW.stamp_duty_minor  IS DISTINCT FROM OLD.stamp_duty_minor
     OR NEW.total_minor       IS DISTINCT FROM OLD.total_minor
     OR NEW.seller_name  IS DISTINCT FROM OLD.seller_name
     OR NEW.seller_tax_id IS DISTINCT FROM OLD.seller_tax_id
     OR NEW.buyer_name   IS DISTINCT FROM OLD.buyer_name
     OR NEW.buyer_tax_id IS DISTINCT FROM OLD.buyer_tax_id
     OR NEW.period_from  IS DISTINCT FROM OLD.period_from
     OR NEW.period_to    IS DISTINCT FROM OLD.period_to THEN
    RAISE EXCEPTION
      'invoice % has been issued and is immutable; correct it with a credit note', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_immutable ON invoices;
CREATE TRIGGER invoices_immutable
  BEFORE UPDATE ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION invoices_enforce_immutability();

-- Lines of an issued invoice are frozen entirely — there is no legitimate edit.
CREATE OR REPLACE FUNCTION invoice_lines_enforce_immutability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  parent_status TEXT;
BEGIN
  SELECT status INTO parent_status
    FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- The parent may already be gone in a cascade; nothing to protect then.
  IF NOT FOUND OR parent_status = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'invoice % is % — its lines cannot be changed',
    COALESCE(NEW.invoice_id, OLD.invoice_id), parent_status
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS invoice_lines_immutable ON invoice_lines;
CREATE TRIGGER invoice_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW
  EXECUTE FUNCTION invoice_lines_enforce_immutability();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- `invoices` carries `merchant_id`, so it takes BOTH sub-tenant narrowings: a
-- merchant sees their own invoices (I24) and a commercial sees their portfolio's
-- (I25). A merchant reading a rival's invoice would disclose that rival's entire
-- revenue through this courier.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['billing_settings', 'invoice_sequences', 'invoices', 'invoice_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tbl);
  END LOOP;
END
$$;

DROP POLICY IF EXISTS billing_settings_isolation ON billing_settings;
CREATE POLICY billing_settings_isolation ON billing_settings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS invoice_sequences_isolation ON invoice_sequences;
CREATE POLICY invoice_sequences_isolation ON invoice_sequences
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS invoices_isolation ON invoices;
CREATE POLICY invoices_isolation ON invoices
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
  );

-- Lines inherit the parent's visibility, expressed ONCE as an EXISTS so the two
-- cannot drift apart.
DROP POLICY IF EXISTS invoice_lines_isolation ON invoice_lines;
CREATE POLICY invoice_lines_isolation ON invoice_lines
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id)
  );

-- No DELETE on invoices: a tax document is never removed, only cancelled.
GRANT SELECT, INSERT, UPDATE ON billing_settings  TO dp_app;
GRANT SELECT, INSERT, UPDATE ON invoice_sequences TO dp_app;
GRANT SELECT, INSERT, UPDATE ON invoices          TO dp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_lines TO dp_app;

COMMENT ON TABLE invoices IS
  'Factures and avoirs. Gapless numbering, immutable once issued, corrected only '
  'by a credit note. Never deleted.';
