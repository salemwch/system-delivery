-- A driver sees a route stop only while they may see one of its parcels
-- (invariant I28, Decision 1 of the 9318622 release review).
--
-- ⚠️ THE GAP THIS CLOSES. 0047 scoped stops by their ROUTE: a driver saw every
-- stop of a route assigned to them. A published route is re-planned by
-- cancelling it and planning its legs onto a new route (domain §3.9 rule 5).
-- The cancelled route stays the first driver's, so after the parcel moved to a
-- colleague the first driver's manifest still returned the stop's latitude,
-- longitude, address line and access notes, with an empty parcel list. The
-- same happened when a failed stop on a completed route was re-attempted by
-- another driver. A route-level check cannot express "authorized to handle
-- this shipment"; only the parcel's own scope (`shipments.last_driver_id`,
-- 0045) can.
--
-- The rule: for a driver session, a stop is visible when its route is (0047)
-- AND, if it serves any leg, at least one of those legs is visible. Legs are
-- narrowed by their shipment (0045), so this is exactly "the driver may see one
-- of the parcels delivered or collected here". A stop with no legs (HUB_LOAD,
-- HUB_UNLOAD, BREAK) carries a hub or nothing, never a recipient, and stays
-- visible on the driver's own route.
--
-- 0047 is applied and checksum-locked, so its policy is replaced here rather
-- than edited there. Non-driver sessions are unaffected: the CASE is TRUE.

DROP POLICY IF EXISTS route_stops_isolation ON route_stops;
CREATE POLICY route_stops_isolation ON route_stops
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM routes r WHERE r.id = route_stops.route_id)
                  AND (cardinality(route_stops.leg_ids) = 0
                       OR EXISTS (SELECT 1 FROM shipment_legs l
                                   WHERE l.id = ANY (route_stops.leg_ids)))
             ELSE TRUE END
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND CASE WHEN current_driver_scoped()
             THEN EXISTS (SELECT 1 FROM routes r WHERE r.id = route_stops.route_id)
                  AND (cardinality(route_stops.leg_ids) = 0
                       OR EXISTS (SELECT 1 FROM shipment_legs l
                                   WHERE l.id = ANY (route_stops.leg_ids)))
             ELSE TRUE END
  );
