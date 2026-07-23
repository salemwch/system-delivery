-- Shipment context — the core aggregate (docs/02-domain-model.md §3.6–3.8,
-- docs/03-event-storming.md §4.1, docs/06-database-design.md §4.1–4.3, §4.6).
--
-- Four tenant-scoped tables, all ENABLE + FORCE Row-Level Security:
--
--   shipments        — the central entity. `status` is a PROJECTION of
--                      shipment_events and is NEVER written except by the
--                      sanctioned projection writer, in the same transaction as
--                      the event that justifies it (rule 1, invariant enforced by
--                      SAST rule no-direct-shipment-status-write).
--   shipment_legs    — the physical movement segments (1..n). Modelled from MVP
--                      even though most shipments are 1–2 legs, because
--                      retrofitting is a schema-wide migration (Blueprint D8).
--   shipment_events  — THE most important table: the immutable custody ledger.
--                      Append-only, enforced by GRANT (SELECT + INSERT only, no
--                      UPDATE/DELETE for the application role — rule 1).
--   pod              — proof of delivery: object-storage references + tamper
--                      hash, never blobs. Immutable evidence (SELECT + INSERT).
--
-- Partitioning note (deliberate deviation from docs/06 §4.2, decided 2026-07-23):
-- docs/06 calls for monthly RANGE partitioning of shipment_events by occurred_at
-- "from day one". PostgreSQL requires every UNIQUE constraint on a partitioned
-- table to include the partition key, which would demote UNIQUE(shipment_id,
-- sequence) and UNIQUE(tenant_id, idempotency_key) to include occurred_at — and
-- that no longer guarantees a unique per-shipment sequence or offline-retry
-- idempotency (domain rules 3 and 4). Those two constraints are correctness, not
-- optimisation. The table starts empty, so partitioning is a routine online
-- migration to add later; sacrificing the invariants now is not. We keep the real
-- constraints and use a BRIN index on occurred_at (small, ideal for an
-- append-only, naturally time-correlated column — docs/06 §6).

