-- COD remittances (docs/02-domain-model.md §3.13, docs/03-event-storming.md
-- §cod.cash_remitted) — finance increment 2. The record of a driver handing
-- collected cash to a hub: the point where cash custody transfers, and where
-- shrinkage is detected.
--
-- The entire point of this entity is that it records THREE separate amounts —
-- expected, declared, counted — because collapsing them destroys the ability to
-- tell a driver's arithmetic error from a hub miscount from theft (domain rule 1).
--   expected  = SUM(COD collected, not yet remitted) — the driver's DRIVER_CASH
--               balance. System-computed, never entered by a human (rule 2).
--   declared  = what the driver says they are handing over.
--   counted   = what the hub operator actually counted (the cash that moves).
--   variance  = counted − expected. Signed; a reason is MANDATORY when non-zero.
--
-- On confirmation the ledger posts DEBIT hub_cash / CREDIT driver_cash by the
-- COUNTED amount, atomically with the status change (RemittanceService does this
-- in one transaction — producer and ledger are the same module, so no async hop).
-- Remittances are NEVER deleted; a wrong one is corrected by a reversing entry.

CREATE TABLE IF NOT EXISTS cod_remittances (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code                  TEXT NOT NULL,
  driver_id             UUID NOT NULL,
  hub_id                UUID NOT NULL,
  -- The hub operator who counted the cash. Null until confirmed.
  received_by_user_id   UUID,
  status                TEXT NOT NULL DEFAULT 'SUBMITTED',
  expected_amount_minor BIGINT NOT NULL,
  declared_amount_minor BIGINT NOT NULL,
  counted_amount_minor  BIGINT,
  variance_minor        BIGINT NOT NULL DEFAULT 0,
  currency              CHAR(3) NOT NULL REFERENCES currencies (code),
  -- The collections this remittance covers. Informational; the authoritative
  -- expected amount is the ledger balance, not this list.
  shipment_ids          UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  variance_reason       TEXT,
  notes                 TEXT,
  submitted_at          TIMESTAMPTZ,
  confirmed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cod_remittances_status_chk
    CHECK (status IN ('DRAFT', 'SUBMITTED', 'CONFIRMED', 'DISPUTED', 'RESOLVED')),
  CONSTRAINT cod_remittances_amounts_chk
    CHECK (expected_amount_minor >= 0 AND declared_amount_minor >= 0),
  -- Unexplained variance cannot be confirmed (domain rule 3): a CONFIRMED
  -- remittance with a non-zero variance must carry a reason.
  CONSTRAINT cod_remittances_variance_reason_chk
    CHECK (status <> 'CONFIRMED' OR variance_minor = 0 OR variance_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS cod_remittances_code_uq
  ON cod_remittances (tenant_id, code);
CREATE INDEX IF NOT EXISTS cod_remittances_driver_idx
  ON cod_remittances (tenant_id, driver_id, status);
CREATE INDEX IF NOT EXISTS cod_remittances_hub_idx
  ON cod_remittances (tenant_id, hub_id, status);

-- RLS + FORCE; remittances are never deleted (domain rule 6) — REVOKE DELETE,
-- TRUNCATE. Status transitions are UPDATEs, so UPDATE stays granted.
ALTER TABLE cod_remittances ENABLE ROW LEVEL SECURITY;
ALTER TABLE cod_remittances FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cod_remittances_isolation ON cod_remittances;
CREATE POLICY cod_remittances_isolation ON cod_remittances
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

REVOKE DELETE, TRUNCATE ON cod_remittances FROM dp_app;

COMMENT ON TABLE cod_remittances IS
  'Driver → hub cash handoff (domain §3.13). Records expected/declared/counted separately so shrinkage is attributable. Confirmation posts DEBIT hub_cash / CREDIT driver_cash by the counted amount. Never deleted.';
