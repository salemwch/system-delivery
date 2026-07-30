-- Per-tenant operating configuration (docs/01-mvp-scope.md §4.1 #1.8, §4.2 #2.7,
-- §4.7 #7.7).
--
-- ⚠️ "Config is data, never code" (§4.1 #1.8). Three things move out of TypeScript
-- constants and into tenant-owned rows here, and each was already wrong as a
-- constant:
--
--   * FAILURE REASONS. `DEFAULT_FAILURE_REASONS` lived in config-bootstrap and was
--     the same for every tenant. DM5 explicitly wants the taxonomy confirmed with
--     a real courier — which cannot happen if changing it is a deploy.
--
--   * WORKING HOURS. `weekendDays` was hardcoded `[6, 7]`. Tunisia is
--     Saturday–Sunday, but the Gulf runs Friday–Saturday, and a courier working
--     six days is ordinary. A re-attempt scheduled onto a day nobody works is a
--     wasted promise to a customer.
--
--   * SLA TEMPLATES. Nothing computed a promised date at all.

-- ─────────────────────────────────────────────────────────────────────────────
-- failure_reasons — the taxonomy a driver picks from (#7.7).
--
-- Structured codes rather than free text: free-text reasons cannot drive the
-- re-attempt decision, cannot be counted in a report, and cannot be translated.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS failure_reasons (
  id               UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- SCREAMING_SNAKE, stable. Stored on `shipment_events.reason_code`, so it is a
  -- historical key: renaming one would orphan every past attempt.
  code             TEXT        NOT NULL,

  -- Per-locale labels for the driver app. A driver picks from this list on a
  -- phone, in Arabic or French — not from an English enum.
  labels           JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- ⚠️ THE LOAD-BEARING COLUMN. False means the parcel goes straight to
  -- RETURN_PENDING rather than consuming its remaining attempts.
  --
  -- Driving out to a customer who has REFUSED the parcel, twice more, is a
  -- wasted trip plus a return leg — in a COD market that is the most expensive
  -- ordinary mistake a courier makes.
  allows_reattempt BOOLEAN     NOT NULL DEFAULT true,

  -- Some failures are the recipient's (refused, unavailable) and some are the
  -- courier's (damaged, wrong hub). Separating them is what makes a failure
  -- report actionable rather than a list of excuses.
  fault            TEXT        NOT NULL DEFAULT 'RECIPIENT',

  -- Ordering in the driver app's picker. The reason a driver selects twenty
  -- times a day should not be at the bottom of an alphabetical list.
  display_order    SMALLINT    NOT NULL DEFAULT 100,
  active           BOOLEAN     NOT NULL DEFAULT true,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT failure_reasons_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{1,48}$'),
  CONSTRAINT failure_reasons_fault_chk CHECK (fault IN ('RECIPIENT','COURIER','MERCHANT','EXTERNAL'))
);

COMMENT ON TABLE failure_reasons IS
  'Per-tenant delivery-failure taxonomy (docs/01 §4.7 #7.7). allows_reattempt is what stops a refused parcel consuming two more wasted trips.';
COMMENT ON COLUMN failure_reasons.code IS
  'Stable historical key — written to shipment_events.reason_code. Renaming one orphans every past attempt.';

CREATE UNIQUE INDEX IF NOT EXISTS failure_reasons_tenant_code_uq
  ON failure_reasons (tenant_id, code);
CREATE INDEX IF NOT EXISTS failure_reasons_active_idx
  ON failure_reasons (tenant_id, display_order)
  WHERE active;

-- ─────────────────────────────────────────────────────────────────────────────
-- working_hours — when this tenant actually operates (#1.8).
--
-- One row per weekday. ISO-8601 numbering (1 = Monday … 7 = Sunday), which is
-- what `EXTRACT(ISODOW)` returns, so no off-by-one translation exists anywhere.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS working_hours (
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- 1 = Monday … 7 = Sunday (ISO-8601).
  day_of_week SMALLINT    NOT NULL,

  -- Local wall-clock in the tenant's own timezone, NOT UTC. A courier opens at
  -- 08:00 Tunis time all year; storing UTC would shift the working day whenever
  -- the offset changed and would be unreadable to the operator who sets it.
  opens_at    TIME        NOT NULL DEFAULT '08:00',
  closes_at   TIME        NOT NULL DEFAULT '18:00',

  -- False for a weekend or a closed day. The row still exists so the schedule is
  -- complete and a missing row is unambiguously a bug rather than a closure.
  is_working  BOOLEAN     NOT NULL DEFAULT true,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, day_of_week),
  CONSTRAINT working_hours_day_chk CHECK (day_of_week BETWEEN 1 AND 7),
  -- A day that closes before it opens would silently make every scheduling
  -- calculation return nothing.
  CONSTRAINT working_hours_span_chk CHECK (closes_at > opens_at)
);

COMMENT ON TABLE working_hours IS
  'Per-tenant operating schedule in LOCAL wall-clock time. ISO-8601 day numbering to match EXTRACT(ISODOW). Drives re-attempt scheduling and SLA due dates.';

-- ─────────────────────────────────────────────────────────────────────────────
-- holidays — the days a courier is closed that a weekly schedule cannot express.
--
-- Tunisia observes both fixed civil holidays and Islamic ones that move ~11 days
-- earlier each year, so this cannot be derived — it is entered.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS holidays (
  tenant_id  UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- A local calendar date, not a timestamp: a holiday is a day, not an instant.
  day        DATE        NOT NULL,
  label      TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, day)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- sla_templates — the delivery promise, per service level (#1.8).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sla_templates (
  id                   UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- STANDARD | EXPRESS | SAME_DAY, matching shipments.service_level.
  service_level        TEXT        NOT NULL,

  -- ⚠️ WORKING hours, not elapsed hours. A parcel accepted at 17:00 on a Friday
  -- with a 24-hour promise is due Monday morning, not Saturday evening — and a
  -- promise measured in wall-clock time would mark it late before anyone could
  -- have delivered it.
  delivery_hours       INTEGER     NOT NULL,

  -- How long after a failed attempt the next one may be made. A parcel retried
  -- an hour later finds the same empty house; the next working day does not.
  reattempt_delay_hours INTEGER    NOT NULL DEFAULT 24,

  -- Rule 9's cap, per service level rather than per shipment.
  max_attempts         SMALLINT    NOT NULL DEFAULT 3,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sla_templates_level_chk CHECK (service_level IN ('STANDARD','EXPRESS','SAME_DAY')),
  CONSTRAINT sla_templates_hours_chk CHECK (delivery_hours > 0 AND delivery_hours <= 8760),
  CONSTRAINT sla_templates_delay_chk CHECK (reattempt_delay_hours >= 0 AND reattempt_delay_hours <= 720),
  CONSTRAINT sla_templates_attempts_chk CHECK (max_attempts BETWEEN 1 AND 10)
);

CREATE UNIQUE INDEX IF NOT EXISTS sla_templates_tenant_level_uq
  ON sla_templates (tenant_id, service_level);

-- ─────────────────────────────────────────────────────────────────────────────
-- shipments.next_attempt_at — WHEN the next delivery attempt may be made.
--
-- The missing half of #2.7. `attempt_count` and `max_attempts` already existed,
-- so the system knew IF another attempt was allowed but never WHEN — leaving a
-- failed parcel with no scheduled future, which is how it silently sits in a hub
-- until someone notices.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

COMMENT ON COLUMN shipments.next_attempt_at IS
  'When the next delivery attempt may be made, computed from the tenant working calendar. NULL when no further attempt is due (delivered, returning, or attempts exhausted).';

-- The dispatcher's morning question: "what is due for a re-attempt today?"
-- Partial, because it only ever matters for a shipment that is between attempts.
CREATE INDEX IF NOT EXISTS shipments_next_attempt_idx
  ON shipments (tenant_id, next_attempt_at)
  WHERE next_attempt_at IS NOT NULL AND status = 'ATTEMPT_FAILED';

-- ─────────────────────────────────────────────────────────────────────────────
-- Seeding for tenants that already exist.
--
-- ⚠️ ORDER IS LOAD-BEARING: this runs BEFORE the RLS block below, and must.
-- The seed is cross-tenant by nature — one row per tenant, in a single
-- statement — and no single-tenant `WITH CHECK` policy can admit it. With
-- FORCE ROW LEVEL SECURITY already on, every row is rejected and the whole
-- migration rolls back. (Same class of trap as the TimescaleDB ordering rule in
-- 0018: certain operations must precede RLS, not follow it.)
--
-- Idempotent and additive. A tenant that has already customised its taxonomy
-- must not have it reset by a migration — `ON CONFLICT DO NOTHING` throughout,
-- so this fills gaps and never overwrites a decision someone made.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO failure_reasons (tenant_id, code, labels, allows_reattempt, fault, display_order)
SELECT
  t.id,
  r.code,
  r.labels::jsonb,
  r.allows_reattempt,
  r.fault,
  r.display_order
FROM tenants t
CROSS JOIN (VALUES
  -- Ordered by how often a Tunisian driver actually picks them.
  ('CUSTOMER_UNAVAILABLE',
   '{"ar":"العميل غير متوفر","fr":"Client absent","en":"Customer unavailable"}',
   true,  'RECIPIENT', 10),
  ('CUSTOMER_UNREACHABLE',
   '{"ar":"تعذر الاتصال بالعميل","fr":"Client injoignable","en":"Customer unreachable"}',
   true,  'RECIPIENT', 20),
  ('INSUFFICIENT_CASH',
   '{"ar":"نقص في السيولة","fr":"Fonds insuffisants","en":"Insufficient cash"}',
   true,  'RECIPIENT', 30),
  ('WRONG_ADDRESS',
   '{"ar":"عنوان خاطئ","fr":"Mauvaise adresse","en":"Wrong address"}',
   true,  'MERCHANT',  40),
  ('ACCESS_RESTRICTED',
   '{"ar":"دخول ممنوع","fr":"Accès restreint","en":"Access restricted"}',
   true,  'EXTERNAL',  50),
  -- The two that must NOT be re-attempted. Driving out again after a refusal is
  -- a wasted trip plus a return leg.
  ('CUSTOMER_REFUSED',
   '{"ar":"رفض العميل","fr":"Refus du client","en":"Customer refused"}',
   false, 'RECIPIENT', 60),
  ('DAMAGED_PACKAGE',
   '{"ar":"طرد تالف","fr":"Colis endommagé","en":"Damaged package"}',
   false, 'COURIER',   70)
) AS r(code, labels, allows_reattempt, fault, display_order)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- Working hours: Monday–Friday 08:00–18:00, Saturday 08:00–13:00, Sunday closed.
-- The Tunisian norm, and every value is a row a tenant can change.
INSERT INTO working_hours (tenant_id, day_of_week, opens_at, closes_at, is_working)
SELECT t.id, d.day_of_week, d.opens_at::time, d.closes_at::time, d.is_working
FROM tenants t
CROSS JOIN (VALUES
  (1, '08:00', '18:00', true),
  (2, '08:00', '18:00', true),
  (3, '08:00', '18:00', true),
  (4, '08:00', '18:00', true),
  (5, '08:00', '18:00', true),
  (6, '08:00', '13:00', true),
  (7, '08:00', '18:00', false)
) AS d(day_of_week, opens_at, closes_at, is_working)
ON CONFLICT (tenant_id, day_of_week) DO NOTHING;

INSERT INTO sla_templates (tenant_id, service_level, delivery_hours, reattempt_delay_hours, max_attempts)
SELECT t.id, s.service_level, s.delivery_hours, s.reattempt_delay_hours, s.max_attempts
FROM tenants t
CROSS JOIN (VALUES
  -- WORKING hours. 24 working hours is roughly two-and-a-half Tunisian days.
  ('STANDARD', 48, 24, 3),
  ('EXPRESS',  24, 12, 3),
  -- Same-day gets one re-attempt: a second failure means the promise is already
  -- broken and holding the parcel serves nobody.
  ('SAME_DAY',  8,  4, 2)
) AS s(service_level, delivery_hours, reattempt_delay_hours, max_attempts)
ON CONFLICT (tenant_id, service_level) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security. Identical shape on all four tables.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['failure_reasons', 'working_hours', 'holidays', 'sla_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      || 'USING (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid) '
      || 'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)',
      tbl || '_isolation', tbl
    );
    -- Operating configuration is genuinely mutable — a courier changes its hours,
    -- retires a failure reason, adds next year's holidays. Only TRUNCATE is
    -- revoked (see 0022 on why REVOKE rather than a narrower GRANT).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO dp_app', tbl);
    EXECUTE format('REVOKE TRUNCATE ON %I FROM dp_app', tbl);
  END LOOP;
END
$$;
