-- Finance context — double-entry ledger (docs/02-domain-model.md §3.14–3.16,
-- docs/03-event-storming.md §P5, docs/06-database-design.md §"ledger").
--
-- This is the financial system of record. Three tables:
--
--   currencies      — GLOBAL reference data (no tenant_id, no RLS). Holds the ISO
--                     4217 minor-unit exponent that every money conversion reads.
--                     TND is 3 decimals (1 TND = 1000 millimes); a hardcoded x100
--                     is a 1000x error on Tunisian money (docs/01-mvp-scope §7.1).
--   ledger_accounts — a named balance container per (owner, type, currency).
--   ledger_entries  — one side of one money movement. Immutable. APPEND-ONLY.
--
-- The load-bearing invariant: every transaction_id group sums to zero per currency
-- (total debits = total credits). It is enforced by a DEFERRABLE constraint trigger
-- checked at COMMIT, so a half-written, unbalanced transaction cannot exist — not
-- even transiently visible to another statement in the same transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- currencies — global reference. NOT tenant-scoped (domain §1: "every entity
-- except Tenant and Currency carries tenantId"). Read-only to the app: seeded and
-- maintained by migrations only.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS currencies (
  code       CHAR(3) PRIMARY KEY,          -- ISO 4217 alpha
  -- ISO 4217 minor-unit exponent: TND/LYD = 3, MAD/EGP/DZD/AED/SAR/EUR/USD = 2.
  exponent   SMALLINT NOT NULL,
  name       TEXT NOT NULL,
  symbol     TEXT,

  CONSTRAINT currencies_exponent_chk CHECK (exponent BETWEEN 0 AND 4)
);

-- MENA-first, plus the majors a Maghreb courier encounters. Idempotent seed.
INSERT INTO currencies (code, exponent, name, symbol) VALUES
  ('TND', 3, 'Tunisian Dinar', 'DT'),
  ('LYD', 3, 'Libyan Dinar', 'LD'),
  ('MAD', 2, 'Moroccan Dirham', 'DH'),
  ('DZD', 2, 'Algerian Dinar', 'DA'),
  ('EGP', 2, 'Egyptian Pound', 'E£'),
  ('AED', 2, 'UAE Dirham', 'AED'),
  ('SAR', 2, 'Saudi Riyal', 'SAR'),
  ('EUR', 2, 'Euro', '€'),
  ('USD', 2, 'US Dollar', '$')
ON CONFLICT (code) DO NOTHING;

-- The app reads currencies but must never write them — reference data is a
-- migration concern. (dp_app gets full DML by default privileges; REVOKE writes.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON currencies FROM dp_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- ledger_accounts — one balance container per (tenant, type, owner, currency).
-- balance_minor is a CACHE; the truth is SUM(entries). A reconciliation job
-- compares them and any drift is a P1 alert (domain §3.14 rule 2).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_type   TEXT NOT NULL,
  -- Owner is always present. Tenant-level accounts (PLATFORM_REVENUE, BANK,
  -- WRITE_OFF) use owner_type = 'TENANT' and owner_id = tenant_id, so the unique
  -- index below needs no NULL handling.
  owner_type     TEXT NOT NULL,
  owner_id       UUID NOT NULL,
  currency       CHAR(3) NOT NULL REFERENCES currencies (code),
  balance_minor  BIGINT NOT NULL DEFAULT 0,
  normal_balance TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ledger_accounts_type_chk CHECK (account_type IN (
    'DRIVER_CASH', 'HUB_CASH', 'MERCHANT_PAYABLE',
    'PLATFORM_REVENUE', 'BANK', 'WRITE_OFF', 'CUSTOMER_RECEIVABLE'
  )),
  CONSTRAINT ledger_accounts_owner_chk CHECK (owner_type IN ('DRIVER', 'HUB', 'MERCHANT', 'TENANT')),
  CONSTRAINT ledger_accounts_normal_chk CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ledger_accounts_status_chk CHECK (status IN ('ACTIVE', 'FROZEN', 'CLOSED'))
);

-- One account per (owner, type, currency). Multi-currency = multiple accounts,
-- never a converted balance (domain §3.14 rule 1).
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_owner_uq
  ON ledger_accounts (tenant_id, account_type, owner_type, owner_id, currency);
CREATE INDEX IF NOT EXISTS ledger_accounts_tenant_idx ON ledger_accounts (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- ledger_entries — the atomic unit of financial truth. Immutable, append-only.
-- amount_minor is ALWAYS positive; `direction` carries the sign (domain §3.15
-- rule 4 — signed amounts + directions produce double-negative bugs).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Groups the two-or-more sides of one movement. The balanced check is per group.
  transaction_id       UUID NOT NULL,
  account_id           UUID NOT NULL REFERENCES ledger_accounts (id),
  direction            TEXT NOT NULL,
  amount_minor         BIGINT NOT NULL,
  currency             CHAR(3) NOT NULL REFERENCES currencies (code),
  entry_type           TEXT NOT NULL,
  shipment_id          UUID,
  remittance_id        UUID,
  settlement_id        UUID,
  reversal_of_entry_id UUID REFERENCES ledger_entries (id),
  -- The domain event that produced this entry, when event-sourced. The unique
  -- index below makes re-posting the same event's transaction a no-op — ledger
  -- idempotency independent of the consumer's processed_events ledger.
  source_event_id      UUID,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID,
  description          TEXT NOT NULL DEFAULT '',

  CONSTRAINT ledger_entries_direction_chk CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ledger_entries_amount_chk CHECK (amount_minor > 0),
  CONSTRAINT ledger_entries_type_chk CHECK (entry_type IN (
    'COD_COLLECTED', 'COD_REMITTED', 'SETTLEMENT', 'ADJUSTMENT', 'WRITE_OFF', 'REVERSAL'
  ))
);

CREATE INDEX IF NOT EXISTS ledger_entries_account_idx
  ON ledger_entries (tenant_id, account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_transaction_idx
  ON ledger_entries (transaction_id);
-- Idempotency backstop: an event-sourced transaction posts one row per
-- (account, direction); re-posting the same event conflicts on every line, so a
-- retry inserts nothing. A NULL source_event_id (manual adjustment) is distinct
-- in a unique index, so those never collide.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_source_event_uq
  ON ledger_entries (tenant_id, source_event_id, account_id, direction)
  WHERE source_event_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- The zero-sum invariant, enforced in-database.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger: it fires at COMMIT, after
-- every entry of a transaction is inserted, and rejects the whole transaction if
-- any currency's debits != credits. Deferring is what lets a domain operation
-- insert both sides in one statement sequence without the check tripping on the
-- transient one-sided state. The SELECT runs as the invoker under RLS, and every
-- entry in a transaction shares one tenant, so the tenant-scoped read sees them all.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imbalanced INTEGER;
BEGIN
  SELECT count(*) INTO imbalanced
  FROM (
    SELECT currency,
           sum(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END) AS net
    FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id
    GROUP BY currency
  ) grouped
  WHERE grouped.net <> 0;

  IF imbalanced > 0 THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced: debits != credits per currency', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION ledger_assert_balanced();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security + grants.
--
--   ledger_accounts — tenant-scoped; balance cache + status are updated, so keep
--                     UPDATE, REVOKE DELETE/TRUNCATE (accounts are closed, never
--                     deleted — domain §3.14 rule 4).
--   ledger_entries  — tenant-scoped and APPEND-ONLY: REVOKE UPDATE, DELETE,
--                     TRUNCATE. Corrections are new REVERSAL entries; a record you
--                     can edit is not a record (domain §3.15 rule 2).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ledger_accounts', 'ledger_entries'] LOOP
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

  EXECUTE 'REVOKE DELETE, TRUNCATE ON ledger_accounts FROM dp_app';
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM dp_app';
END
$$;

COMMENT ON TABLE currencies IS
  'Global ISO 4217 reference (no tenant_id, no RLS). Holds the minor-unit exponent every money conversion reads. TND = 3 decimals.';
COMMENT ON TABLE ledger_accounts IS
  'Double-entry account per (tenant, type, owner, currency). balance_minor is a cache reconciled against SUM(entries); drift is a P1 alert.';
COMMENT ON TABLE ledger_entries IS
  'Append-only financial truth. One side of one movement; every transaction_id sums to zero per currency (deferred trigger). Corrections are REVERSAL entries.';
