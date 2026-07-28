-- Manifests — the custody handover record (docs/02-domain-model.md §3.11,
-- docs/01-mvp-scope.md §4.3 #3.2, docs/04-context-map.md §3.8).
--
-- A sealed set of shipments transferred together between custody holders:
-- hub→hub linehaul, hub→driver dispatch, driver→hub return, and intra-hub
-- transfer. This is what makes AT_HUB and IN_TRANSIT reachable — before this
-- migration the shipment state machine had both statuses with no command able
-- to produce them.
--
-- Custody transfers at RECEIPT, not at seal (§3.11 rule 5): the sender remains
-- responsible while the parcels are in transit.

-- ─────────────────────────────────────────────────────────────────────────────
-- manifests
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manifests (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Scannable reference, hub-aware: MF-<HUBCODE>-YYYYMMDD-NNN. The ordinal is
  -- per hub per day, so two hubs sealing at the same instant never contend.
  code                 TEXT NOT NULL,

  type                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'OPEN',

  from_hub_id          UUID REFERENCES hubs (id),
  to_hub_id            UUID REFERENCES hubs (id),
  from_driver_id       UUID,
  to_driver_id         UUID,
  vehicle_id           UUID,

  item_count           INT NOT NULL DEFAULT 0,
  discrepancy_count    INT NOT NULL DEFAULT 0,

  sealed_at            TIMESTAMPTZ,
  sealed_by_user_id    UUID,
  dispatched_at        TIMESTAMPTZ,
  received_at          TIMESTAMPTZ,
  received_by_user_id  UUID,
  reconciled_at        TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id   UUID NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT manifests_tenant_code_uq UNIQUE (tenant_id, code),

  CONSTRAINT manifests_type_chk
    CHECK (type IN ('LINEHAUL', 'DISPATCH', 'RETURN', 'TRANSFER')),

  CONSTRAINT manifests_status_chk
    CHECK (status IN ('OPEN', 'SEALED', 'IN_TRANSIT', 'RECEIVED', 'RECONCILED')),

  -- Endpoints per type, so an incoherent handover is not representable at all.
  --   LINEHAUL  hub  → hub     (inter-hub trunk movement)
  --   DISPATCH  hub  → driver  (last-mile handover)
  --   RETURN    driver → hub   (undelivered parcels coming back)
  --   TRANSFER  hub  → hub?    (intra-facility / ad-hoc move; destination optional)
  CONSTRAINT manifests_endpoints_chk CHECK (
    (type = 'LINEHAUL' AND from_hub_id IS NOT NULL AND to_hub_id IS NOT NULL)
    OR (type = 'DISPATCH' AND from_hub_id IS NOT NULL AND to_driver_id IS NOT NULL)
    OR (type = 'RETURN' AND from_driver_id IS NOT NULL AND to_hub_id IS NOT NULL)
    OR (type = 'TRANSFER' AND from_hub_id IS NOT NULL)
  ),

  -- A manifest never points at itself.
  CONSTRAINT manifests_distinct_hubs_chk
    CHECK (from_hub_id IS NULL OR to_hub_id IS NULL OR from_hub_id <> to_hub_id)
);

CREATE INDEX IF NOT EXISTS manifests_tenant_status_idx
  ON manifests (tenant_id, status);

CREATE INDEX IF NOT EXISTS manifests_from_hub_idx
  ON manifests (tenant_id, from_hub_id)
  WHERE from_hub_id IS NOT NULL;

-- "What is inbound to my hub?" — the destination hub's working queue.
CREATE INDEX IF NOT EXISTS manifests_to_hub_idx
  ON manifests (tenant_id, to_hub_id, status)
  WHERE to_hub_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- manifest_items
--
-- tracking_number is denormalised at add time so a receipt scan is an index
-- probe inside this module, with no cross-module read on the scanning path.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manifest_items (
  id                   UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  manifest_id          UUID NOT NULL REFERENCES manifests (id),
  shipment_id          UUID NOT NULL,
  leg_id               UUID,
  tracking_number      TEXT NOT NULL,

  -- EXPECTED → SCANNED at receipt. A parcel that never arrives stays EXPECTED
  -- and becomes a MISSING row in manifest_discrepancies at finalisation.
  scan_status          TEXT NOT NULL DEFAULT 'EXPECTED',
  scanned_at           TIMESTAMPTZ,          -- device clock (offline-capable)
  recorded_at          TIMESTAMPTZ,          -- server clock
  scanned_by_user_id   UUID,
  idempotency_key      TEXT,                 -- per-scan dedup for offline replay

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT manifest_items_manifest_shipment_uq UNIQUE (manifest_id, shipment_id),
  CONSTRAINT manifest_items_idempotency_uq UNIQUE (manifest_id, idempotency_key),
  CONSTRAINT manifest_items_scan_status_chk
    CHECK (scan_status IN ('EXPECTED', 'SCANNED'))
);

CREATE INDEX IF NOT EXISTS manifest_items_manifest_idx
  ON manifest_items (tenant_id, manifest_id);

CREATE INDEX IF NOT EXISTS manifest_items_shipment_idx
  ON manifest_items (tenant_id, shipment_id);

-- Barcode lookup on the receipt-scan path.
CREATE INDEX IF NOT EXISTS manifest_items_tracking_idx
  ON manifest_items (tenant_id, manifest_id, tracking_number);

-- ─────────────────────────────────────────────────────────────────────────────
-- manifest_discrepancies
--
-- Deliberately a separate table rather than columns on manifest_items. An
-- UNEXPECTED parcel — one that arrived without being on the manifest — has no
-- item row and cannot be given one: the immutability trigger below blocks any
-- INSERT after seal, and §3.11 rule 1 says a sealed manifest's contents never
-- change. A discrepancy is a different fact from the contents, so it gets its
-- own record.
--
-- This is also where the deferred liability workflow will attach. Hotspot H2
-- ("who is accountable for a missing parcel — origin, transport, or
-- destination?") is explicitly a policy decision for S2, so nothing here
-- assigns blame or money.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manifest_discrepancies (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  manifest_id           UUID NOT NULL REFERENCES manifests (id),

  kind                  TEXT NOT NULL,
  -- Null when an unexpected barcode cannot be resolved to a known shipment.
  shipment_id           UUID,
  -- Always present: the physical thing in the operator's hand.
  tracking_number       TEXT NOT NULL,

  raised_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  raised_by_user_id     UUID NOT NULL,

  resolution_reason     TEXT,
  resolved_at           TIMESTAMPTZ,
  resolved_by_user_id   UUID,

  CONSTRAINT manifest_discrepancies_kind_chk
    CHECK (kind IN ('MISSING', 'UNEXPECTED')),

  -- Re-running finaliseReceipt must not duplicate rows.
  CONSTRAINT manifest_discrepancies_manifest_tracking_uq
    UNIQUE (manifest_id, tracking_number),

  -- A resolution is reason + actor + time, or none of the three. Half a
  -- resolution is not auditable.
  CONSTRAINT manifest_discrepancies_resolution_chk CHECK (
    (resolution_reason IS NULL AND resolved_at IS NULL AND resolved_by_user_id IS NULL)
    OR (resolution_reason IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS manifest_discrepancies_manifest_idx
  ON manifest_discrepancies (tenant_id, manifest_id);

-- The exception queue: "what is still unresolved?"
CREATE INDEX IF NOT EXISTS manifest_discrepancies_open_idx
  ON manifest_discrepancies (tenant_id, manifest_id)
  WHERE resolved_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariant I14 — manifest contents are unchanged after SEALED.
--
-- Enforced here as well as in the domain service, exactly as §6 specifies
-- ("Domain service + DB trigger"). The service can be bypassed by a migration,
-- a console, or a future code path; the custody chain cannot depend on everyone
-- remembering. Adding a parcel to a sealed manifest breaks the chain — rule 1
-- says a NEW manifest is created instead.
--
-- Guards INSERT and DELETE only. UPDATE is deliberately left free: receipt
-- scanning writes scan_status/scanned_at on a SEALED-or-later manifest, which
-- is not a change of contents. Guarding UPDATE here would make receipt
-- impossible.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION manifest_items_assert_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_id     UUID;
  parent_status TEXT;
BEGIN
  parent_id := COALESCE(NEW.manifest_id, OLD.manifest_id);

  SELECT status INTO parent_status FROM manifests WHERE id = parent_id;

  IF parent_status IS NULL THEN
    -- The parent is gone. On DELETE that is a cascade (the tenant or manifest
    -- above us is being removed) and must be allowed through: refusing here
    -- would make a tenant undeletable. On INSERT it is an orphan, which the
    -- foreign key already rejects — belt and braces.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'manifest % does not exist or is not visible in this tenant', parent_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF parent_status <> 'OPEN' THEN
    RAISE EXCEPTION 'manifest % is %, its contents are immutable (invariant I14)', parent_id, parent_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS manifest_items_immutable_after_seal ON manifest_items;
CREATE TRIGGER manifest_items_immutable_after_seal
  BEFORE INSERT OR DELETE ON manifest_items
  FOR EACH ROW
  EXECUTE FUNCTION manifest_items_assert_open();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security — ENABLE + FORCE like every other data table.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY manifests_tenant_isolation ON manifests
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE manifest_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_items FORCE ROW LEVEL SECURITY;
CREATE POLICY manifest_items_tenant_isolation ON manifest_items
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE manifest_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_discrepancies FORCE ROW LEVEL SECURITY;
CREATE POLICY manifest_discrepancies_tenant_isolation ON manifest_discrepancies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- dp_app: SELECT, INSERT, UPDATE across all three. No DELETE — a custody
-- handover record you can erase is not a custody record. The trigger's DELETE
-- guard is therefore defence in depth, for the migrator and console paths that
-- do hold DELETE.
GRANT SELECT, INSERT, UPDATE ON manifests TO dp_app;
GRANT SELECT, INSERT, UPDATE ON manifest_items TO dp_app;
GRANT SELECT, INSERT, UPDATE ON manifest_discrepancies TO dp_app;
