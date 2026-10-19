-- Driver scope extended to shifts (invariant I28; V5 of the 9318622 release
-- review).
--
-- ⚠️ THE GAP THIS CLOSES. `shifts` kept the tenant-only policy from 0008, and
-- ShiftService took `driverId` from the request body on start and accepted any
-- shift id on end and get. Any driver could open a colleague's shift, which
-- switches on location collection for them (off-shift tracking, against domain
-- §3.3 rule 4 and docs/07 §11.2); end it, which switches it off and declares
-- their closing cash (a denial of service and a false cash record); and read
-- its opening and closing cash, odometer, vehicle and hub.
--
-- The service now refuses a colleague's `driverId` on start (403) and checks
-- ownership after every fetch (404). This policy is the structural half:
-- whatever endpoint reads or writes shifts later, a driver session sees and
-- writes only rows whose `driver_id` is its own `app.current_driver_id`.
-- Non-driver sessions (staff, workers, the relay) are unaffected: the
-- predicate is TRUE without the setting. A DRIVER login with no driver record
-- carries NO_DRIVER and sees nothing (fail closed).
--
-- The telemetry gate (ShiftService.openShiftForUser) reads the caller's OWN
-- shift under the caller's own scope, so it is unaffected.
--
-- The one-open-shift indexes (I7, I9) are unique indexes, and uniqueness is
-- not filtered by RLS: a second OPEN shift is still refused whoever's row the
-- first one is.

CREATE OR REPLACE FUNCTION current_driver_allows_shift(row_driver_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_driver_id', true), '') = '' THEN TRUE
    ELSE row_driver_id = NULLIF(current_setting('app.current_driver_id', true), '')::uuid
  END;
$$;

COMMENT ON FUNCTION current_driver_allows_shift(UUID) IS
  'Invariant I28. True for non-driver sessions, or when the shift is the session '
  'driver''s own.';

DROP POLICY IF EXISTS shifts_isolation ON shifts;
CREATE POLICY shifts_isolation ON shifts
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_driver_allows_shift(driver_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_driver_allows_shift(driver_id)
  );
