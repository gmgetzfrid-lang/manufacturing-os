-- ─────────────────────────────────────────────────────────────────────────────
-- 20261268_df_roundG_issuing_path_stops.sql
--
-- drafting-flow Round G — DF-P26 ISSUING-PATH STOPS (DEC-90 rulings for
-- DF-P26: industry best practice, fail-safe, no regression). One DEC-30
-- paste, for GAP-115 / GAP-109 mechanism 3, EXCEPTION-ONLY REVIEW: the roster
-- ledger learns to record a slot satisfied by the exception-only RULE (a
-- recorded system act — no signer, no signature) and a slot RE-OPENED for its
-- reviewer when an exception came on record before the request issued.
-- (GAP-116 — a notify-only hold that stops the request — and GAP-102
-- acceptance 2 — the issue notice's examination data — need no database
-- change: they read what 20261266 / 20261267 already store.)
--
--   (1) ticket_review_slots.satisfied_via — re-created from its NEWEST body
--       (20261264 §3) with exactly one value added: 'rule'.
--   (2) ticket_review_slots_satisfied_shape — re-created from its NEWEST
--       body (20261255 §5) with exactly one alternative added: a slot
--       satisfied by the rule is a BLOCKING slot that names no signer and no
--       signature (as a consent window's names neither); the signer branch no
--       longer admits 'rule' either (so a rule satisfaction can never claim a
--       signer). Every other satisfied slot still names its signer and its
--       signature.
--   (3) ticket_review_slot_events' event CHECK — re-created from its NEWEST
--       (and only) body (20261242 §2, the inline column CHECK, by its
--       default name ticket_review_slot_events_event_check) with exactly one
--       value added: 'reopened'. The append-only trigger is untouched: a
--       re-open is a NEW event row, never a rewrite.
--   (4) exception_only_review_ready() — new; returns true. The app asks it
--       (one RPC, only when a submission opens a roster carrying an
--       exception-only slot) before it satisfies any slot by the rule: until
--       this file is pasted the function is missing (PGRST202 / 42883) and
--       the rule applies nothing — the slot waits for its sign-off, exactly
--       as today. SECURITY INVOKER, search_path pinned, executable only by
--       the service role (the route and the cron).
--
-- NOT a widening of who may do anything: no policy, no grant to a client
-- role, no SECURITY DEFINER. (1)–(3) widen what the service-written ledger
-- may record by exactly the rule's two facts; the app writes them only for a
-- slot a document controller opted in (lib/routingControl.ts exception_only)
-- and only under lib/exceptionOnlyReview.ts's conditions. The counts-only
-- inventory is captured first (DEC-30).
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261264 (the first statement refuses,
-- changing nothing, without 20261242's ledger, 20261255's shape CHECK,
-- 20261264's satisfied_via value 'preauthorization' or 20261241's
-- routing_control columns, which the inventory reads). Either order with the
-- DF-P26 deploy is safe; RECOMMENDED: deploy the app FIRST, then paste.
--   * App deployed, not pasted: exception_only_review_ready() is missing, so
--     no slot is ever satisfied by the rule — every exception-only slot waits
--     for its sign-off (today's review) and the audit row says why
--     (`exceptionReview.ruleNotApplied: "not_migrated"`); there is nothing to
--     re-open. GAP-116 and GAP-102 acceptance 2 work as they read only
--     existing columns.
--   * Pasted, app not deployed: nothing writes 'rule' or 'reopened'; the old
--     app writes what it always wrote, which the widened CHECKs accept.
--   * NEVER re-paste 20261242, 20261255 or 20261264 after this file without
--     pasting this file again right after: each restores a CHECK without the
--     rule's value — a later rule satisfaction would then be refused by the
--     ledger (the request's own record keeps it; the consent close then holds
--     on the ledger disagreeing — fail-safe — until this file is re-pasted).
--     Once a rule satisfaction is on record such a re-paste is itself
--     refused as a whole (its CHECK cannot be re-added over the row) and
--     changes nothing.
-- Independent of every other pending migration.
-- Re-runnable: each CHECK dropped IF EXISTS and re-added; CREATE OR REPLACE.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.ticket_review_slots') IS NULL OR to_regclass('public.ticket_review_slot_events') IS NULL THEN
    RAISE EXCEPTION '20261268 needs 20261242 (the review roster ledger) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_shape'
                   AND pg_get_constraintdef(oid) LIKE '%consent_window%') THEN
    RAISE EXCEPTION '20261268 needs 20261255 (the consent window: the ledger''s consent shape) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_via_check'
                   AND pg_get_constraintdef(oid) LIKE '%preauthorization%') THEN
    RAISE EXCEPTION '20261268 needs 20261264 (standing pre-authorization: the ledger''s preauthorization value) pasted first; nothing was changed.';
  END IF;
  IF (SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'routing_control'
         AND table_name IN ('libraries', 'collections', 'documents')) < 3 THEN
    RAISE EXCEPTION '20261268 needs 20261241 (routing tables: routing_control on libraries, collections and documents) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_268_before;
CREATE TEMP TABLE df_round_g_268_before AS
SELECT 1 AS ord, 'inventory (before apply): roster ledger slots (ticket_review_slots rows) — none is changed; each keeps its satisfied_via' AS inventory,
       COUNT(*)::text AS n
  FROM ticket_review_slots
