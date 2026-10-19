-- Driver scope extended to addresses (invariant I28).
--
-- ⚠️ THE GAP THIS CLOSES. `addresses` kept the tenant-only policy from 0005.
-- A driver reached an address only through a scoped parent (their own
-- shipment's detail, their own route manifest), so no HTTP route disclosed a
-- colleague's address. That rested on every caller remembering to start from a
-- scoped parent: `AddressService.getById` and `applyDriverCorrection` take any
-- id and check nothing, DRIVER holds `address:read` and `address:correct`, and
-- the driver geocode correction (docs/01-mvp-scope.md 2.10, P0) is the next
-- route to use them. With a tenant-wide policy that route would let any driver
-- read every recipient's coordinates and access notes, and move any pin in the
-- tenant, including a colleague's, which also defeats the POD distance check.
-- 0047 recorded this as a deferred defence-in-depth follow-up.
--
-- The rule: for a driver session, an address is visible while it is the
-- origin or destination of a shipment the driver may read (0045), the location
-- of a route stop they may read (0047, 0048), or the pickup address of a pickup
-- assigned to them (0045). Each EXISTS runs under its parent's own policy, so
-- "may read" is decided once, by the parent. One address row can serve many
-- parents (a merchant's standing pickup address, a return leg), and it stays
-- visible to every driver authorised through ANY of them. No row is copied and
-- no driver column is added: visibility is derived, never stored.
--
-- Not included, on purpose: `recipients.default_address_id` (a person's other
-- addresses are not this delivery's), `merchants.default_pickup_address_id`
-- (reached through the pickup instead), `hubs` and `geofences` (no driver
-- route reads them), and `shipment_legs` (a leg's ends are the shipment's own
-- addresses, a route stop, or a hub).
--
-- USING only, like `recipients` in 0045: it bounds what a driver session
-- reads, and which rows its UPDATE can reach (a correction to an address the
-- driver cannot see matches nothing). WITH CHECK stays tenant-only, so no
-- insert path changes. Non-driver sessions are unaffected: the predicate
-- returns TRUE before it reads anything.

-- ── 1. Indexes for the EXISTS probes ─────────────────────────────────────────
-- None of these columns was indexed, so each probe would scan the tenant's
-- rows. (tenant_id, column) matches the composite foreign keys of 0036.

CREATE INDEX IF NOT EXISTS shipments_tenant_origin_address_idx
  ON shipments (tenant_id, origin_address_id);
CREATE INDEX IF NOT EXISTS shipments_tenant_destination_address_idx
  ON shipments (tenant_id, destination_address_id);
CREATE INDEX IF NOT EXISTS route_stops_tenant_address_idx
  ON route_stops (tenant_id, address_id)
  WHERE address_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pickup_requests_tenant_pickup_address_idx
  ON pickup_requests (tenant_id, pickup_address_id);

-- ── 2. Predicate ────────────────────────────────────────────────────────────
-- ⚠️ PL/pgSQL, NOT an inlined SQL expression, and that is measured, not taste.
-- Written inline (or as a LANGUAGE sql function, which the planner inlines),
-- this predicate pulls the policies of shipments, route_stops, routes,
-- shipment_legs and pickup_requests into the plan of EVERY address read, for
-- every role: planning went from about 1-2 ms to about 19 ms per read, staff
-- included (the CASE short-circuits execution, not planning). The app plans
-- every statement (`prepare: false`), and a route manifest reads its stops'
-- addresses one by one, so a 40-stop manifest would have paid about 0.7 s.
-- A PL/pgSQL function is opaque to the planner, and caches the plan of its own
-- query per session. It runs as the caller (SECURITY INVOKER, the default), so
-- each EXISTS is still filtered by its parent's own policy.

CREATE OR REPLACE FUNCTION current_driver_allows_address(row_tenant_id UUID, row_address_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF COALESCE(current_setting('app.current_driver_id', true), '') = '' THEN
    RETURN TRUE;
  END IF;
  RETURN EXISTS (SELECT 1 FROM shipments s
                  WHERE s.tenant_id = row_tenant_id
                    AND s.destination_address_id = row_address_id)
      OR EXISTS (SELECT 1 FROM shipments s
                  WHERE s.tenant_id = row_tenant_id
                    AND s.origin_address_id = row_address_id)
      OR EXISTS (SELECT 1 FROM route_stops rs
                  WHERE rs.tenant_id = row_tenant_id
                    AND rs.address_id = row_address_id)
      OR EXISTS (SELECT 1 FROM pickup_requests p
                  WHERE p.tenant_id = row_tenant_id
                    AND p.pickup_address_id = row_address_id);
END;
$$;

COMMENT ON FUNCTION current_driver_allows_address(UUID, UUID) IS
  'Invariant I28. True for non-driver sessions, or when the address belongs to a '
  'shipment, route stop or pickup the session''s driver may read.';

-- ── 3. Policy ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS addresses_isolation ON addresses;
CREATE POLICY addresses_isolation ON addresses
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_driver_allows_address(tenant_id, id)
  )
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
