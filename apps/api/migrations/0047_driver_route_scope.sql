-- Driver scope extended to routes and their stops (invariant I28).
--
-- ⚠️ THE GAP THIS CLOSES. 0045 scoped shipments, their child tables,
-- recipients and pickups, but `routes` and `route_stops` stayed tenant-wide.
-- `GET /v1/routes` listed every route in the tenant to any driver, and
-- `GET /v1/routes/:id/manifest` returned each stop's latitude, longitude and
-- address. That is where a colleague's recipients live. The parcels inside a
-- foreign stop were already hidden (RLS on shipments), but the recipient's
-- home location was not. Found by the release-candidate verification of
-- 9318622 (driver B read driver A's manifest).
--
-- A driver now sees only routes assigned to them (`routes.driver_id`), and
-- only the stops of those routes. Every other session is unaffected: the
-- predicates are a no-op without `app.current_driver_id`.
--
-- Not scoped here, and why:
--   - `addresses` has no HTTP route. A driver reaches an address only through
--     a scoped parent (own shipment, own pickup, own route stop), and is
--     referenced from six tables, so an EXISTS over all of them is cost
--     without a reachable exposure. Recorded as defence-in-depth follow-up.
--   - `optimization_jobs` needs `route:optimize`, which no driver holds.

CREATE OR REPLACE FUNCTION current_driver_allows_route(row_driver_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_driver_id', true), '') = '' THEN TRUE
    -- A route with no driver (DRAFT) compares NULL: nobody's in the field yet.
    ELSE row_driver_id = NULLIF(current_setting('app.current_driver_id', true), '')::uuid
  END;
$$;

COMMENT ON FUNCTION current_driver_allows_route(UUID) IS
  'Invariant I28. True for non-driver sessions, or when the route is assigned to the '
  'session''s driver.';

DROP POLICY IF EXISTS routes_isolation ON routes;
CREATE POLICY routes_isolation ON routes
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_driver_allows_route(driver_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_driver_allows_route(driver_id)
  );

-- Stops follow their route: the EXISTS runs under the routes policy above.
DROP POLICY IF EXISTS route_stops_isolation ON route_stops;
CREATE POLICY route_stops_isolation ON route_stops
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM routes r WHERE r.id = route_stops.route_id)
             ELSE TRUE END
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM routes r WHERE r.id = route_stops.route_id)
             ELSE TRUE END
  );
