-- Remarques — the internal note staff leave on a parcel, a merchant or a driver.
--
-- The thing operations actually run on between the formal records: "customer
-- asked us to call before arriving", "this merchant's parcels are always
-- underweight", "driver reported the address is wrong". Today that lives in a
-- WhatsApp group and is lost the moment the person who wrote it is off shift.
--
-- ── Why three nullable foreign keys, not a (subject_type, subject_id) pair ──
--
-- The obvious polymorphic shape — a TEXT type column and a bare UUID — cannot
-- carry a foreign key, so nothing stops a note pointing at an id that does not
-- exist, or at a row in another tenant. The usual answer is "the application
-- checks", which in this codebase would mean the note context reading three
-- other contexts' tables: exactly the coupling module boundaries exist to
-- prevent, and undetectable by the lint rule because it is SQL, not an import.
--
-- Three nullable columns with `num_nonnulls(...) = 1` gives real referential
-- integrity, real ON DELETE behaviour, and an index per subject — at the cost of
-- one column per subject kind, which is a cost paid in DDL once rather than in
-- correctness forever.
--
-- ── ⚠️ WHY THE FOREIGN KEYS ARE COMPOSITE ───────────────────────────────────
--
-- A foreign key check does NOT go through Row-Level Security. Postgres runs the
-- referential-integrity query with the privileges needed to see the whole table,
-- which is what makes FKs work at all — and it means `REFERENCES merchants (id)`
-- happily accepts a merchant id belonging to a DIFFERENT TENANT. The insert
-- succeeds, the row is invisible to both tenants' reads, and the only symptom is
-- a remark that has silently escaped its tenant.
--
-- Proven, not assumed: the first version of this migration used single-column
-- keys and the isolation test inserted a note in tenant A against a merchant in
-- tenant B without complaint.
--
-- Referencing (tenant_id, id) puts the tenant inside the check itself, so the
-- database refuses the cross-tenant row instead of storing it. That needs a
-- unique index on the parent side of each pair; none of the three tables had one
-- on exactly (tenant_id, id), so they are added below.

-- The parent-side keys the composite references require. Redundant as
-- constraints — `id` alone is already unique — and load-bearing as targets: a
-- composite FK can only point at a UNIQUE index over the same columns.
CREATE UNIQUE INDEX IF NOT EXISTS shipments_tenant_id_uq ON shipments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS merchants_tenant_id_uq ON merchants (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS drivers_tenant_id_uq   ON drivers   (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_uq     ON users     (tenant_id, id);

CREATE TABLE IF NOT EXISTS notes (
  id                   UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Exactly one is set. CASCADE because a note about a thing that no longer
  -- exists is noise in a queue nobody can clear.
  shipment_id          UUID,
  merchant_id          UUID,
  driver_id            UUID,

  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, driver_id)   REFERENCES drivers   (tenant_id, id) ON DELETE CASCADE,

  body                 TEXT        NOT NULL,

  -- Who wrote it. RESTRICT, not CASCADE: deactivating a user must never erase
  -- what they recorded, and the queue is worthless if entries vanish when
  -- someone leaves. Composite for the same reason as the subject keys — an FK
  -- check ignores RLS, so `REFERENCES users (id)` would accept another tenant's
  -- user as the author.
  author_user_id       UUID        NOT NULL,

  -- Pinned notes lead the list on the subject's own page. A standing warning
  -- ("always call first") is not the same as a dated observation.
  pinned               BOOLEAN     NOT NULL DEFAULT FALSE,

  -- An unresolved note is an open item; the sidebar queue is exactly this set.
  resolved_at          TIMESTAMPTZ,
  resolved_by_user_id  UUID,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, author_user_id)      REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, resolved_by_user_id) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT notes_one_subject_chk
    CHECK (num_nonnulls(shipment_id, merchant_id, driver_id) = 1),
  CONSTRAINT notes_body_chk
    CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  -- Resolved is a pair or neither. A resolution with no resolver is a record of
  -- nothing.
  CONSTRAINT notes_resolution_chk
    CHECK (num_nonnulls(resolved_at, resolved_by_user_id) IN (0, 2))
);

-- The queue: this tenant's OPEN notes, newest first. Partial, because a resolved
-- note is never in it and there will eventually be far more of those.
CREATE INDEX IF NOT EXISTS notes_tenant_open_idx
  ON notes (tenant_id, created_at DESC)
  WHERE resolved_at IS NULL;

-- The subject panels. Pinned first is the read order, so it is the index order.
CREATE INDEX IF NOT EXISTS notes_shipment_idx
  ON notes (shipment_id, pinned DESC, created_at DESC) WHERE shipment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_merchant_idx
  ON notes (merchant_id, pinned DESC, created_at DESC) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_driver_idx
  ON notes (driver_id,   pinned DESC, created_at DESC) WHERE driver_id   IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- The body is written once.
--
-- A remark log whose entries change silently is worse than no log: the whole
-- value is that what someone recorded on Tuesday is what they recorded on
-- Tuesday. A correction is a new note, which is one keystroke more and leaves
-- both versions visible.
--
-- Everything ABOUT the note — pinned, resolved — stays mutable, because those
-- are the note's state, not its content. The subject is frozen too: moving a
-- remark from one parcel to another rewrites two histories at once.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notes_enforce_immutability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body THEN
    RAISE EXCEPTION 'note % is written; add a new note instead of editing it', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.shipment_id     IS DISTINCT FROM OLD.shipment_id
     OR NEW.merchant_id  IS DISTINCT FROM OLD.merchant_id
     OR NEW.driver_id    IS DISTINCT FROM OLD.driver_id
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.tenant_id    IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'note % cannot be reattached or reattributed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notes_immutable ON notes;
CREATE TRIGGER notes_immutable
  BEFORE UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION notes_enforce_immutability();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- Plain tenant isolation and no sub-tenant narrowing — because neither
-- sub-tenant role may read this table at all. A note is what staff say about a
-- merchant or a driver to each other; granting a merchant sight of their own
-- would change what gets written, which destroys the record's usefulness. The
-- permission catalogue enforces that, and RLS is the backstop for the tenant.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notes_isolation ON notes;
CREATE POLICY notes_isolation ON notes
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- No DELETE. A remark is removed by resolving it, which keeps it readable.
GRANT SELECT, INSERT, UPDATE ON notes TO dp_app;

COMMENT ON TABLE notes IS
  'Internal staff remarks on a shipment, merchant or driver. Body immutable once '
  'written; cleared by resolving, never deleted. Invisible to MERCHANT and '
  'COMMERCIAL by permission, not by RLS.';
