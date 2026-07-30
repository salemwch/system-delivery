-- ─────────────────────────────────────────────────────────────────────────────
-- 0027 — a COD that will never be collected, and an SLA level that exists
--
-- Two defects, both of which over- or under-state real money.
--
-- 1. `cod_status` had no value meaning "there WAS a COD and it will never be
--    collected". A returned or cancelled parcel therefore stayed PENDING
--    forever, and PENDING is exactly what `shipment-stats.service.ts` sums into
--    cash-in-field (docs/01 §4.5 #5.5) — the figure a courier reconciles its
--    drivers' satchels against at end of day. Every returned COD parcel inflated
--    it by its full value, permanently. In a COD market with normal return rates
--    that is not a rounding error; it is the reconciliation being wrong every
--    single day, in a direction that looks like drivers are short of cash.
--
--    NOT_APPLICABLE cannot be used: I6 (`shipments_cod_consistency_chk`) states
--    `cod_amount_minor = 0 ⇔ cod_status = 'NOT_APPLICABLE'`, and zeroing the
--    amount would destroy the record of what was at stake — precisely the number
--    a merchant dispute is argued over. CANCELLED keeps the amount and says the
--    cash is closed.
--
-- 2. `sla_templates_level_chk` allowed STANDARD | EXPRESS | SAME_DAY while
--    `shipments_service_level_chk` allows EXPRESS | STANDARD | SCHEDULED. The
--    0026 comment claimed the two matched. They did not: SAME_DAY rows could
--    never apply to any shipment, and a SCHEDULED shipment could never have a
--    template — so it got no promised-by date and fell back to a hardcoded
--    24-hour re-attempt delay instead of its tenant's own.
-- ─────────────────────────────────────────────────────────────────────────────

-- ⚠️ TRAP: FORCE ROW LEVEL SECURITY APPLIES TO THE TABLE OWNER TOO.
--
-- `dp_migrator` owns these tables, and every data table in this schema is
-- ENABLE + FORCE. A migration runs with no `app.current_tenant_id`, so every
-- policy evaluates false and a backfill `UPDATE`/`DELETE` here matches ZERO
-- ROWS — silently, reporting success. `ALTER TABLE … ADD CONSTRAINT` then
-- validates every row in the heap, RLS or not, and fails on the rows the DML
-- was supposed to have fixed. That mismatch is the whole diagnosis: DML is
-- filtered, constraint validation is not.
--
-- `SET LOCAL row_security = off` is not the escape: without BYPASSRLS it raises
-- rather than exempting. Dropping FORCE for the duration of this transaction is,
-- and the file is one transaction — the tables are never reachable unfiltered
-- from another session, and a failure rolls the FORCE back with everything else.
ALTER TABLE shipments     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sla_templates NO FORCE ROW LEVEL SECURITY;

-- ── 1. COD closure ───────────────────────────────────────────────────────────

ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_cod_status_chk;
ALTER TABLE shipments ADD CONSTRAINT shipments_cod_status_chk CHECK (cod_status IN (
  'NOT_APPLICABLE', 'PENDING', 'COLLECTED', 'REMITTED', 'SETTLED', 'CANCELLED'
));

-- I6 is untouched and still holds: it constrains NOT_APPLICABLE only, so a
-- CANCELLED row keeps a non-zero amount legally.
--
-- Backfill: a parcel already in a terminal state that never collected its cash.
-- Without this, every return and cancellation recorded before this migration
-- stays in cash-in-field for good.
UPDATE shipments
   SET cod_status = 'CANCELLED'
 WHERE cod_status = 'PENDING'
   AND status IN ('RETURNED', 'CANCELLED');

-- ── 2. SLA service levels ────────────────────────────────────────────────────

-- SAME_DAY rows can never match a shipment, so they are removed rather than
-- renamed: SCHEDULED means "the customer chose a slot", which is not the same
-- promise and must not silently inherit an 8-hour one.
DELETE FROM sla_templates WHERE service_level = 'SAME_DAY';

ALTER TABLE sla_templates DROP CONSTRAINT IF EXISTS sla_templates_level_chk;
ALTER TABLE sla_templates ADD CONSTRAINT sla_templates_level_chk
  CHECK (service_level IN ('EXPRESS', 'STANDARD', 'SCHEDULED'));

-- Every existing tenant gets the missing level. New tenants are seeded by
-- `TenantService.provision` — a migration only ever reaches the tenants that
-- exist when it runs, which is why the 0026 seed left every subsequently
-- provisioned courier with no operating configuration at all.
INSERT INTO sla_templates (tenant_id, service_level, delivery_hours, reattempt_delay_hours, max_attempts)
SELECT t.id, 'SCHEDULED', 72, 24, 3
FROM tenants t
ON CONFLICT (tenant_id, service_level) DO NOTHING;

-- ── Restore ──────────────────────────────────────────────────────────────────
--
-- Non-negotiable and in the same transaction: leaving either table merely
-- ENABLEd would let the owning role read across every tenant.
ALTER TABLE shipments     FORCE ROW LEVEL SECURITY;
ALTER TABLE sla_templates FORCE ROW LEVEL SECURITY;
