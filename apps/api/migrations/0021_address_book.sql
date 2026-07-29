-- Merchant address book (docs/02-domain-model.md §3.19, open decision RM-R1).
--
-- ⚠️ NO SCHEMA CHANGE TO `recipients`. That is the decision, not an omission.
--
-- RM-R1 asked whether the address book is scoped to the Tenant or to
-- (Tenant, Merchant), and warned that once merchants get their own logins,
-- tenant scoping lets Merchant A see that Merchant B ships to the same person.
-- It also gave the resolution: "access must be filtered to recipients the
-- requesting merchant has actually shipped to."
--
-- Two ways to deliver that. The obvious one — add `recipients.merchant_id` and
-- reuse `current_merchant_allows()` — was rejected, for three reasons:
--
--   1. It breaks invariant I19. The unique key would become
--      (tenant_id, merchant_id, phone), so one human becomes several rows.
--   2. It destroys the entity's purpose. §3.19 exists so address quality and
--      delivery history ACCUMULATE PER PERSON. Split per merchant, a buyer who
--      has refused nine parcels looks brand new to the tenth merchant.
--   3. It splits the block-list. §3.19 rule 4 makes `is_blocked` the defence
--      against repeat refusers — the single most expensive problem in a COD
--      market. A per-merchant block-list defends nobody.
--
-- Measured against a real PostgreSQL 18, narrowing `recipients` by RLS is also
-- simply not implementable without a BYPASSRLS identity, which this platform
-- deliberately does not have. With the conflicting row hidden by a SELECT
-- policy, every route to its id fails:
--
--   INSERT                                  → 23505 unique_violation
--   INSERT .. ON CONFLICT DO UPDATE .. RETURNING → 42501 "new row violates
--                                             row-level security policy"
--   INSERT .. ON CONFLICT DO NOTHING .. RETURNING → no row, no id
--   UPDATE .. WHERE phone = ..              → 0 rows (SELECT policy filters
--                                             the rows an UPDATE can find)
--
-- So a merchant could never create a parcel for anyone already in the tenant's
-- book — the portal's single most important action, broken for exactly the
-- buyers who order most.
--
-- The resolution instead reads the merchant's book from `shipments`, which
-- migration 0020 already narrows to `merchant_id` in RLS. "Recipients I have
-- shipped to" is definitionally a projection of my own shipments, and every
-- shipment carries its own recipient snapshot (§3.19 rule 2), so nothing needs
-- to be joined back to `recipients` at all. Merchants therefore hold no
-- `recipient:*` permission and never read that table.
--
-- This file adds only the two indexes that projection needs.

-- ─────────────────────────────────────────────────────────────────────────────
-- Grouping a merchant's shipments by recipient phone.
--
-- Column order matters: RLS supplies `tenant_id` and `merchant_id` as equality
-- predicates, so leading with them lets the planner reach one merchant's rows
-- directly and take `recipient_phone` pre-sorted for the GROUP BY. `created_at
-- DESC` trails so "most recent parcel per person" needs no extra sort.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS shipments_merchant_recipient_idx
  ON shipments (tenant_id, merchant_id, recipient_phone, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Name search for the "who is this parcel for?" autocomplete.
--
-- Trigram rather than a prefix index: MENA names are transliterated
-- inconsistently ("Ben Ali" / "BenAli" / "Ben-Ali") and the merchant typing one
-- rarely starts at the beginning of the stored form. Mirrors
-- `recipients_name_trgm` in 0005.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS shipments_recipient_name_trgm
  ON shipments USING GIN (recipient_name gin_trgm_ops);

COMMENT ON INDEX shipments_merchant_recipient_idx IS
  'Serves the merchant address book — recipients derived from the merchant''s own shipments (RM-R1). Not a uniqueness constraint.';
