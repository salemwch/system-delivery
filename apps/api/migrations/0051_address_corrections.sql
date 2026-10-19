-- Driver geocode corrections as recorded facts (docs/01-mvp-scope.md 2.10, P0).
--
-- docs/03-event-storming.md: command `CorrectAddressGeocode` (Driver → Address)
-- emits `address.geocode_corrected`, and is guarded by "moved > 2 km requires
-- dispatcher review". Until now a correction was an UPDATE of the address and
-- nothing else: no record of who moved the pin or from where, no way to hold a
-- large move for review, and no idempotency for the offline app's retries.
--
-- One row per correction a driver submits, whatever happened to it:
--   APPLIED         moved ≤ 2 km (or there was no pin): the address now carries it
--   PENDING_REVIEW  moved > 2 km: the address is untouched until a dispatcher decides
--   APPROVED        a reviewed move, applied by the reviewer
--   REJECTED        a reviewed move, refused; the address never changed
--   SUPERSEDED      observed BEFORE the pin the address already carries. An
--                   offline phone syncing late must never put back an older pin
--                   over a newer one, so it is kept as history and not applied
--
-- The observation itself (where, when, how precise, by whom) is evidence and
-- never changes: only the review columns are writable, and only out of
-- PENDING_REVIEW (trigger below).

-- ── 1. When the current pin was observed ────────────────────────────────────
-- Device time of the correction that set the pin, NULL when no correction ever
-- did (a merchant's or dispatcher's pin). The arbiter of "newer": read under the
-- address row lock, so it does not depend on which corrections the caller's RLS
-- happens to show (a driver sees only their own).
ALTER TABLE addresses ADD COLUMN location_observed_at TIMESTAMPTZ;

COMMENT ON COLUMN addresses.location_observed_at IS
  'Device time of the field correction that set the current pin; NULL when no '
  'correction did. A correction observed earlier is SUPERSEDED, never applied.';

-- ── 2. The correction log ───────────────────────────────────────────────────