-- ─────────────────────────────────────────────────────────────────────────────
-- shipments — the central entity.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipments (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Human-facing tracking reference. Generated, non-sequential, immutable, unique
  -- per tenant (domain rule 10). Called reference in docs/06 §4.1; the domain
  -- model and every event payload call it trackingNumber — we use that name.
  tracking_number       TEXT NOT NULL,

  -- Nullable: a Tenant may create shipments with no Merchant at all
  -- (Sender ≠ Merchant, domain §1.1).
  merchant_id           UUID REFERENCES merchants (id),
  -- The merchant's own order id. Unique per (tenant, merchant) when present.
  external_reference    TEXT,
  -- The address-book entry this shipment is going to. The delivery contact is
  -- SNAPSHOTTED below so a later edit to the recipient row cannot rewrite history.
  recipient_id          UUID REFERENCES recipients (id),

  -- PROJECTION of shipment_events. Never written directly (rule 1).
  status                TEXT NOT NULL DEFAULT 'CREATED',
  service_level         TEXT NOT NULL DEFAULT 'STANDARD',

  -- Sender (pickup party) — snapshot; usually but not always the merchant.
  sender_name           TEXT NOT NULL,
  sender_phone          TEXT NOT NULL,
  origin_address_id     UUID NOT NULL REFERENCES addresses (id),

  -- Recipient snapshot. recipient_phone is MANDATORY and E.164 (rule 4): in MENA
  -- the phone is the real addressing mechanism — a shipment without a reachable
  -- phone is undeliverable in practice.
  recipient_name        TEXT NOT NULL,
  recipient_phone       TEXT NOT NULL,
  recipient_phone_alt   TEXT,
  destination_address_id UUID NOT NULL REFERENCES addresses (id),

  -- The customer promise; SLA is measured against these on occurred_at.
  promised_from         TIMESTAMPTZ,
  promised_to           TIMESTAMPTZ,
  eta_at                TIMESTAMPTZ,

  weight_grams          INTEGER NOT NULL DEFAULT 0,
  volume_cm3            INTEGER,
  parcel_count          INTEGER NOT NULL DEFAULT 1,

  declared_value_minor  BIGINT,
  -- ISO 4217 alphabetic code. Minor-unit scale is read from the currencies table,
  -- never hardcoded — TND has 3 decimal places, not 2.
  currency              CHAR(3) NOT NULL,

  -- 0 when not COD. NEVER a boolean (domain §3.6). Immutable once past PICKED_UP
  -- (rule 5) — enforced in the application, which freezes it on shipment.picked_up.
  cod_amount_minor      BIGINT NOT NULL DEFAULT 0,
  cod_status            TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',

  attempt_count         SMALLINT NOT NULL DEFAULT 0,
  max_attempts          SMALLINT NOT NULL DEFAULT 3,
  priority              SMALLINT NOT NULL DEFAULT 0,
  required_skills       TEXT[] NOT NULL DEFAULT '{}',

  -- Who physically holds the parcel right now (domain §3.6).
  current_custody_type  TEXT,
  current_custody_id    UUID,

  custom_fields         JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The high-water mark of the per-shipment event sequence. Bumped under a
  -- FOR UPDATE lock on this row, which is what serialises concurrent custody
  -- events and makes the sequence strictly monotonic without a separate counter.
  last_sequence         BIGINT NOT NULL DEFAULT 0,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shipments_status_chk CHECK (status IN (
    'CREATED', 'ASSIGNED', 'PICKED_UP', 'AT_HUB', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
    'DELIVERED', 'ATTEMPT_FAILED', 'RETURN_PENDING', 'RETURNED', 'CANCELLED'
  )),
  CONSTRAINT shipments_service_level_chk
    CHECK (service_level IN ('EXPRESS', 'STANDARD', 'SCHEDULED')),
  CONSTRAINT shipments_cod_status_chk CHECK (cod_status IN (
    'NOT_APPLICABLE', 'PENDING', 'COLLECTED', 'REMITTED', 'SETTLED'
  )),
  CONSTRAINT shipments_custody_type_chk
    CHECK (current_custody_type IS NULL OR current_custody_type IN ('MERCHANT', 'DRIVER', 'HUB')),
  CONSTRAINT shipments_weight_chk CHECK (weight_grams >= 0),
  CONSTRAINT shipments_volume_chk CHECK (volume_cm3 IS NULL OR volume_cm3 >= 0),
  CONSTRAINT shipments_parcel_count_chk CHECK (parcel_count >= 1),
  CONSTRAINT shipments_max_attempts_chk CHECK (max_attempts >= 1),
  CONSTRAINT shipments_attempt_count_chk CHECK (attempt_count >= 0),
  CONSTRAINT shipments_cod_amount_chk CHECK (cod_amount_minor >= 0),
  CONSTRAINT shipments_declared_value_chk
    CHECK (declared_value_minor IS NULL OR declared_value_minor >= 0),
  CONSTRAINT shipments_currency_chk CHECK (char_length(currency) = 3),
  CONSTRAINT shipments_promised_window_chk
    CHECK (promised_to IS NULL OR promised_from IS NULL OR promised_to >= promised_from),
  -- Rule 6: cod_amount_minor > 0 ⇔ cod_status ≠ NOT_APPLICABLE. A boolean-equals
  -- check reads as "these two facts must agree".
  CONSTRAINT shipments_cod_consistency_chk
    CHECK ((cod_amount_minor = 0) = (cod_status = 'NOT_APPLICABLE'))
);

-- Tracking number is unique per tenant (rule 10). Never globally — two couriers
-- may legitimately mint the same-looking reference.
CREATE UNIQUE INDEX IF NOT EXISTS shipments_tenant_tracking_uq
  ON shipments (tenant_id, tracking_number);
-- External reference unique per (tenant, merchant) when both are present.
CREATE UNIQUE INDEX IF NOT EXISTS shipments_tenant_merchant_extref_uq
  ON shipments (tenant_id, merchant_id, external_reference)
  WHERE external_reference IS NOT NULL AND merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shipments_tenant_status_idx ON shipments (tenant_id, status);
