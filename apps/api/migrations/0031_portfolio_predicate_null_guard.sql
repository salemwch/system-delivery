-- Fixes `current_portfolio_allows` — the empty-string cast, one layer deeper.
--
-- 0030 shipped the predicate as:
--
--     SELECT CASE
--       WHEN COALESCE(current_setting('app.current_account_manager_id', true), '') = '' THEN TRUE
--       WHEN row_merchant_id IS NULL THEN FALSE
--       ELSE EXISTS (SELECT 1 FROM merchants m
--                     WHERE m.id = row_merchant_id
--                       AND m.account_manager_id = current_setting(...)::uuid)
--     END;
--
-- which fails with `invalid input syntax for type uuid: ""` for EVERY session
-- that is NOT a commercial login — that is, almost every request. Any insert or
-- select on `shipments` raises 22P02.
--
-- WHY, and why the 0020 comment about CASE was not enough:
--
-- CASE does guarantee ordered evaluation of its BRANCHES. That is what makes
-- `current_merchant_allows` safe — its ELSE is a scalar comparison, and it is
-- genuinely not evaluated when the guard fires.
--
-- An EXISTS is not a scalar. Postgres inlines a simple SQL function into the
-- calling query, and the subquery becomes a SubPlan — a separate plan node with
-- its own quals, which the executor may evaluate without regard to the CASE
-- branch that "contains" it. The cast therefore runs on the empty string even
-- though the branch guarding it returned TRUE.
--
-- THE FIX: `NULLIF(setting, '')::uuid`. `NULLIF('', '')` is NULL, and
-- `NULL::uuid` is a perfectly legal NULL rather than a parse error. The
-- comparison then yields NULL, EXISTS yields FALSE, and the CASE discards it —
-- so the guard's answer still wins, but nothing can raise on the way there.
--
-- Kept as `uuid = uuid` rather than comparing as text: `m.account_manager_id`
-- stays index-usable, and a text comparison would silently accept a
-- differently-formatted uuid string.
--
-- The same guard is applied to `current_account_manager_allows`, which is not
-- currently reachable in the broken way — its ELSE is scalar — but which has no
-- reason to keep a construct that only works because of where it happens to
-- sit. The two now read identically.
--
-- ⚠️ RULE, for any future predicate: NEVER cast a GUC to uuid without NULLIF.
-- The CASE guard protects scalars only.

CREATE OR REPLACE FUNCTION current_account_manager_allows(row_account_manager_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_account_manager_id', true), '') = '' THEN TRUE
    ELSE row_account_manager_id
         = NULLIF(current_setting('app.current_account_manager_id', true), '')::uuid
  END;
$$;

CREATE OR REPLACE FUNCTION current_portfolio_allows(row_merchant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.current_account_manager_id', true), '') = '' THEN TRUE
    -- Fails closed on a row with no merchant: it is the courier's own
    -- operation and is none of a commercial's business.
    WHEN row_merchant_id IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1 FROM merchants m
       WHERE m.id = row_merchant_id
         AND m.account_manager_id
             = NULLIF(current_setting('app.current_account_manager_id', true), '')::uuid
    )
  END;
$$;
