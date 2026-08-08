-- Every tenant-scoped foreign key becomes composite.
--
-- ⚠️ A FOREIGN KEY CHECK DOES NOT GO THROUGH ROW-LEVEL SECURITY.
--
-- Postgres performs referential integrity with the privileges needed to see the
-- whole referenced table. That is not a bug — it is what makes foreign keys work
-- at all, since the referenced row is frequently invisible to the inserting
-- role. The consequence for a multi-tenant schema is severe:
--
--     INSERT INTO invoices (tenant_id, merchant_id, …)
--     VALUES ('tenant-A', '<a merchant belonging to tenant B>', …);
--
-- succeeds. `invoices_isolation` checks `tenant_id = current tenant`, which is
-- satisfied — nothing checks that MERCHANT_ID is also tenant A's. The row is
-- then invisible to tenant B (its tenant_id is A) and visible to tenant A
-- pointing at a merchant tenant A cannot read. Neither party sees anything
-- wrong; the reports are simply incorrect and one tenant's identifiers have
-- leaked into another's data.
--
-- This was not deduced. Migration 0035 shipped with a test asserting that a note
-- in tenant A could not name tenant B's merchant as its subject; the insert
-- succeeded and the test failed. The audit that followed found 54 foreign keys
-- with the same shape, across 18 parent tables — every one of them, i.e. the
-- entire schema, since the pattern was applied consistently.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
--
-- Put the tenant INSIDE the check:
--
--     FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id)
--
-- Now the pair must exist together, and a merchant from another tenant is a pair
-- that does not exist. No application code changes: `MATCH SIMPLE` (the default)
-- skips the check entirely when ANY referencing column is NULL, so nullable
-- foreign keys behave exactly as before.
--
-- ⚠️ ON DELETE SET NULL NEEDS A COLUMN LIST. Without one it nulls every
-- referencing column, tenant_id included — and tenant_id is NOT NULL, so the
-- delete would fail at runtime, long after this migration passed. Postgres 15+
-- takes `SET NULL (column)` to name the one column that may be nulled. Every
-- SET NULL below carries it.
--
-- ── Verification before writing ──────────────────────────────────────────────
--
-- Two things were confirmed against the live schema first, because either would
-- have made this migration fail on real data:
--
--   * No child table referencing a tenant-scoped parent lacks its own
--     `tenant_id` — so every one of the 54 CAN be made composite.
--   * No cross-tenant row already exists — so every new constraint validates.
--
-- ── Cost ─────────────────────────────────────────────────────────────────────
--
-- Each ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on the child and validates it.
-- At present data volumes that is milliseconds. On a large production table the
-- two-step form (`ADD … NOT VALID`, then `VALIDATE CONSTRAINT` under a weaker
-- lock) is the right shape; it is deliberately not used here, because splitting
-- it across statements in one transaction gains nothing and the single form is
-- the one that cannot leave a constraint permanently unvalidated.
--
-- The 18 unique indexes below are the price of the pattern: `(tenant_id, id)`
-- duplicates the primary key's uniqueness. They earn it back — every one is a
-- useful index for tenant-scoped lookups, which is most queries in this schema.

