-- G1: FCM push token on drivers so route.published and shipment.assigned events
-- can carry the device address.
-- G2: Idempotency key on cod_remittances so a network retry does not create a
-- second remittance (the driver app's "uncertain" state becomes a safe retry).

BEGIN;

-- ── G1: Driver push token ─────────────────────────────────────────────────────
-- The FCM device token, registered by the driver app on login/shift start.
-- Nullable: a driver who has never opened the app has no token, and the
-- notification handler treats a missing token as a clean no-op.

SET ROLE dp_migrator;

ALTER TABLE drivers ADD COLUMN device_token text;

COMMENT ON COLUMN drivers.device_token IS
  'FCM device token for push notifications. Registered by the driver app, rotated on reinstall.';

-- ── G2: Remittance idempotency ────────────────────────────────────────────────
-- A unique partial index (WHERE NOT NULL) lets the driver app retry a lost
-- handover safely: same key = same remittance.

ALTER TABLE cod_remittances ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX cod_remittances_idempotency_uq
  ON cod_remittances (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN cod_remittances.idempotency_key IS
  'Client-generated UUID. A duplicate insert returns the existing row, not a second remittance.';

-- dp_app already has DML on both tables via ALTER DEFAULT PRIVILEGES (0003).
-- No new GRANT needed.

COMMIT;
