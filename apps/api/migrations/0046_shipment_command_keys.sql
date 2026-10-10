-- Idempotency keys bound to WHAT they were used for (invariant I29).
--
-- ⚠️ THE DEFECT THIS CLOSES. Shipment commands decided "already applied" by
-- looking the key up in shipment_events across the whole tenant. Nothing tied
-- it to the shipment, the caller, the command or the request, and the lookup
-- ran BEFORE authorization:
--   - a key already used on parcel X made a delivery of parcel Y a silent
--     no-op that still answered 200. The app believed a COD parcel was
--     delivered while the ledger recorded nothing;
--   - a driver who did not hold a parcel got 200 instead of 403 by presenting
--     a key someone else had used.
-- docs/05-api-contracts.md §1.2 already promised `422 IDEMPOTENCY_KEY_REUSED`.
--
-- One row per APPLIED command, written in the same transaction as the command,
-- after it succeeded:
--   - shipment_id, actor_id, command and request_hash are the binding. A replay
--     must match all four, or it is a 422 that discloses nothing stored;
--   - result is the shipment as the command left it, so an offline retry gets
--     the original outcome even if the parcel has moved on since.
-- A command that FAILS writes no row (its transaction rolls back), so a
-- corrected retry with the same key is a new attempt, not a conflict.
--
-- Concurrency: the PRIMARY KEY is the arbiter. Two identical requests are
-- already serialised by the shipment row lock, and the second finds this row.
-- Two requests reusing one key on DIFFERENT shipments race to INSERT; the
-- loser's unique violation rolls back its whole command and becomes a 422.

CREATE TABLE shipment_command_keys (
  tenant_id       UUID        NOT NULL,
  idempotency_key TEXT        NOT NULL,
  shipment_id     UUID        NOT NULL,
  -- The authenticated user (or NULL for system work: consumers, schedulers).
  actor_id        UUID,
  command         TEXT        NOT NULL,
  -- SHA-256 (hex) of the canonical JSON of the validated request, key excluded.
  request_hash    TEXT        NOT NULL,
  result          JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, idempotency_key),
  CONSTRAINT shipment_command_keys_shipment_fkey
    FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT shipment_command_keys_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT shipment_command_keys_key_chk CHECK (length(idempotency_key) BETWEEN 1 AND 200)
);

CREATE INDEX shipment_command_keys_shipment_idx
  ON shipment_command_keys (tenant_id, shipment_id);

ALTER TABLE shipment_command_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_command_keys FORCE  ROW LEVEL SECURITY;

-- Tenant-wide on purpose. A key must collide with its earlier use even when the
-- caller cannot see that shipment, or the conflict would surface as a raw
-- unique violation instead of a 422. The row's contents are only ever
-- returned to a caller who matches every binding column.
CREATE POLICY shipment_command_keys_isolation ON shipment_command_keys
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Append-only. A key's binding and recorded outcome are evidence; rewriting
-- either would let a replay return something that never happened. Restrictions
-- here are always a REVOKE (0042): ALTER DEFAULT PRIVILEGES already granted DML.
REVOKE UPDATE, DELETE, TRUNCATE ON shipment_command_keys FROM dp_app;

COMMENT ON TABLE shipment_command_keys IS
  'Invariant I29. Idempotency keys of shipment commands, bound to tenant, shipment, '
  'caller, command and request hash, with the recorded outcome. Append-only.';