UNION ALL
SELECT 2, 'inventory (before apply): roster ledger events (ticket_review_slot_events rows) — none is changed (the table stays append-only)',
       COUNT(*)::text FROM ticket_review_slot_events
UNION ALL
SELECT 3, 'inventory (before apply): routing tables (libraries + folders + documents) storing exception_only on a slot (expected 0 — no editor wrote one before DF-P26; from the DF-P26 deploy such an opt-in is honoured)',
       ((SELECT COUNT(*) FROM libraries WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.exception_only == true)'))
      + (SELECT COUNT(*) FROM collections WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.exception_only == true)'))
      + (SELECT COUNT(*) FROM documents WHERE jsonb_path_exists(routing_control, '$.slots[*] ? (@.exception_only == true)')))::text;

BEGIN;

-- ── 1. the roster ledger: a slot satisfied by the exception-only rule ───────
-- Re-created from its newest body (20261264 §3), one value added.
ALTER TABLE ticket_review_slots DROP CONSTRAINT IF EXISTS ticket_review_slots_satisfied_via_check;
ALTER TABLE ticket_review_slots ADD CONSTRAINT ticket_review_slots_satisfied_via_check
  CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override', 'consent', 'preauthorization', 'rule'));

-- ── 2. the shape: a rule satisfaction is a blocking slot with no signer ─────
-- Re-created from its newest body (20261255 §5): the signer branch no longer
-- admits 'rule', and one alternative is added for it.
ALTER TABLE ticket_review_slots DROP CONSTRAINT IF EXISTS ticket_review_slots_satisfied_shape;
ALTER TABLE ticket_review_slots ADD CONSTRAINT ticket_review_slots_satisfied_shape CHECK (
  (status = 'satisfied') = (satisfied_at IS NOT NULL AND (
    (satisfied_by IS NOT NULL AND signature_id IS NOT NULL AND satisfied_via IS DISTINCT FROM 'consent' AND satisfied_via IS DISTINCT FROM 'rule')
    OR (satisfied_via = 'consent' AND mode = 'consent_window' AND satisfied_by IS NULL AND signature_id IS NULL)
    OR (satisfied_via = 'rule' AND mode = 'blocking' AND satisfied_by IS NULL AND signature_id IS NULL)))
);

-- ── 3. the events: a slot re-opened for its reviewer ────────────────────────
-- Re-created from its newest (and only) body (20261242 §2's inline CHECK),
-- one value added.
ALTER TABLE ticket_review_slot_events DROP CONSTRAINT IF EXISTS ticket_review_slot_events_event_check;
ALTER TABLE ticket_review_slot_events ADD CONSTRAINT ticket_review_slot_events_event_check
  CHECK (event IN ('opened', 'told', 'satisfied', 'voided', 'reopened'));

-- ── 4. the readiness probe the app asks before it applies the rule ──────────
CREATE OR REPLACE FUNCTION exception_only_review_ready()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT true
$$;
REVOKE ALL ON FUNCTION exception_only_review_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION exception_only_review_ready() TO service_role;

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 4 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'GAP-115: the roster ledger takes a slot satisfied by the exception-only rule (satisfied_via adds ''rule''; every earlier value kept)' AS check,
       COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%''rule''%' AND pg_get_constraintdef(oid) LIKE '%''preauthorization''%'
                   AND pg_get_constraintdef(oid) LIKE '%''consent''%' AND pg_get_constraintdef(oid) LIKE '%''override''%'
                   FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_via_check'), false) AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'a rule satisfaction is a blocking slot naming no signer and no signature; every other satisfied slot but a consent window''s still names its signer and its signature',
       COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%signature_id IS NOT NULL%' AND pg_get_constraintdef(oid) LIKE '%consent_window%'
                   AND pg_get_constraintdef(oid) LIKE '%''rule''%' AND pg_get_constraintdef(oid) LIKE '%''blocking''%'
                   FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_shape'), false),
       NULL
UNION ALL
SELECT 1, 3, 'the roster ledger records a slot re-opened for its reviewer (event adds ''reopened''); the events stay append-only (trigger enabled)',
       COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%''reopened''%' AND pg_get_constraintdef(oid) LIKE '%''voided''%'
                   FROM pg_constraint WHERE conname = 'ticket_review_slot_events_event_check'), false)
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_review_slot_events_append_only'
                     AND tgrelid = 'public.ticket_review_slot_events'::regclass AND NOT tgisinternal AND tgenabled = 'O'),
       NULL
UNION ALL
SELECT 1, 4, 'exception_only_review_ready() answers true; SECURITY INVOKER, search_path pinned; only the service role executes it',
       COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'exception_only_review_ready'), false)
       AND has_function_privilege('service_role', 'public.exception_only_review_ready()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.exception_only_review_ready()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.exception_only_review_ready()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_268_before
UNION ALL
SELECT 3, 1, 'after: roster ledger slots satisfied by the rule (0 right after a first paste)', NULL,
       (SELECT COUNT(*) FROM ticket_review_slots WHERE satisfied_via = 'rule')::text
) AS final_rows
ORDER BY sec, ord;
