-- Modification Colis — a request to change a parcel already in the system.
--
-- The merchant typed the phone number wrong, the customer moved, the price
-- changed. Today there is no way to fix any of it: `shipment:update` exists as a
-- permission and nothing implements it, so the only remedy is cancel-and-recreate
-- — which loses the tracking number the customer already has and the custody
-- chain behind it.
--
-- ── Why a request, and not just an UPDATE ───────────────────────────────────
--
-- Because the person who wants the change is usually not the person who should
-- decide it. A merchant asking to lower the COD on a parcel already out with a
-- driver is asking the courier to collect less cash than the manifest says; a
-- merchant changing the delivery address is asking for a different journey than
-- the one that was routed. Both are reasonable, and both are decisions.
--
-- The exception is the operator who could make the change directly anyway: when
-- the requester holds the approve permission the request is applied on the spot.
-- The row still records who asked and who decided — the same person, which is
-- exactly what the trail should say.

CREATE TABLE IF NOT EXISTS shipment_amendments (
  id                    UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  shipment_id           UUID        NOT NULL,
  requested_by_user_id  UUID        NOT NULL,

  -- PENDING | APPLIED | REJECTED.
  status                TEXT        NOT NULL DEFAULT 'PENDING',

  -- Why the change is wanted. Free text from the requester, shown to whoever
  -- decides — "client a déménagé" is the difference between an approval and a
  -- refusal.
  reason                TEXT,

  -- ── The requested values ──────────────────────────────────────────────────
  -- NULL means "leave this field alone". At least one must be set, or the row
  -- is a request for nothing.
  --
  -- Deliberately typed columns rather than a JSONB patch: a patch cannot be
  -- CHECK-constrained, cannot be indexed, and turns "what did they ask to
  -- change?" into a question only the application can answer.
  recipient_name        TEXT,
  recipient_phone       TEXT,
  recipient_phone_alt   TEXT,
  -- The address as the requester typed it. Geocoded when the amendment is
  -- APPLIED, not when it is requested: an address that is never approved must
  -- not consume a geocoding call, and the courier's provider bills per lookup.
  destination_raw_input TEXT,
  destination_city      TEXT,
  cod_amount_minor      BIGINT,

  -- ── The decision ──────────────────────────────────────────────────────────
  -- What the shipment held before the change, captured when it is applied. The
  -- shipment row itself only ever shows the current value; without this, "the
  -- driver called the wrong number" has no answer six weeks later.
  previous              JSONB,
  decided_at            TIMESTAMPTZ,
  decided_by_user_id    UUID,
  decision_reason       TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite, per 0036: a foreign key check bypasses RLS.
  FOREIGN KEY (tenant_id, shipment_id)          REFERENCES shipments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, requested_by_user_id) REFERENCES users     (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by_user_id)   REFERENCES users     (tenant_id, id),

  CONSTRAINT shipment_amendments_status_chk
    CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED')),

  CONSTRAINT shipment_amendments_cod_chk
    CHECK (cod_amount_minor IS NULL OR cod_amount_minor >= 0),

  -- A request must ask for something.
  CONSTRAINT shipment_amendments_nonempty_chk CHECK (
    num_nonnulls(recipient_name, recipient_phone, recipient_phone_alt,
                 destination_raw_input, cod_amount_minor) > 0
  ),

  -- A city without a street is not an address change anyone can act on.
  CONSTRAINT shipment_amendments_city_chk
    CHECK (destination_city IS NULL OR destination_raw_input IS NOT NULL),

  -- The three shapes a row may take. Without this a row can claim to be APPLIED
  -- with no record of what it replaced.
  CONSTRAINT shipment_amendments_decision_chk CHECK (
    (status = 'PENDING'
       AND decided_at IS NULL AND decided_by_user_id IS NULL
       AND decision_reason IS NULL AND previous IS NULL)
    OR (status = 'APPLIED'
       AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
       AND previous IS NOT NULL)
    OR (status = 'REJECTED'
       AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL
       AND decision_reason IS NOT NULL AND previous IS NULL)
  )
);

-- ⚠️ ONE PENDING AMENDMENT PER PARCEL.
--
-- Two pending requests against the same shipment can both be approved, and the
-- second silently overwrites the first — including its `previous` snapshot, so
-- the trail loses a value nobody can recover. Serialising at the parcel is the
-- only place this can be enforced without a lock the application has to
-- remember to take.
CREATE UNIQUE INDEX IF NOT EXISTS shipment_amendments_one_pending_uq
  ON shipment_amendments (shipment_id)
  WHERE status = 'PENDING';

-- The dispatcher's queue: this tenant's open requests, oldest first.
CREATE INDEX IF NOT EXISTS shipment_amendments_queue_idx
  ON shipment_amendments (tenant_id, created_at)
  WHERE status = 'PENDING';

-- The history panel on a parcel.
CREATE INDEX IF NOT EXISTS shipment_amendments_shipment_idx
  ON shipment_amendments (shipment_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- The row carries no merchant_id, so it inherits the parent shipment's
-- visibility through an EXISTS — `shipments` is already narrowed by both
-- sub-tenant scopes (I24 merchant, I25 portfolio), and expressing the rule once
-- as a subquery is what stops the two drifting apart.
--
-- ⚠️ EXISTS, NOT A DIRECT COMPARISON. `merchants` is the one table that uses a
-- direct predicate; every other table narrows through EXISTS. Swapping them
-- recurses forever.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE shipment_amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_amendments FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shipment_amendments_isolation ON shipment_amendments;
CREATE POLICY shipment_amendments_isolation ON shipment_amendments
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM shipments s WHERE s.id = shipment_id)
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    AND EXISTS (SELECT 1 FROM shipments s WHERE s.id = shipment_id)
  );

-- No DELETE. A refused request is the record that it was refused.
GRANT SELECT, INSERT, UPDATE ON shipment_amendments TO dp_app;

COMMENT ON TABLE shipment_amendments IS
  'Modification Colis — requested changes to a parcel already in the system. '
  'Applied only by someone holding shipment:amend_approve; the previous values '
  'are snapshotted at that moment.';
COMMENT ON COLUMN shipment_amendments.previous IS
  'What the shipment held before this amendment was applied. The shipment row '
  'only ever shows the current value.';
