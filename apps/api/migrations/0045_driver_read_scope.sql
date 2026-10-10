-- Driver row scoping (invariant I28, docs/01-mvp-scope.md §6: a driver sees
-- "own route only, own shipments only").
--
-- ⚠️ THE GAP THIS CLOSES. DRIVER held `shipment:read`, `pickup:read` and
-- `recipient:read` with tenant-wide RLS, so any driver could list every parcel,
-- every pickup run, and the whole recipient book (names, phones) of the courier.
-- Drivers are the most numerous and least-hardened accounts in the system, and
-- their phones are the devices most likely to be lost.
--
-- Same mechanism as the MERCHANT (I24) and COMMERCIAL (I25) scopes: a
-- transaction-local setting, `app.current_driver_id`, written by
-- DatabaseService.withTenant from the request context, and read by RLS so no
-- query can forget it. Empty for every non-driver session, where the
-- predicates below are a no-op. A DRIVER-role login with no driver record gets
-- the all-zero UUID, which matches nothing (fail closed).
--
-- WHAT "OWN" MEANS. A shipment belongs to the driver most recently named on its
-- custody chain: the route driver at publish (`assigned`), the collector at
-- pickup, the out-for-delivery driver, the driver who delivered, failed or
-- returned it. That is denormalised onto `shipments.last_driver_id`, maintained
-- by the single status writer (ShipmentEventService.applyTo) in the same
-- statement as the projection. Not computed from `shipment_events`:
--   - an EXISTS over a partitioned, append-only log on every row of every
--     shipment read is the wrong cost for the hottest table;
--   - and a custody-only test would hide a parcel from its driver the moment
--     they delivered it, failing the delivery's own WITH CHECK.
-- A parcel re-assigned to another driver leaves the first driver's view.
--
-- Child tables (events, legs, POD, pickup scans, recipients) are narrowed by
-- EXISTS on their parent, so RLS on the parent decides. Otherwise
-- `GET /shipments/:id/events` would read another driver's custody history
-- straight past the scoped parent. The EXISTS runs only for driver sessions:
-- CASE, not OR (see 0020).

-- ── 1. The ownership column, back-filled from the custody log ───────────────

ALTER TABLE shipments ADD COLUMN last_driver_id UUID;

COMMENT ON COLUMN shipments.last_driver_id IS
  'Invariant I28. The drivers.id most recently named on this shipment''s custody '
  'chain; written only by the event projection. Drives the driver read scope. No FK, '
  'like shipment_events.driver_id: a value that is not a driver matches no one.';

-- Back-fill needs to read every tenant. FORCE binds the owner too, so the three
-- tables are opened for this transaction only (the pattern from 0027).
ALTER TABLE shipments       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE shipment_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE drivers         NO FORCE ROW LEVEL SECURITY;

-- The latest event naming a REAL driver. Events written before ca5a10e could
-- carry a user id in driver_id (the pickup-scan bug), so ids are matched
-- against `drivers` rather than copied blindly.
UPDATE shipments s
   SET last_driver_id = named.driver_id
  FROM (
    SELECT DISTINCT ON (e.tenant_id, e.shipment_id)
           e.tenant_id, e.shipment_id, e.driver_id
      FROM shipment_events e
      JOIN drivers d ON d.tenant_id = e.tenant_id AND d.id = e.driver_id
     ORDER BY e.tenant_id, e.shipment_id, e.sequence DESC
  ) named
 WHERE s.tenant_id = named.tenant_id
   AND s.id = named.shipment_id;

ALTER TABLE shipments       FORCE ROW LEVEL SECURITY;
ALTER TABLE shipment_events FORCE ROW LEVEL SECURITY;
ALTER TABLE drivers         FORCE ROW LEVEL SECURITY;

CREATE INDEX shipments_tenant_last_driver_idx
  ON shipments (tenant_id, last_driver_id)
  WHERE last_driver_id IS NOT NULL;

