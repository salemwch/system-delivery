-- What the pickup "driver" columns actually hold: a USER id.
--
-- ⚠️ `pickup_requests.assigned_driver_id` and `pickup_shipments.scanned_by_driver_id`
-- are named for drivers, but the person who collects is not always a driver. A
-- commercial claims and collects their own merchants' parcels (0030), and has a
-- login but no `drivers` row. `claim`, every scan, and the web's "assigned to
-- you" all compared these columns with the caller's USER id. `assign` alone
-- stored a `drivers.id`, so one column held two kinds of id: a driver dispatch
-- had assigned could not be matched as the collector of their own run.
--
-- The application now stores the collector's user id everywhere (`assign`
-- resolves the chosen driver to `drivers.user_id`), and only that user may scan
-- or close the run. The driver id the custody ledger needs travels separately
-- on `pickup.parcel_scanned`.
--
-- Comments only. No data changes: on a deployed database a pickup `assign`ed
-- before this release may hold a `drivers.id`, and it is cheaper and safer to
-- have dispatch re-assign an open run than to guess which kind of id each row
-- holds. Renaming the columns is a breaking API change (`assignedDriverId`) and
-- is not done here.

COMMENT ON COLUMN pickup_requests.assigned_driver_id IS
  'The assigned collector''s USER id (users.id), despite the name: a driver''s login '
  'or a commercial''s. Only this user may scan or collect the run. No FK to drivers.';

COMMENT ON COLUMN pickup_shipments.scanned_by_driver_id IS
  'The USER id (users.id) of the collector who scanned this parcel, despite the name. '
  'Equal to pickup_requests.assigned_driver_id for every scan accepted after 0044.';
