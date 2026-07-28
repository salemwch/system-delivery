-- Pickup-shipment link table with scan-level tracking
-- (docs/02-domain-model.md §3.18 "produces 0..n Shipment").
--
-- Redesigns pickup from count-based to scan-based: every parcel is individually
-- scanned, validated against expected shipments, and custody-transferred per
-- shipment through the shipment_events pipeline.
--
-- Also extends pickup_requests with selection mode (EXPLICIT vs MERCHANT_READY)
-- and outcome tracking for zero-parcel pickups.

-- ── pickup_requests schema additions ────────────────────────────────────────

ALTER TABLE pickup_requests
  ADD COLUMN IF NOT EXISTS selection_mode TEXT NOT NULL DEFAULT 'EXPLICIT',
  ADD COLUMN IF NOT EXISTS outcome_reason TEXT;

ALTER TABLE pickup_requests
  ADD CONSTRAINT pickup_selection_mode_check
    CHECK (selection_mode IN ('EXPLICIT', 'MERCHANT_READY'));

ALTER TABLE pickup_requests
  ADD CONSTRAINT pickup_outcome_reason_check
    CHECK (outcome_reason IS NULL OR outcome_reason IN (
      'MERCHANT_NOT_READY',
      'NO_PARCELS_AVAILABLE',
      'MERCHANT_CANCELLED',
      'ADDRESS_ISSUE',
      'DRIVER_FAILED'
    ));

-- ── pickup_shipments table ──────────────────────────────────────────────────
--
-- Owned by the pickup module. The shipment_id is a cross-module reference
-- validated at write time via raw SQL (same pattern as merchant validation).
-- tracking_number is denormalized at link time so scan lookups stay local.

CREATE TABLE IF NOT EXISTS pickup_shipments (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  pickup_request_id    UUID NOT NULL REFERENCES pickup_requests (id),
  shipment_id          UUID NOT NULL,
  tracking_number      TEXT NOT NULL,

  -- Scan lifecycle: EXPECTED → SCANNED (driver scanned) or MISSING (unscanned at collect).
  scan_status          TEXT NOT NULL DEFAULT 'EXPECTED',
  scanned_at           TIMESTAMPTZ,          -- device time (offline-capable)
  recorded_at          TIMESTAMPTZ,          -- server receipt time
  scanned_by_driver_id UUID,
  idempotency_key      TEXT,                 -- per-scan dedup for offline replay

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Each shipment appears at most once per pickup.
  CONSTRAINT pickup_shipments_pickup_shipment_uq
    UNIQUE (pickup_request_id, shipment_id),

  -- Idempotency key unique within a pickup (prevents duplicate offline scans).
  CONSTRAINT pickup_shipments_idempotency_uq
    UNIQUE (pickup_request_id, idempotency_key),

  -- Scan status must be one of the defined values.
  CONSTRAINT pickup_shipments_scan_status_check
    CHECK (scan_status IN ('EXPECTED', 'SCANNED', 'MISSING'))
);

-- Fast lookups by pickup request.
CREATE INDEX IF NOT EXISTS pickup_shipments_pickup_idx
  ON pickup_shipments (tenant_id, pickup_request_id);

-- Reverse lookup: "which pickup is this shipment in?"
CREATE INDEX IF NOT EXISTS pickup_shipments_shipment_idx
  ON pickup_shipments (tenant_id, shipment_id);

-- Tracking number lookup for barcode scan validation.
CREATE INDEX IF NOT EXISTS pickup_shipments_tracking_idx
  ON pickup_shipments (tenant_id, pickup_request_id, tracking_number);

-- ── Row-Level Security ──────────────────────────────────────────────────────
ALTER TABLE pickup_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pickup_shipments FORCE ROW LEVEL SECURITY;

CREATE POLICY pickup_shipments_tenant_isolation ON pickup_shipments
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- dp_app: SELECT, INSERT, UPDATE. No DELETE — scan records are auditable.
GRANT SELECT, INSERT, UPDATE ON pickup_shipments TO dp_app;
