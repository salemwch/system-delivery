-- Gestion de stock — consumable inventory at a hub.
--
-- ⚠️ THIS IS NOT PARCEL STORAGE. A parcel's location is the custody chain, and
-- putting parcels in a stock table would create a SECOND answer to "where is
-- it?" that immediately disagrees with the first. Custody is the truth; nothing
-- here touches it.
--
-- What this IS: the things a hub consumes to operate. Thermal label rolls,
-- packing tape, poly bags, printer toner. A courier runs out of label rolls on a
-- Saturday and cannot dispatch, which is a real operational failure with no
-- record anywhere today.
--
-- ── The stock level is DERIVED, never stored ────────────────────────────────
--
-- Exactly like `shipments.status` and the ledger: the movements are the truth
-- and the level is SUM(movements). A stored counter drifts the first time two
-- receipts land concurrently, and then nobody can say whether the shelf or the
-- number is wrong. `inventory_levels` below is a VIEW, so the question cannot
-- arise.

CREATE TABLE IF NOT EXISTS inventory_items (
  id            UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- What the storeman calls it on the shelf.
  sku           TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  name_ar       TEXT,

  -- ROLL | BOX | UNIT | METRE | LITRE. Free-ish text behind a CHECK: a unit is
  -- a label on a shelf, not a conversion factor, and this system never converts
  -- between them.
  unit          TEXT        NOT NULL DEFAULT 'UNIT',

  -- Below this, the hub is running out. NULL = never warn. Per ITEM rather than
  -- per hub-item: a courier with one reorder point per SKU is the common case,
  -- and the exception is better served by a report than by a second table.
  reorder_level INTEGER,

  active        BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT inventory_items_sku_chk    CHECK (length(btrim(sku)) BETWEEN 1 AND 50),
  CONSTRAINT inventory_items_name_chk   CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT inventory_items_unit_chk   CHECK (unit IN ('UNIT', 'ROLL', 'BOX', 'METRE', 'LITRE')),
  CONSTRAINT inventory_items_reorder_chk CHECK (reorder_level IS NULL OR reorder_level >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_sku_uq
  ON inventory_items (tenant_id, sku);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_tenant_id_uq
  ON inventory_items (tenant_id, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- The movement log. Append-only: the truth.
--
-- `quantity` is ALWAYS POSITIVE and `direction` carries the sign — the same rule
-- as `ledger_entries` (domain §3.15 rule 4), and for the same reason: signed
-- amounts plus a direction column produce double-negative bugs that are
-- invisible until a stocktake.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_movements (
  id              UUID        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  item_id         UUID        NOT NULL,
  hub_id          UUID        NOT NULL,

  -- IN  — a delivery from a supplier, or a transfer arriving.
  -- OUT — consumed, or a transfer leaving.
  -- ADJUST — a stocktake correction. Carries its own direction because a count
  --   can be higher or lower than the book.
  direction       TEXT        NOT NULL,
  quantity        INTEGER     NOT NULL,

  -- RECEIPT | CONSUMPTION | TRANSFER | STOCKTAKE | DAMAGE. Why the stock moved,
  -- which is what a monthly review reads.
  reason          TEXT        NOT NULL,

  -- The other end of a transfer. Set on BOTH rows of a transfer pair, so either
  -- side can find its counterpart.
  counterpart_hub_id UUID,

  note            TEXT,
  recorded_by_user_id UUID    NOT NULL,

  -- Client-supplied. A storeman on a bad connection taps "receive" twice and the
  -- shelf gains stock that never arrived.
  idempotency_key TEXT        NOT NULL,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, item_id)             REFERENCES inventory_items (tenant_id, id),
  FOREIGN KEY (tenant_id, hub_id)              REFERENCES hubs (tenant_id, id),
  FOREIGN KEY (tenant_id, counterpart_hub_id)  REFERENCES hubs (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by_user_id) REFERENCES users (tenant_id, id),

  CONSTRAINT inventory_movements_direction_chk CHECK (direction IN ('IN', 'OUT')),
  CONSTRAINT inventory_movements_quantity_chk  CHECK (quantity > 0),
  CONSTRAINT inventory_movements_reason_chk    CHECK (
    reason IN ('RECEIPT', 'CONSUMPTION', 'TRANSFER', 'STOCKTAKE', 'DAMAGE')
  ),
  -- A transfer names where it went or came from; nothing else does.
  CONSTRAINT inventory_movements_transfer_chk CHECK (
    (reason = 'TRANSFER' AND counterpart_hub_id IS NOT NULL AND counterpart_hub_id <> hub_id)
    OR (reason <> 'TRANSFER' AND counterpart_hub_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_idempotency_uq
  ON inventory_movements (tenant_id, idempotency_key);

-- The level query: every movement of one item at one hub.
CREATE INDEX IF NOT EXISTS inventory_movements_stock_idx
  ON inventory_movements (tenant_id, hub_id, item_id, occurred_at DESC);

-- The hub's own movement history.
CREATE INDEX IF NOT EXISTS inventory_movements_hub_idx
  ON inventory_movements (hub_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- The level, as a VIEW.
--
-- A view rather than a table so there is exactly one answer to "how many are
-- there", and it is always the sum of what actually happened. At the volumes
-- this table sees — a few movements per hub per day — the aggregate is trivial;
-- if it ever is not, the fix is a materialised view refreshed on write, NOT a
-- counter column that can silently disagree.
--
-- ⚠️ SECURITY INVOKER (the default, stated explicitly): the view must run RLS as
-- the CALLER, or it becomes a hole that shows every tenant's stock. Postgres 15+
-- would otherwise let a future ALTER flip it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW inventory_levels
WITH (security_invoker = true) AS
  SELECT
    m.tenant_id,
    m.hub_id,
    m.item_id,
    SUM(CASE WHEN m.direction = 'IN' THEN m.quantity ELSE -m.quantity END)::INTEGER AS quantity
  FROM inventory_movements m
  GROUP BY m.tenant_id, m.hub_id, m.item_id;

COMMENT ON VIEW inventory_levels IS
  'Stock on hand = SUM(movements). A view, never a counter column: a stored '
  'total drifts and then nobody can say whether the shelf or the number is wrong.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security.
--
-- Plain tenant isolation. A MERCHANT holds no inventory permission at all —
-- what a courier keeps on its shelves is not a merchant's business.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE  ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inventory_items_isolation ON inventory_items;
CREATE POLICY inventory_items_isolation ON inventory_items
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP POLICY IF EXISTS inventory_movements_isolation ON inventory_movements;
CREATE POLICY inventory_movements_isolation ON inventory_movements
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- ⚠️ NO UPDATE AND NO DELETE ON MOVEMENTS. The log is append-only; a mistake is
-- corrected by a STOCKTAKE movement in the opposite direction, which leaves both
-- the error and the correction visible. Granting UPDATE would let one bad write
-- rewrite a month of history with nothing to show for it.
GRANT SELECT, INSERT, UPDATE ON inventory_items     TO dp_app;
GRANT SELECT, INSERT         ON inventory_movements TO dp_app;
GRANT SELECT                 ON inventory_levels    TO dp_app;

COMMENT ON TABLE inventory_movements IS
  'Append-only stock movements. Quantity is always positive; direction carries '
  'the sign, as in ledger_entries. Corrected by a STOCKTAKE, never by an UPDATE.';
COMMENT ON TABLE inventory_items IS
  'Consumables a hub uses to operate — label rolls, tape, bags. NOT parcels: a '
  'parcel''s location is the custody chain, and a second answer would disagree.';
