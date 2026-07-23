-- Role separation for Row-Level Security.
--
-- This is the single most security-critical piece of database setup in the
-- platform (docs/07-security-architecture.md §5). Two roles, deliberately:
--
--   dp_migrator — owns the schema, runs migrations. Elevated.
--   dp_app      — what the application connects as. NO BYPASSRLS, NOT the
--                 table owner. Cannot escape a row-level security policy even
--                 if the ORM emits a query with no tenant filter.
--
-- Getting this wrong means RLS silently does nothing: a table owner bypasses
-- RLS unless FORCE ROW LEVEL SECURITY is set, and a role with BYPASSRLS
-- ignores it entirely. We use both belts and both braces.

\set app_password `echo "${APP_DB_PASSWORD:-app_dev_password}"`
\set migrator_password `echo "${MIGRATOR_DB_PASSWORD:-migrator_dev_password}"`
\set relay_password `echo "${RELAY_DB_PASSWORD:-relay_dev_password}"`

-- Migration role: owns everything, runs DDL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dp_migrator') THEN
    CREATE ROLE dp_migrator LOGIN;
  END IF;
END
$$;
ALTER ROLE dp_migrator PASSWORD :'migrator_password';

-- Application role: least privilege, RLS-bound.
-- NOBYPASSRLS is the default, but we state it explicitly because the whole
-- tenant-isolation model depends on it and it must be obvious to a reader.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dp_app') THEN
    CREATE ROLE dp_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
ALTER ROLE dp_app PASSWORD :'app_password';
ALTER ROLE dp_app NOBYPASSRLS;

-- Outbox-relay role: least privilege, but cross-tenant on ONE table.
-- The relay must read every tenant's outbox rows (it is a control-plane process,
-- not a request-path one), yet must NOT be able to touch any other table or run
-- DDL. It is NOT the schema owner and does NOT have BYPASSRLS. Its only reach is
-- granted explicitly in migration 0004: SELECT+UPDATE on `outbox` plus a
-- permissive RLS policy scoped to that table alone. Blast radius if the relay
-- process is compromised: read/mark-published the outbox — nothing else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dp_relay') THEN
    CREATE ROLE dp_relay LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
ALTER ROLE dp_relay PASSWORD :'relay_password';
ALTER ROLE dp_relay NOBYPASSRLS;

-- Schema ownership goes to the migrator.
ALTER SCHEMA public OWNER TO dp_migrator;
GRANT USAGE ON SCHEMA public TO dp_app;
GRANT USAGE ON SCHEMA public TO dp_relay;

-- The app gets DML only. No DDL, ever — schema changes go through migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE dp_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dp_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dp_app;

-- Append-only tables (shipment_events, ledger_entries, audit_log) will have
-- UPDATE and DELETE revoked individually in their migrations. Immutability is
-- enforced by the database, not by developer discipline.

-- Statement timeout: a runaway analytical query must not hold the app pool.
-- Production values are set per-role in Terraform.
ALTER ROLE dp_app SET statement_timeout = '30s';
ALTER ROLE dp_app SET idle_in_transaction_session_timeout = '60s';

-- The relay holds a transaction across a Valkey publish; the SQL statements
-- themselves are tiny. This bounds a pathological claim/update, while the Valkey
-- side is bounded separately by VALKEY_COMMAND_TIMEOUT_MS in the app.
ALTER ROLE dp_relay SET statement_timeout = '30s';
ALTER ROLE dp_relay SET idle_in_transaction_session_timeout = '60s';

-- Tenant context default. Any query that runs WITHOUT the request interceptor
-- setting SET LOCAL app.current_tenant_id will match zero rows rather than all
-- rows — fail-closed. Verified by an RLS regression test in CI.
ALTER ROLE dp_app SET app.current_tenant_id = '00000000-0000-0000-0000-000000000000';
