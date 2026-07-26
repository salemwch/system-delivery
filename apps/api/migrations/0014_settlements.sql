-- Merchant settlements (docs/02-domain-model.md §3.16, docs/03-event-storming.md
-- §settlement.paid) — finance increment 3. The courier paying a merchant the COD
-- collected on their behalf, less delivery fees. Closes the commercial loop.
--
-- MVP scope (decision: operational-timing): a settlement covers a merchant's COD
-- COLLECTED in a period. The "only REMITTED COD is settleable" rule (domain §3.16
-- rule 1) is satisfied operationally — finance settles after drivers have remitted
-- — rather than by a per-shipment remitted gate, which needs machinery deferred to
-- a later increment. Adjustments and negative net payable are likewise deferred:
-- MVP settles gross − fees with net >= 0.
--
-- Ledger effect on PAID (a balanced transaction, so fees do not linger in the
-- payable): DEBIT merchant_payable GROSS · CREDIT bank NET · CREDIT platform_revenue FEES.
--
-- Two invariants matter here:
--   * separation of duties — the approver must not be the drafter (enforced in the
--     service, since it needs the actor identity);
--   * a shipment appears in AT MOST ONE settlement — enforced by the unique index
--     on settlement_shipments below.

CREATE TABLE IF NOT EXISTS settlements (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  merchant_id           UUID NOT NULL,
  code                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'DRAFT',
  period_from           DATE NOT NULL,
  period_to             DATE NOT NULL,
  gross_cod_amount_minor BIGINT NOT NULL,
  delivery_fees_minor   BIGINT NOT NULL DEFAULT 0,
  adjustments_minor     BIGINT NOT NULL DEFAULT 0,
  net_payable_minor     BIGINT NOT NULL,
  currency              CHAR(3) NOT NULL REFERENCES currencies (code),
  shipment_count        INTEGER NOT NULL DEFAULT 0,
  payment_method        TEXT,
  payment_reference     TEXT,
  created_by_user_id    UUID NOT NULL,
  approved_by_user_id   UUID,
  approved_at           TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT settlements_status_chk
    CHECK (status IN ('DRAFT', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED')),
  CONSTRAINT settlements_payment_method_chk
    CHECK (payment_method IS NULL OR payment_method IN ('BANK_TRANSFER', 'CHEQUE', 'CASH')),
  CONSTRAINT settlements_period_chk CHECK (period_to >= period_from),
  CONSTRAINT settlements_amounts_chk
    CHECK (gross_cod_amount_minor >= 0 AND delivery_fees_minor >= 0),
  -- Separation of duties: the approver must differ from the drafter (also enforced
  -- in the service for a clear error before the write).
  CONSTRAINT settlements_approver_chk
    CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS settlements_code_uq ON settlements (tenant_id, code);
CREATE INDEX IF NOT EXISTS settlements_merchant_idx
  ON settlements (tenant_id, merchant_id, status);

-- The shipments a settlement covers. The unique index is the enforcement of
-- "a shipment appears in at most one settlement" (domain §3.16 rule 2).
CREATE TABLE IF NOT EXISTS settlement_shipments (
  id            UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  settlement_id UUID NOT NULL REFERENCES settlements (id) ON DELETE CASCADE,
  shipment_id   UUID NOT NULL,
  amount_minor  BIGINT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_shipments_shipment_uq
  ON settlement_shipments (tenant_id, shipment_id);
CREATE INDEX IF NOT EXISTS settlement_shipments_settlement_idx
  ON settlement_shipments (settlement_id);

-- RLS + FORCE on both. Settlements are never deleted (CANCELLED before payment,
-- reversed by adjustment after — domain §3.16 rule 7); REVOKE DELETE, TRUNCATE.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['settlements', 'settlement_shipments'] LOOP
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

  EXECUTE 'REVOKE DELETE, TRUNCATE ON settlements FROM dp_app';
  -- settlement_shipments lines are never UPDATEd. DELETE stays granted: cancelling
  -- a pre-payment settlement removes its provisional lines to free those shipments
  -- for a later settlement (the unique index otherwise locks them forever).
  EXECUTE 'REVOKE UPDATE, TRUNCATE ON settlement_shipments FROM dp_app';
END
$$;

COMMENT ON TABLE settlements IS
  'Merchant COD payout per period (domain §3.16). MVP: gross − fees, net >= 0, remitted rule operational. Ledger posts on PAID: DEBIT merchant_payable GROSS / CREDIT bank NET / CREDIT platform_revenue FEES. Never deleted.';
COMMENT ON TABLE settlement_shipments IS
  'Which shipments a settlement covers. The unique index on (tenant_id, shipment_id) enforces at-most-one-settlement-per-shipment (domain §3.16 rule 2).';