CREATE INDEX IF NOT EXISTS shipments_tenant_merchant_idx ON shipments (tenant_id, merchant_id);
CREATE INDEX IF NOT EXISTS shipments_tenant_recipient_idx ON shipments (tenant_id, recipient_id);
CREATE INDEX IF NOT EXISTS shipments_tenant_created_idx ON shipments (tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- shipment_legs — the physical movement segments.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipment_legs (
  id                UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  shipment_id       UUID NOT NULL REFERENCES shipments (id) ON DELETE CASCADE,

  leg_number        SMALLINT NOT NULL,
  leg_type          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PLANNED',

  from_type         TEXT NOT NULL,
  to_type           TEXT NOT NULL,
  from_address_id   UUID REFERENCES addresses (id),
  to_address_id     UUID REFERENCES addresses (id),
  -- Hubs (network module) and routes/manifests (dispatch/network) do not exist
  -- yet, so these are unconstrained UUIDs; their FKs are added with those modules.
  from_hub_id       UUID,
  to_hub_id         UUID,
  route_stop_id     UUID,
  manifest_id       UUID,

  planned_start_at  TIMESTAMPTZ,
  planned_end_at    TIMESTAMPTZ,
  actual_start_at   TIMESTAMPTZ,
  actual_end_at     TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shipment_legs_leg_number_chk CHECK (leg_number >= 1),
  CONSTRAINT shipment_legs_type_chk
    CHECK (leg_type IN ('PICKUP', 'LINEHAUL', 'HUB_TRANSFER', 'LAST_MILE', 'RETURN')),
  CONSTRAINT shipment_legs_status_chk CHECK (status IN (
    'PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'
  )),
  CONSTRAINT shipment_legs_from_type_chk CHECK (from_type IN ('ADDRESS', 'HUB')),
  CONSTRAINT shipment_legs_to_type_chk CHECK (to_type IN ('ADDRESS', 'HUB')),
  -- Rule 4: exactly one endpoint kind is set on each end, matching its type.
  CONSTRAINT shipment_legs_from_endpoint_chk CHECK (
    (from_type = 'ADDRESS' AND from_address_id IS NOT NULL AND from_hub_id IS NULL) OR
    (from_type = 'HUB'     AND from_hub_id IS NOT NULL AND from_address_id IS NULL)
  ),
  CONSTRAINT shipment_legs_to_endpoint_chk CHECK (
    (to_type = 'ADDRESS' AND to_address_id IS NOT NULL AND to_hub_id IS NULL) OR
    (to_type = 'HUB'     AND to_hub_id IS NOT NULL AND to_address_id IS NULL)
  )
);

-- Leg numbers are contiguous from 1 per shipment (rule 1) — the unique index
-- makes a duplicate number an error; contiguity is enforced in the application.
CREATE UNIQUE INDEX IF NOT EXISTS shipment_legs_shipment_number_uq
  ON shipment_legs (shipment_id, leg_number);
CREATE INDEX IF NOT EXISTS shipment_legs_tenant_shipment_idx
  ON shipment_legs (tenant_id, shipment_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- shipment_events — the immutable custody ledger. Append-only.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipment_events (
  id                  UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  shipment_id         UUID NOT NULL REFERENCES shipments (id) ON DELETE CASCADE,

  -- Monotonic per shipment; resolves same-timestamp ordering (domain §3.8 rule 3).
  sequence            BIGINT NOT NULL,
  event_type          TEXT NOT NULL,

  -- occurred_at is device/physical time; recorded_at is server-receipt time. They
  -- differ by hours for an offline capture and that is normal, not an error
  -- (rule 5). SLA is measured on occurred_at; the gap is a sync-health signal.
  occurred_at         TIMESTAMPTZ NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  actor_type          TEXT NOT NULL,
  actor_id            UUID,

  -- Where the scan physically occurred — critical for POD fraud detection.
  location            GEOGRAPHY(POINT, 4326),
  location_accuracy_m REAL,

  hub_id              UUID,
  driver_id           UUID,
  route_id            UUID,
  leg_id              UUID REFERENCES shipment_legs (id),

  reason_code         TEXT,
  -- Client-generated. Makes offline retries safe: a duplicate submission returns
  -- the original result and creates nothing (rule 4). Unique per (tenant, key).
  idempotency_key     TEXT NOT NULL,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shipment_events_sequence_chk CHECK (sequence >= 1),
  CONSTRAINT shipment_events_type_chk CHECK (event_type IN (
    'created', 'assigned', 'picked_up', 'arrived_at_hub', 'loaded', 'departed',
    'out_for_delivery', 'arrived_at_stop', 'delivery_attempted', 'delivered',
    'delivery_failed', 'return_initiated', 'returned', 'cancelled'
  )),
  CONSTRAINT shipment_events_actor_type_chk CHECK (actor_type IN (
    'DRIVER', 'DISPATCHER', 'HUB_OPERATOR', 'SYSTEM', 'API_CLIENT'
  ))
);

-- Correctness constraints (see partitioning note in the file header).
CREATE UNIQUE INDEX IF NOT EXISTS shipment_events_shipment_sequence_uq
  ON shipment_events (shipment_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_events_tenant_idempotency_uq
  ON shipment_events (tenant_id, idempotency_key);
-- BRIN, not B-tree, on the append-only time column: orders of magnitude smaller,
-- and occurred_at is naturally correlated with physical insert order (docs/06 §6).
CREATE INDEX IF NOT EXISTS shipment_events_occurred_brin
  ON shipment_events USING BRIN (occurred_at);
CREATE INDEX IF NOT EXISTS shipment_events_tenant_occurred_idx
  ON shipment_events (tenant_id, occurred_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- pod — proof of delivery. One per delivered shipment (domain §3.24 rule 2).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pod (
  id                    UUID PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  shipment_id           UUID NOT NULL REFERENCES shipments (id) ON DELETE CASCADE,

  pod_type              TEXT NOT NULL,
  -- Object-storage references, never blobs in the row.
  signature_object_key  TEXT,
  photo_object_keys     TEXT[] NOT NULL DEFAULT '{}',
  -- SHA-256 of each artifact — tamper evidence.
  content_hash          TEXT,

  recipient_name        TEXT NOT NULL,
  recipient_relationship TEXT,
  otp_verified          BOOLEAN NOT NULL DEFAULT false,

  captured_location     GEOGRAPHY(POINT, 4326),
  -- Computed on write; > 150 m is the input to the fraud distance rule (P8).
  distance_from_destination_m INTEGER,
  captured_at           TIMESTAMPTZ NOT NULL,
  device_metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pod_type_chk
    CHECK (pod_type IN ('signature', 'photo', 'otp', 'id_check', 'contactless'))
);

-- Exactly one POD per successfully delivered shipment.
CREATE UNIQUE INDEX IF NOT EXISTS pod_shipment_uq ON pod (shipment_id);
CREATE INDEX IF NOT EXISTS pod_tenant_idx ON pod (tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-Level Security + grants.
--
-- Every table names its tenant; isolation is ENABLE + FORCE with a policy scoped
-- to the current tenant. The access model is enforced at the ROLE level, not by
-- convention (domain §3.8 rule 1).
--
-- IMPORTANT: dp_migrator's default privileges (infra/docker/initdb/02-roles.sql)
-- already grant dp_app SELECT + INSERT + UPDATE + DELETE on every table it creates.
-- So the enforcement here is REVOKE, not GRANT — a bare GRANT would be a no-op and
-- the "append-only" guarantee would be a comment, not a control. We revoke DOWN to
-- what each table actually permits:
--
--   shipments       SELECT, INSERT, UPDATE   (the status projection is an UPDATE)
--   shipment_legs   SELECT, INSERT, UPDATE    (legs gain actual times + status)
--   shipment_events SELECT, INSERT            — NO UPDATE, NO DELETE. Immutable log.
--   pod             SELECT, INSERT            — immutable delivery evidence.
--
-- No DELETE / TRUNCATE anywhere: a shipment is never deleted (rule 3); custody
-- history is a legal record. Teardown is via ON DELETE CASCADE from tenants, which
-- is a system referential action and does not need (or consult) a DELETE grant.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['shipments', 'shipment_legs', 'shipment_events', 'pod'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      || 'USING (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid) '
      || 'WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', true)::uuid)',
      tbl || '_isolation', tbl
    );
  END LOOP;

  -- Nothing is ever hard-deleted through the application role.
  EXECUTE 'REVOKE DELETE, TRUNCATE ON shipments, shipment_legs, shipment_events, pod FROM dp_app';
  -- The custody ledger and its proof are append-only: also revoke UPDATE. This is
  -- the enforcement, in the one place a determined bug cannot talk its way around.
  EXECUTE 'REVOKE UPDATE ON shipment_events, pod FROM dp_app';
END
$$;

COMMENT ON TABLE shipments IS
  'The central entity. status is a PROJECTION of shipment_events, never written directly (domain rule 1, SAST no-direct-shipment-status-write).';
COMMENT ON TABLE shipment_events IS
  'The immutable custody ledger — the most important table in the system. Append-only, enforced by GRANT (no UPDATE/DELETE for dp_app).';
COMMENT ON TABLE shipment_legs IS
  'Physical movement segments (1..n). Leg n destination must equal leg n+1 origin (domain §3.7 rule 2).';
COMMENT ON TABLE pod IS
  'Proof of delivery: object-storage references + tamper hash, never blobs. One per delivered shipment; immutable evidence.';