CREATE TABLE address_corrections (
  id                   UUID        NOT NULL DEFAULT uuidv7(),
  tenant_id            UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  address_id           UUID        NOT NULL,
  -- Client-generated, so an offline retry is the same correction (I29 shape):
  -- a replay must match the caller and the request, or it is a 422.
  idempotency_key      TEXT        NOT NULL,
  -- SHA-256 (hex) of the canonical validated request, key excluded.
  request_hash         TEXT        NOT NULL,
  corrected_by_user_id UUID        NOT NULL,
  -- The driver record behind the login; NULL when staff (OWNER) corrected.
  driver_id            UUID,
  -- The pin before (NULL: there was none) and the pin the driver observed.
  from_location        GEOGRAPHY(Point, 4326),
  to_location          GEOGRAPHY(Point, 4326) NOT NULL,
  -- Metres between the two; NULL when there was no pin to move.
  distance_moved_m     INTEGER,
  -- Horizontal accuracy the device reported for the fix, when it did.
  accuracy_m           INTEGER,
  confidence_before    NUMERIC(4, 3),
  -- New access notes proposed with the pin, applied together with it.
  access_notes         TEXT,
  status               TEXT        NOT NULL,
  -- Device time (docs/01 §4.7 item 7.5) vs arrival at the server.
  occurred_at          TIMESTAMPTZ NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_user_id  UUID,
  reviewed_at          TIMESTAMPTZ,
  review_note          TEXT,

  PRIMARY KEY (id),
  CONSTRAINT address_corrections_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT address_corrections_tenant_idempotency_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT address_corrections_address_fkey
    FOREIGN KEY (tenant_id, address_id) REFERENCES addresses (tenant_id, id),
  CONSTRAINT address_corrections_corrected_by_fkey
    FOREIGN KEY (tenant_id, corrected_by_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT address_corrections_driver_fkey
    FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  CONSTRAINT address_corrections_reviewed_by_fkey
    FOREIGN KEY (tenant_id, reviewed_by_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT address_corrections_status_chk
    CHECK (status IN ('APPLIED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  CONSTRAINT address_corrections_key_chk CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT address_corrections_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT address_corrections_distance_chk CHECK (distance_moved_m IS NULL OR distance_moved_m >= 0),
  CONSTRAINT address_corrections_accuracy_chk CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  CONSTRAINT address_corrections_notes_chk CHECK (access_notes IS NULL OR length(access_notes) <= 1000),
  CONSTRAINT address_corrections_review_note_chk CHECK (review_note IS NULL OR length(review_note) <= 1000),
  -- A decision names who made it and when; an undecided row names no one. A
  -- SUPERSEDED row may be either: overtaken on arrival, or found overtaken by
  -- the dispatcher who opened it.
  CONSTRAINT address_corrections_review_chk CHECK (
    CASE
      WHEN status IN ('APPROVED', 'REJECTED')
        THEN reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL
      WHEN status IN ('APPLIED', 'PENDING_REVIEW')
        THEN reviewed_by_user_id IS NULL AND reviewed_at IS NULL
      ELSE (reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)
    END
  )
);

-- The review queue, oldest first.
CREATE INDEX address_corrections_pending_idx
  ON address_corrections (tenant_id, recorded_at, id)
  WHERE status = 'PENDING_REVIEW';
-- An address's correction history.
CREATE INDEX address_corrections_address_idx
  ON address_corrections (tenant_id, address_id, occurred_at DESC);
-- A driver's own corrections (RLS probe below).
CREATE INDEX address_corrections_driver_idx
  ON address_corrections (tenant_id, driver_id)
  WHERE driver_id IS NOT NULL;

-- ── 3. Row-level security ───────────────────────────────────────────────────
-- Tenant, and for a driver session their own corrections only (I28): a
-- colleague's correction carries the coordinates of a delivery that is not
-- theirs. Same predicate shape as 0049.

ALTER TABLE address_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE address_corrections FORCE  ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION current_driver_allows_correction(row_driver_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_driver_id', true), '') = '' THEN TRUE
    ELSE row_driver_id IS NOT NULL
         AND row_driver_id = NULLIF(current_setting('app.current_driver_id', true), '')::uuid
  END;
$$;

COMMENT ON FUNCTION current_driver_allows_correction(UUID) IS
  'Invariant I28. True for non-driver sessions, or when the correction is the '
  'session driver''s own.';

CREATE POLICY address_corrections_isolation ON address_corrections
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_driver_allows_correction(driver_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND current_driver_allows_correction(driver_id)
  );

-- ── 4. Grants: the observation is evidence ──────────────────────────────────
-- ALTER DEFAULT PRIVILEGES granted dp_app full DML, and a narrower GRANT
-- revokes nothing (0042), so take UPDATE away and give back only the review
-- columns.
REVOKE UPDATE, DELETE, TRUNCATE ON address_corrections FROM dp_app;
GRANT UPDATE (status, reviewed_by_user_id, reviewed_at, review_note)
  ON address_corrections TO dp_app;

-- ── 5. Only a pending correction is decided, and only once ──────────────────

CREATE OR REPLACE FUNCTION address_corrections_guard_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_REVIEW'
              AND NEW.status IN ('APPROVED', 'REJECTED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'address correction % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status
     AND (NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id
          OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
          OR NEW.review_note IS DISTINCT FROM OLD.review_note) THEN
    RAISE EXCEPTION 'address correction % review is final', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER address_corrections_guard_status
  BEFORE UPDATE ON address_corrections
  FOR EACH ROW EXECUTE FUNCTION address_corrections_guard_status();

COMMENT ON TABLE address_corrections IS
  'Docs/01 2.10. Driver geocode corrections: APPLIED, held for review (> 2 km), '
  'decided, or SUPERSEDED by a newer observation. The observation is immutable.';
