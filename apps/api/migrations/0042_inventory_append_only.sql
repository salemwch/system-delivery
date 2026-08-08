-- ⚠️ THE MOVEMENT LOG WAS NOT ACTUALLY APPEND-ONLY.
--
-- Migration 0041 wrote `GRANT SELECT, INSERT ON inventory_movements TO dp_app`
-- and a comment claiming the log could not be rewritten. It could: a narrower
-- GRANT does not take a privilege away.
--
-- `ALTER DEFAULT PRIVILEGES FOR ROLE dp_migrator IN SCHEMA public GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO dp_app` (infra/docker/initdb/02-roles.sql)
-- applies to every table the migrator creates, INCLUDING ONES CREATED LATER. By
-- the time 0041's GRANT ran, dp_app already held UPDATE and DELETE, and granting
-- a subset of what a role already has is a no-op.
--
-- Found by the test asserting the restriction, which is the only reason it is
-- not still true: the migration read correctly and the database disagreed.
--
-- The remedy is REVOKE, as `otp_codes` (0024) and `ledger_entries` already do.
-- Restrictions in this schema are ALWAYS a REVOKE.

REVOKE UPDATE, DELETE, TRUNCATE ON inventory_movements FROM dp_app;

-- The items table keeps UPDATE — an item is renamed and retired, which is
-- ordinary — but never DELETE: past movements reference it, and removing one
-- would orphan a year of stock history.
REVOKE DELETE, TRUNCATE ON inventory_items FROM dp_app;

COMMENT ON TABLE inventory_movements IS
  'Append-only stock movements — enforced by REVOKE, not by the GRANT in 0041 '
  'which was a no-op against ALTER DEFAULT PRIVILEGES. Quantity is always '
  'positive; direction carries the sign. Corrected by a STOCKTAKE, never an UPDATE.';
