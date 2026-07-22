-- Runs once, on first container start, against the POSTGRES_DB database.
-- Production gets the same extensions via Terraform + migrations, not via this file.

-- TimescaleDB: driver_positions hypertable (docs/06-database-design.md §5)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- PostGIS: geography columns, geofence evaluation, nearest-driver queries
CREATE EXTENSION IF NOT EXISTS postgis;

-- Argon2id hashing is done in the application, but pgcrypto gives us
-- gen_random_bytes() for token generation and digest() for content hashes.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Query performance visibility from day one (docs/06-database-design.md §11).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Trigram index support for shipment reference / recipient name search.
-- Postgres FTS is sufficient until ~10M rows; OpenSearch is deferred.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- NOTE: PostgreSQL 18 provides uuidv7() natively, so we do NOT need the
-- pg_uuidv7 extension. All external identifiers use uuidv7() —
-- time-ordered, index-friendly, and non-enumerable.
DO $$
BEGIN
  PERFORM uuidv7();
  RAISE NOTICE 'uuidv7() available natively (PostgreSQL 18+)';
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION 'uuidv7() missing — PostgreSQL 18+ is required. Check the image tag.';
END
$$;