-- The parent-side keys the composite references require.
--
-- Redundant as constraints — `id` is already unique — and load-bearing as
-- TARGETS: a composite foreign key can only point at a unique index over the
-- same columns. IF NOT EXISTS because migration 0035 already created four of
-- them for `notes`.
CREATE UNIQUE INDEX IF NOT EXISTS addresses_tenant_id_uq ON addresses (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS complaints_tenant_id_uq ON complaints (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS drivers_tenant_id_uq ON drivers (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS hubs_tenant_id_uq ON hubs (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_tenant_id_uq ON invoices (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_tenant_id_uq ON ledger_accounts (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_tenant_id_uq ON ledger_entries (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS manifests_tenant_id_uq ON manifests (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS merchants_tenant_id_uq ON merchants (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS pickup_requests_tenant_id_uq ON pickup_requests (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS recipients_tenant_id_uq ON recipients (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS routes_tenant_id_uq ON routes (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS settlements_tenant_id_uq ON settlements (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS shipment_legs_tenant_id_uq ON shipment_legs (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS shipments_tenant_id_uq ON shipments (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_uq ON users (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_tenant_id_uq ON vehicles (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS zones_tenant_id_uq ON zones (tenant_id, id);

-- ── cities ──────────────────────────────────────────────────────────────────
ALTER TABLE cities DROP CONSTRAINT cities_zone_id_fkey;
ALTER TABLE cities ADD CONSTRAINT cities_zone_id_fkey
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id) ON DELETE SET NULL (zone_id);
-- ── complaint_activity ──────────────────────────────────────────────────────
ALTER TABLE complaint_activity DROP CONSTRAINT complaint_activity_complaint_id_fkey;
ALTER TABLE complaint_activity ADD CONSTRAINT complaint_activity_complaint_id_fkey
  FOREIGN KEY (tenant_id, complaint_id) REFERENCES complaints (tenant_id, id) ON DELETE CASCADE;
-- ── complaints ──────────────────────────────────────────────────────────────
ALTER TABLE complaints DROP CONSTRAINT complaints_driver_id_fkey;
ALTER TABLE complaints ADD CONSTRAINT complaints_driver_id_fkey
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE SET NULL (driver_id);
ALTER TABLE complaints DROP CONSTRAINT complaints_merchant_id_fkey;
ALTER TABLE complaints ADD CONSTRAINT complaints_merchant_id_fkey
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id) ON DELETE SET NULL (merchant_id);
ALTER TABLE complaints DROP CONSTRAINT complaints_recipient_id_fkey;
ALTER TABLE complaints ADD CONSTRAINT complaints_recipient_id_fkey
  FOREIGN KEY (tenant_id, recipient_id) REFERENCES recipients (tenant_id, id) ON DELETE SET NULL (recipient_id);
ALTER TABLE complaints DROP CONSTRAINT complaints_shipment_id_fkey;
ALTER TABLE complaints ADD CONSTRAINT complaints_shipment_id_fkey
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE SET NULL (shipment_id);
-- ── drivers ─────────────────────────────────────────────────────────────────
ALTER TABLE drivers DROP CONSTRAINT drivers_default_vehicle_id_fkey;
ALTER TABLE drivers ADD CONSTRAINT drivers_default_vehicle_id_fkey
  FOREIGN KEY (tenant_id, default_vehicle_id) REFERENCES vehicles (tenant_id, id) ON DELETE SET NULL (default_vehicle_id);
ALTER TABLE drivers DROP CONSTRAINT drivers_home_hub_id_fkey;
ALTER TABLE drivers ADD CONSTRAINT drivers_home_hub_id_fkey
  FOREIGN KEY (tenant_id, home_hub_id) REFERENCES hubs (tenant_id, id) ON DELETE SET NULL (home_hub_id);
ALTER TABLE drivers DROP CONSTRAINT drivers_user_id_fkey;
ALTER TABLE drivers ADD CONSTRAINT drivers_user_id_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE SET NULL (user_id);
-- ── geofences ───────────────────────────────────────────────────────────────
ALTER TABLE geofences DROP CONSTRAINT geofences_address_id_fkey;
ALTER TABLE geofences ADD CONSTRAINT geofences_address_id_fkey
  FOREIGN KEY (tenant_id, address_id) REFERENCES addresses (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE geofences DROP CONSTRAINT geofences_hub_id_fkey;
ALTER TABLE geofences ADD CONSTRAINT geofences_hub_id_fkey
  FOREIGN KEY (tenant_id, hub_id) REFERENCES hubs (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE geofences DROP CONSTRAINT geofences_zone_id_fkey;
ALTER TABLE geofences ADD CONSTRAINT geofences_zone_id_fkey
  FOREIGN KEY (tenant_id, zone_id) REFERENCES zones (tenant_id, id) ON DELETE CASCADE;
-- ── hubs ────────────────────────────────────────────────────────────────────
ALTER TABLE hubs DROP CONSTRAINT hubs_address_id_fkey;
ALTER TABLE hubs ADD CONSTRAINT hubs_address_id_fkey
  FOREIGN KEY (tenant_id, address_id) REFERENCES addresses (tenant_id, id);
ALTER TABLE hubs DROP CONSTRAINT hubs_parent_hub_id_fkey;
ALTER TABLE hubs ADD CONSTRAINT hubs_parent_hub_id_fkey
  FOREIGN KEY (tenant_id, parent_hub_id) REFERENCES hubs (tenant_id, id) ON DELETE RESTRICT;
-- ── invoice_lines ───────────────────────────────────────────────────────────
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_invoice_id_fkey;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_invoice_id_fkey
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE CASCADE;
-- ── invoices ────────────────────────────────────────────────────────────────
ALTER TABLE invoices DROP CONSTRAINT invoices_corrects_invoice_id_fkey;
ALTER TABLE invoices ADD CONSTRAINT invoices_corrects_invoice_id_fkey
  FOREIGN KEY (tenant_id, corrects_invoice_id) REFERENCES invoices (tenant_id, id);
ALTER TABLE invoices DROP CONSTRAINT invoices_merchant_id_fkey;
ALTER TABLE invoices ADD CONSTRAINT invoices_merchant_id_fkey
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id);
-- ── ledger_entries ──────────────────────────────────────────────────────────
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_id_fkey;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_id_fkey
  FOREIGN KEY (tenant_id, account_id) REFERENCES ledger_accounts (tenant_id, id);
ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_reversal_of_entry_id_fkey;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_reversal_of_entry_id_fkey
  FOREIGN KEY (tenant_id, reversal_of_entry_id) REFERENCES ledger_entries (tenant_id, id);
-- ── manifest_discrepancies ──────────────────────────────────────────────────
ALTER TABLE manifest_discrepancies DROP CONSTRAINT manifest_discrepancies_manifest_id_fkey;
ALTER TABLE manifest_discrepancies ADD CONSTRAINT manifest_discrepancies_manifest_id_fkey
  FOREIGN KEY (tenant_id, manifest_id) REFERENCES manifests (tenant_id, id);
-- ── manifest_items ──────────────────────────────────────────────────────────
ALTER TABLE manifest_items DROP CONSTRAINT manifest_items_manifest_id_fkey;
ALTER TABLE manifest_items ADD CONSTRAINT manifest_items_manifest_id_fkey
  FOREIGN KEY (tenant_id, manifest_id) REFERENCES manifests (tenant_id, id);
-- ── manifests ───────────────────────────────────────────────────────────────
ALTER TABLE manifests DROP CONSTRAINT manifests_from_hub_id_fkey;
ALTER TABLE manifests ADD CONSTRAINT manifests_from_hub_id_fkey
  FOREIGN KEY (tenant_id, from_hub_id) REFERENCES hubs (tenant_id, id);
ALTER TABLE manifests DROP CONSTRAINT manifests_to_hub_id_fkey;
ALTER TABLE manifests ADD CONSTRAINT manifests_to_hub_id_fkey
  FOREIGN KEY (tenant_id, to_hub_id) REFERENCES hubs (tenant_id, id);
-- ── merchants ───────────────────────────────────────────────────────────────
ALTER TABLE merchants DROP CONSTRAINT merchants_account_manager_id_fkey;
ALTER TABLE merchants ADD CONSTRAINT merchants_account_manager_id_fkey
  FOREIGN KEY (tenant_id, account_manager_id) REFERENCES users (tenant_id, id) ON DELETE SET NULL (account_manager_id);
ALTER TABLE merchants DROP CONSTRAINT merchants_default_pickup_address_id_fkey;
ALTER TABLE merchants ADD CONSTRAINT merchants_default_pickup_address_id_fkey
  FOREIGN KEY (tenant_id, default_pickup_address_id) REFERENCES addresses (tenant_id, id) ON DELETE SET NULL (default_pickup_address_id);
-- ── mfa_recovery_codes ──────────────────────────────────────────────────────
ALTER TABLE mfa_recovery_codes DROP CONSTRAINT mfa_recovery_codes_user_id_fkey;
ALTER TABLE mfa_recovery_codes ADD CONSTRAINT mfa_recovery_codes_user_id_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE;
-- ── optimization_jobs ───────────────────────────────────────────────────────
ALTER TABLE optimization_jobs DROP CONSTRAINT optimization_jobs_route_id_fkey;
ALTER TABLE optimization_jobs ADD CONSTRAINT optimization_jobs_route_id_fkey
  FOREIGN KEY (tenant_id, route_id) REFERENCES routes (tenant_id, id) ON DELETE CASCADE;
-- ── pickup_shipments ────────────────────────────────────────────────────────
ALTER TABLE pickup_shipments DROP CONSTRAINT pickup_shipments_pickup_request_id_fkey;
ALTER TABLE pickup_shipments ADD CONSTRAINT pickup_shipments_pickup_request_id_fkey
  FOREIGN KEY (tenant_id, pickup_request_id) REFERENCES pickup_requests (tenant_id, id);
-- ── pod ─────────────────────────────────────────────────────────────────────
ALTER TABLE pod DROP CONSTRAINT pod_shipment_id_fkey;
ALTER TABLE pod ADD CONSTRAINT pod_shipment_id_fkey
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE CASCADE;
-- ── recipients ──────────────────────────────────────────────────────────────
ALTER TABLE recipients DROP CONSTRAINT recipients_default_address_id_fkey;
ALTER TABLE recipients ADD CONSTRAINT recipients_default_address_id_fkey
  FOREIGN KEY (tenant_id, default_address_id) REFERENCES addresses (tenant_id, id) ON DELETE SET NULL (default_address_id);
-- ── refresh_tokens ──────────────────────────────────────────────────────────
ALTER TABLE refresh_tokens DROP CONSTRAINT refresh_tokens_user_id_fkey;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE;
-- ── route_stops ─────────────────────────────────────────────────────────────
ALTER TABLE route_stops DROP CONSTRAINT route_stops_address_id_fkey;
ALTER TABLE route_stops ADD CONSTRAINT route_stops_address_id_fkey
  FOREIGN KEY (tenant_id, address_id) REFERENCES addresses (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE route_stops DROP CONSTRAINT route_stops_hub_id_fkey;
ALTER TABLE route_stops ADD CONSTRAINT route_stops_hub_id_fkey
  FOREIGN KEY (tenant_id, hub_id) REFERENCES hubs (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE route_stops DROP CONSTRAINT route_stops_route_id_fkey;
ALTER TABLE route_stops ADD CONSTRAINT route_stops_route_id_fkey
  FOREIGN KEY (tenant_id, route_id) REFERENCES routes (tenant_id, id) ON DELETE CASCADE;
-- ── routes ──────────────────────────────────────────────────────────────────
ALTER TABLE routes DROP CONSTRAINT routes_driver_id_fkey;
ALTER TABLE routes ADD CONSTRAINT routes_driver_id_fkey
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE routes DROP CONSTRAINT routes_end_hub_id_fkey;
ALTER TABLE routes ADD CONSTRAINT routes_end_hub_id_fkey
  FOREIGN KEY (tenant_id, end_hub_id) REFERENCES hubs (tenant_id, id) ON DELETE SET NULL (end_hub_id);
ALTER TABLE routes DROP CONSTRAINT routes_start_hub_id_fkey;
ALTER TABLE routes ADD CONSTRAINT routes_start_hub_id_fkey
  FOREIGN KEY (tenant_id, start_hub_id) REFERENCES hubs (tenant_id, id) ON DELETE SET NULL (start_hub_id);
ALTER TABLE routes DROP CONSTRAINT routes_vehicle_id_fkey;
ALTER TABLE routes ADD CONSTRAINT routes_vehicle_id_fkey
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles (tenant_id, id) ON DELETE RESTRICT;
-- ── settlement_shipments ────────────────────────────────────────────────────
ALTER TABLE settlement_shipments DROP CONSTRAINT settlement_shipments_settlement_id_fkey;
ALTER TABLE settlement_shipments ADD CONSTRAINT settlement_shipments_settlement_id_fkey
  FOREIGN KEY (tenant_id, settlement_id) REFERENCES settlements (tenant_id, id) ON DELETE CASCADE;
-- ── shifts ──────────────────────────────────────────────────────────────────
ALTER TABLE shifts DROP CONSTRAINT shifts_driver_id_fkey;
ALTER TABLE shifts ADD CONSTRAINT shifts_driver_id_fkey
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE shifts DROP CONSTRAINT shifts_hub_id_fkey;
ALTER TABLE shifts ADD CONSTRAINT shifts_hub_id_fkey
  FOREIGN KEY (tenant_id, hub_id) REFERENCES hubs (tenant_id, id) ON DELETE SET NULL (hub_id);
ALTER TABLE shifts DROP CONSTRAINT shifts_vehicle_id_fkey;
ALTER TABLE shifts ADD CONSTRAINT shifts_vehicle_id_fkey
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles (tenant_id, id) ON DELETE RESTRICT;
-- ── shipment_events ─────────────────────────────────────────────────────────
ALTER TABLE shipment_events DROP CONSTRAINT shipment_events_leg_id_fkey;
ALTER TABLE shipment_events ADD CONSTRAINT shipment_events_leg_id_fkey
  FOREIGN KEY (tenant_id, leg_id) REFERENCES shipment_legs (tenant_id, id);
ALTER TABLE shipment_events DROP CONSTRAINT shipment_events_shipment_id_fkey;
ALTER TABLE shipment_events ADD CONSTRAINT shipment_events_shipment_id_fkey
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE CASCADE;
-- ── shipment_legs ───────────────────────────────────────────────────────────
ALTER TABLE shipment_legs DROP CONSTRAINT shipment_legs_from_address_id_fkey;
ALTER TABLE shipment_legs ADD CONSTRAINT shipment_legs_from_address_id_fkey
  FOREIGN KEY (tenant_id, from_address_id) REFERENCES addresses (tenant_id, id);
ALTER TABLE shipment_legs DROP CONSTRAINT shipment_legs_shipment_id_fkey;
ALTER TABLE shipment_legs ADD CONSTRAINT shipment_legs_shipment_id_fkey
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipments (tenant_id, id) ON DELETE CASCADE;
ALTER TABLE shipment_legs DROP CONSTRAINT shipment_legs_to_address_id_fkey;
ALTER TABLE shipment_legs ADD CONSTRAINT shipment_legs_to_address_id_fkey
  FOREIGN KEY (tenant_id, to_address_id) REFERENCES addresses (tenant_id, id);
-- ── shipments ───────────────────────────────────────────────────────────────
ALTER TABLE shipments DROP CONSTRAINT shipments_destination_address_id_fkey;
ALTER TABLE shipments ADD CONSTRAINT shipments_destination_address_id_fkey
  FOREIGN KEY (tenant_id, destination_address_id) REFERENCES addresses (tenant_id, id);
ALTER TABLE shipments DROP CONSTRAINT shipments_merchant_id_fkey;
ALTER TABLE shipments ADD CONSTRAINT shipments_merchant_id_fkey
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id);
ALTER TABLE shipments DROP CONSTRAINT shipments_origin_address_id_fkey;
ALTER TABLE shipments ADD CONSTRAINT shipments_origin_address_id_fkey
  FOREIGN KEY (tenant_id, origin_address_id) REFERENCES addresses (tenant_id, id);
ALTER TABLE shipments DROP CONSTRAINT shipments_recipient_id_fkey;
ALTER TABLE shipments ADD CONSTRAINT shipments_recipient_id_fkey
  FOREIGN KEY (tenant_id, recipient_id) REFERENCES recipients (tenant_id, id);
-- ── user_roles ──────────────────────────────────────────────────────────────
ALTER TABLE user_roles DROP CONSTRAINT user_roles_user_id_fkey;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_user_id_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE;
-- ── users ───────────────────────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT users_merchant_id_fkey;
ALTER TABLE users ADD CONSTRAINT users_merchant_id_fkey
  FOREIGN KEY (tenant_id, merchant_id) REFERENCES merchants (tenant_id, id);
-- ── vehicles ────────────────────────────────────────────────────────────────
ALTER TABLE vehicles DROP CONSTRAINT vehicles_home_hub_id_fkey;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_home_hub_id_fkey
  FOREIGN KEY (tenant_id, home_hub_id) REFERENCES hubs (tenant_id, id) ON DELETE SET NULL (home_hub_id);