-- ── 2. Predicates ────────────────────────────────────────────────────────────
-- STABLE: they read only settings that cannot change within a statement.
-- NULLIF before the cast: `''::uuid` is an error, not false (0031).

CREATE OR REPLACE FUNCTION current_driver_scoped()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.current_driver_id', true), '') <> '';
$$;

CREATE OR REPLACE FUNCTION current_driver_allows_shipment(row_last_driver_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_driver_id', true), '') = '' THEN TRUE
    -- A NULL owner compares NULL, which RLS treats as deny: a shipment no
    -- driver has been named on is nobody's in the field yet.
    ELSE row_last_driver_id = NULLIF(current_setting('app.current_driver_id', true), '')::uuid
  END;
$$;

-- A pickup's collector is a USER id (0044), so the driver's own login is
-- looked up rather than compared to the drivers.id in the setting.
CREATE OR REPLACE FUNCTION current_driver_allows_pickup(row_assigned_collector UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_driver_id', true), '') = '' THEN TRUE
    WHEN row_assigned_collector IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1 FROM drivers d
       WHERE d.id = NULLIF(current_setting('app.current_driver_id', true), '')::uuid
         AND d.user_id = row_assigned_collector
    )
  END;
$$;

COMMENT ON FUNCTION current_driver_allows_shipment(UUID) IS
  'Invariant I28. True for non-driver sessions, or when the shipment''s last named '
  'driver is the session''s driver.';
COMMENT ON FUNCTION current_driver_allows_pickup(UUID) IS
  'Invariant I28. True for non-driver sessions, or when the pickup is assigned to the '
  'session driver''s own login.';

-- ── 3. Policies (every existing predicate kept; the driver term is added) ───

DROP POLICY IF EXISTS shipments_isolation ON shipments;
CREATE POLICY shipments_isolation ON shipments
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
    AND current_driver_allows_shipment(last_driver_id)
  );

DROP POLICY IF EXISTS pickup_requests_tenant_isolation ON pickup_requests;
CREATE POLICY pickup_requests_tenant_isolation ON pickup_requests
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_merchant_allows(merchant_id)
    AND current_portfolio_allows(merchant_id)
    AND current_driver_allows_pickup(assigned_driver_id)
  );

DROP POLICY IF EXISTS shipment_events_isolation ON shipment_events;
CREATE POLICY shipment_events_isolation ON shipment_events
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM shipments s WHERE s.id = shipment_events.shipment_id)
             ELSE TRUE END
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM shipments s WHERE s.id = shipment_events.shipment_id)
             ELSE TRUE END
  );

DROP POLICY IF EXISTS shipment_legs_isolation ON shipment_legs;
CREATE POLICY shipment_legs_isolation ON shipment_legs
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM shipments s WHERE s.id = shipment_legs.shipment_id)
             ELSE TRUE END
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM shipments s WHERE s.id = shipment_legs.shipment_id)
             ELSE TRUE END
  );

DROP POLICY IF EXISTS pod_isolation ON pod;
CREATE POLICY pod_isolation ON pod
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM shipments s WHERE s.id = pod.shipment_id)
             ELSE TRUE END
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM shipments s WHERE s.id = pod.shipment_id)
             ELSE TRUE END
  );

DROP POLICY IF EXISTS pickup_shipments_tenant_isolation ON pickup_shipments;
CREATE POLICY pickup_shipments_tenant_isolation ON pickup_shipments
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM pickup_requests p
                           WHERE p.id = pickup_shipments.pickup_request_id)
             ELSE TRUE END
  );

-- The recipient book: a driver sees only the people their own shipments go to.
-- The EXISTS runs under the shipments policy above, so "own" is decided once.
DROP POLICY IF EXISTS recipients_isolation ON recipients;
CREATE POLICY recipients_isolation ON recipients
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM shipments s
                           WHERE s.tenant_id = recipients.tenant_id
                             AND s.recipient_id = recipients.id)
             ELSE TRUE END
  )
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
