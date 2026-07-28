-- Pickup requests (docs/02-domain-model.md §3.18, docs/01-mvp-scope.md §4.2 #2.11).
--
-- How parcels actually enter the system: a Merchant asks the Tenant to collect.
-- The lifecycle is strictly ordered (REQUESTED → ACCEPTED → ASSIGNED → COLLECTED
-- → COMPLETED), with CANCELLED branching from any pre-COLLECTED state. Invariant
-- I21 forbids cancellation after custody transfer.
--
-- This table is tenant-scoped with ENABLE + FORCE RLS like every other data table.

CREATE TABLE IF NOT EXISTS pickup_requests (
  id                     UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id              UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Human-readable, scannable reference: PR-YYYYMMDD-NNN. Unique per tenant.
  code                   TEXT NOT NULL,

  merchant_id            UUID NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'REQUESTED',

  -- Where to collect and who to call on arrival.
  pickup_address_id      UUID NOT NULL,
  contact_name           TEXT NOT NULL,
  contact_phone          TEXT NOT NULL,

  -- Merchant's preferred pickup window.
  requested_window_from  TIMESTAMPTZ NOT NULL,
  requested_window_to    TIMESTAMPTZ NOT NULL,

  -- Parcel counts: estimated by merchant, actual recorded by driver at collection.
  estimated_parcel_count INT NOT NULL,
  actual_parcel_count    INT,

  -- Request tracking.
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by_user_id   UUID NOT NULL,

  -- Acceptance tracking.
  accepted_at            TIMESTAMPTZ,
  accepted_by_user_id    UUID,

  -- Assignment.
  assigned_driver_id     UUID,
  assigned_route_stop_id UUID,
  assigned_at            TIMESTAMPTZ,

  -- Collection = custody transfer moment.
  collected_at           TIMESTAMPTZ,

  -- Completion = all parcels registered as shipments.
  completed_at           TIMESTAMPTZ,

  -- Cancellation (forbidden after COLLECTED per invariant I21).
  cancelled_at           TIMESTAMPTZ,
  cancellation_reason    TEXT,

  notes                  TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- requestedWindowTo must be after requestedWindowFrom (domain rule 6).
  CONSTRAINT pickup_window_order CHECK (requested_window_to > requested_window_from),

  -- Status must be one of the defined lifecycle states.
  CONSTRAINT pickup_status_check CHECK (
    status IN ('REQUESTED', 'ACCEPTED', 'ASSIGNED', 'COLLECTED', 'COMPLETED', 'CANCELLED')
  )
);

-- Unique code per tenant — the primary lookup key for scanning/searching.
CREATE UNIQUE INDEX IF NOT EXISTS pickup_requests_tenant_code_uq
  ON pickup_requests (tenant_id, code);

-- Filter by status within a tenant — the dispatcher's most common query.
CREATE INDEX IF NOT EXISTS pickup_requests_tenant_status_idx
  ON pickup_requests (tenant_id, status);

-- Per-merchant listings and analytics.
CREATE INDEX IF NOT EXISTS pickup_requests_tenant_merchant_idx
  ON pickup_requests (tenant_id, merchant_id);

-- Driver workload queries.
CREATE INDEX IF NOT EXISTS pickup_requests_driver_idx
  ON pickup_requests (assigned_driver_id)
  WHERE assigned_driver_id IS NOT NULL;

-- Window-based scheduling queries (dispatcher board: "what's due today?").
CREATE INDEX IF NOT EXISTS pickup_requests_tenant_window_idx
  ON pickup_requests (tenant_id, requested_window_from, requested_window_to);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security — ENABLE + FORCE like every other data table.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE pickup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pickup_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY pickup_requests_tenant_isolation ON pickup_requests
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- dp_app: SELECT, INSERT, UPDATE. No DELETE — pickup requests are auditable.
GRANT SELECT, INSERT, UPDATE ON pickup_requests TO dp_app;

-- dp_migrator owns the table (implicit via CREATE TABLE).
