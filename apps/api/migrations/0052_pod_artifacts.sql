-- POD media: photos and signatures uploaded straight to object storage
-- (docs/01-mvp-scope.md 4.5, docs/05 POST /v1/media/presign, docs/07 §7.1).
--
-- ⚠️ THE GAP THIS CLOSES. `pod.signature_object_key` and `pod.photo_object_keys`
-- accepted ANY string. Nothing issued keys, so a POD could cite an object that
-- never existed, one uploaded for another parcel, or another tenant's key, and
-- the "proof" would be a dangling or borrowed reference. A key is now something
-- the server ISSUED, for one shipment, and then verified.
--
-- One row per upload slot the server issues. Lifecycle:
--   PENDING_UPLOAD  key issued with a presigned PUT; the phone has not finished
--   PENDING_SCAN    bytes verified (type by magic number, size, no EXIF block),
--                   SHA-256 recorded; awaiting the malware scan
--   AVAILABLE       scanned clean; may be shown to staff
--   REJECTED        failed verification or the scan; never shown. The driver
--                   captures again under a new slot.
--
-- The malware scan is a deliberate deferral (decision 2026-10-19, recorded in
-- docs/07 §7.1): only JPEG/PNG with verified bytes are accepted, nothing is
-- executed or publicly served, and the scanner is a port whose MVP binding is
-- a pass-through recorded as `scanned_by = 'none'`, so every artifact scanned
-- by it is identifiable once a real engine is bound.

CREATE TABLE pod_artifacts (
  id                  UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  shipment_id         UUID        NOT NULL,
  uploaded_by_user_id UUID        NOT NULL,
  -- The driver record behind the login; NULL when staff (OWNER) uploaded.
  driver_id           UUID,
  purpose             TEXT        NOT NULL,
  object_key          TEXT        NOT NULL,
  content_type        TEXT        NOT NULL,
  -- Declared at presign and signed into the URL; verified against the object.
  size_bytes          INTEGER     NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'PENDING_UPLOAD',
  rejection_reason    TEXT,
  -- Tamper evidence: SHA-256 of the bytes as verified.
  sha256              TEXT,
  -- Which engine scanned it; 'none' is the MVP pass-through.
  scanned_by          TEXT,
  idempotency_key     TEXT        NOT NULL,
  request_hash        TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at         TIMESTAMPTZ,

  CONSTRAINT pod_artifacts_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT pod_artifacts_tenant_idempotency_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT pod_artifacts_tenant_object_key_uq UNIQUE (tenant_id, object_key),
  CONSTRAINT pod_artifacts_shipment_fkey
    FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT pod_artifacts_uploaded_by_fkey
    FOREIGN KEY (tenant_id, uploaded_by_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT pod_artifacts_driver_fkey
    FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  CONSTRAINT pod_artifacts_purpose_chk CHECK (purpose IN ('POD_PHOTO', 'POD_SIGNATURE')),
  CONSTRAINT pod_artifacts_content_type_chk CHECK (content_type IN ('image/jpeg', 'image/png')),
  -- 10 MB, docs/07 §7.1.
  CONSTRAINT pod_artifacts_size_chk CHECK (size_bytes BETWEEN 1 AND 10485760),
  CONSTRAINT pod_artifacts_status_chk
    CHECK (status IN ('PENDING_UPLOAD', 'PENDING_SCAN', 'AVAILABLE', 'REJECTED')),
  CONSTRAINT pod_artifacts_rejection_chk CHECK (
    (status = 'REJECTED') = (rejection_reason IS NOT NULL)
    AND (rejection_reason IS NULL
         OR rejection_reason IN ('SIZE_MISMATCH', 'TYPE_MISMATCH', 'EXIF_PRESENT', 'MALWARE'))
  ),
  -- Verified means hashed and dated; unverified means neither.
  CONSTRAINT pod_artifacts_verified_chk CHECK (
    CASE
      WHEN status IN ('PENDING_SCAN', 'AVAILABLE') THEN sha256 IS NOT NULL AND verified_at IS NOT NULL
      WHEN status = 'PENDING_UPLOAD' THEN sha256 IS NULL AND verified_at IS NULL
      ELSE TRUE
    END
  ),
  CONSTRAINT pod_artifacts_scanned_chk CHECK ((status = 'AVAILABLE') <= (scanned_by IS NOT NULL)),
  CONSTRAINT pod_artifacts_sha256_chk CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pod_artifacts_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT pod_artifacts_key_chk CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  -- The key names its tenant and shipment, so the storage prefix the presigned
  -- URL is scoped to (docs/07 §4) is enforced here, not only by the code
  -- that builds it.
  CONSTRAINT pod_artifacts_object_key_chk CHECK (
    object_key LIKE 'tenant/' || tenant_id::text || '/pod/' || shipment_id::text || '/%'
  )
);

CREATE INDEX pod_artifacts_shipment_idx ON pod_artifacts (tenant_id, shipment_id);

-- ── Row-level security ──────────────────────────────────────────────────────
-- A child of `shipments`: visible exactly when the parent is. The EXISTS runs
-- under the parent's own policy, so every sub-tenant scope (driver I28,
-- merchant I24, commercial I25) applies without being restated here.

ALTER TABLE pod_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pod_artifacts FORCE  ROW LEVEL SECURITY;

CREATE POLICY pod_artifacts_isolation ON pod_artifacts
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM shipments s
                 WHERE s.tenant_id = pod_artifacts.tenant_id
                   AND s.id = pod_artifacts.shipment_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM shipments s
                 WHERE s.tenant_id = pod_artifacts.tenant_id
                   AND s.id = pod_artifacts.shipment_id)
  );

-- ── Grants: the slot and its evidence are immutable ─────────────────────────
-- A narrower GRANT revokes nothing (0042): take UPDATE away, give back only the
-- verification columns. No DELETE: retention is a separate, audited job.
REVOKE UPDATE, DELETE, TRUNCATE ON pod_artifacts FROM dp_app;
GRANT UPDATE (status, rejection_reason, sha256, scanned_by, verified_at)
  ON pod_artifacts TO dp_app;

-- ── Forward-only lifecycle ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pod_artifacts_guard_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING_UPLOAD' AND NEW.status IN ('PENDING_SCAN', 'REJECTED'))
    OR (OLD.status = 'PENDING_SCAN'   AND NEW.status IN ('AVAILABLE', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'pod artifact % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'pod artifact % hash is final', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pod_artifacts_guard_status
  BEFORE UPDATE ON pod_artifacts
  FOR EACH ROW EXECUTE FUNCTION pod_artifacts_guard_status();

COMMENT ON TABLE pod_artifacts IS
  'POD photos and signatures issued by POST /v1/media/presign. Key scoped to '
  'tenant/{tenant}/pod/{shipment}/; verified by magic bytes, size and EXIF absence; '
  'malware scan pending a real engine (scanned_by = none).';
