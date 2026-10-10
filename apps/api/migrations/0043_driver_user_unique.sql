-- One login, one driver (invariant I26).
--
-- ⚠️ WHY THIS EXISTS. Delivery, failed-attempt and return commands used to take
-- `driverId` from the REQUEST BODY. Any account holding `shipment:deliver` could
-- name any driver in the tenant — mark a colleague's parcel delivered, and book
-- the collected COD to that colleague's DRIVER_CASH account. The zero-variance
-- cash reconciliation the MVP is judged on (docs/01-mvp-scope.md §9.1) is
-- meaningless if the ledger can be told whose satchel the money is in.
--
-- The commands now resolve the driver from the authenticated user instead:
-- `select id from drivers where user_id = <token sub>`. That lookup is only an
-- identity if it can match at most ONE row. `drivers.user_id` carried a foreign
-- key (0036) but no uniqueness, so two driver records could share a login — and
-- which one a delivery was booked to would depend on scan order.
--
-- Composite on (tenant_id, user_id) to match the composite FK from 0036 and the
-- RLS tenant predicate the lookup always runs under. NULLs stay distinct (the
-- default), so any number of drivers may still have no login yet.
--
-- Not CONCURRENTLY: the migrator wraps each file in a transaction, and
-- `drivers` is one row per courier — tens to low hundreds per tenant.

-- Fail with a message that names the problem rather than a bare 23505, so
-- whoever runs this against a database that already holds a shared login knows
-- exactly which rows to untangle. FORCE RLS binds dp_migrator too, so the check
-- reads through a NO FORCE window, exactly as data back-fills do.
ALTER TABLE drivers NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  duplicates TEXT;
BEGIN
  SELECT string_agg(format('tenant %s user %s (%s drivers)', tenant_id, user_id, n), '; ')
    INTO duplicates
    FROM (
      SELECT tenant_id, user_id, count(*) AS n
        FROM drivers
       WHERE user_id IS NOT NULL
       GROUP BY tenant_id, user_id
      HAVING count(*) > 1
    ) shared;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'drivers share a login; unlink all but one before applying 0043: %', duplicates;
  END IF;
END
$$;

CREATE UNIQUE INDEX drivers_tenant_user_uq ON drivers (tenant_id, user_id);

ALTER TABLE drivers FORCE ROW LEVEL SECURITY;

COMMENT ON INDEX drivers_tenant_user_uq IS
  'Invariant I26. A login is at most one driver, so the driver a delivery is booked '
  'to is resolved from the token, never from the request body.';
