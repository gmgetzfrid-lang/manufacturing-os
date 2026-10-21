-- ─────────────────────────────────────────────────────────────────────────────
-- 20261242_df_roundG_ticket_roster.sql
--
-- drafting-flow Round G — DF-P5 ROSTER: the ledger of the ticket's parallel
-- reviewer roster (GAP-103; DEC-37; EVID-12).
--
-- The workflow route opens a roster when a draft enters review in a library
-- that declares a routing table (20261241), and carries the live roster on
-- the ticket row (tickets.metadata.review_roster, written compare-and-set
-- with the status, so the slots and the status move together). These two
-- tables are its RECORD — queryable ("N blocking sign-offs last month, each
-- by whom") and append-only where it matters:
--
--   (1) ticket_review_slots — one row per slot of a roster: the slot's kind
--       and mode, its occupants (primaries / alternates / overriders), the
--       parties and slots it is independent of, the content hash every
--       sign-off is bound to (sha256 over the files under review, computed
--       by the server), and — once satisfied — by whom, when, how (primary /
--       alternate / override) and under which e-signature.
--   (2) ticket_review_slot_events — one row per thing that happened to a
--       slot (opened, told, satisfied, voided). APPEND-ONLY: an UPDATE is
--       refused for every role; a DELETE only once the ticket itself is gone
--       (its ON DELETE CASCADE — the ticket shed's delete keeps working) or
--       its org is (an org's deletion, whichever cascade fires first).
--
-- Row security: SELECT for whoever can read the ticket — the policy asks the
-- tickets table, so the ticket's own read scope (20261166, the Contractor
-- scope included) decides. No INSERT / UPDATE / DELETE policy: only the
-- service role (the workflow route) writes; the client grants are revoked
-- too. No SECURITY DEFINER function is called by a client; the one trigger
-- function is SECURITY DEFINER with search_path pinned and EXECUTE revoked
-- (DRLS-16).
--
-- NOT A WIDENING (two new tables nobody but the service role writes).
-- Counts-only inventory BEFORE the transaction (DEC-30).
--
-- PASTE / DEPLOY ORDER. Independent of 20261241 (either first). The app
-- carrying DF-P5 works BEFORE this paste: a routed submission finds no ledger
-- (42P01 / PGRST205) and goes for review the usual way, saying so; and AFTER
-- it. Re-runnable: IF NOT EXISTS everywhere, CREATE OR REPLACE, DROP … IF
-- EXISTS. Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text).  ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_242_before;
CREATE TEMP TABLE df_round_g_242_before AS
SELECT 1 AS ord, 'inventory (before apply): tickets under review now (PENDING_REVIEW / PENDING_FINAL_APPROVAL) — they finish on today''s path; a roster opens only at a later submission into a routed library' AS inventory,
       COUNT(*)::text AS n
  FROM tickets WHERE status IN ('PENDING_REVIEW', 'PENDING_FINAL_APPROVAL')
UNION ALL
SELECT 2, 'inventory (before apply): ticket e-signatures already on record (resource_type = ticket)',
       COUNT(*)::text FROM e_signatures WHERE resource_type = 'ticket';

BEGIN;

-- ── 1. the slots ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_review_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  roster_id UUID NOT NULL,
  cycle TEXT,
  slot_kind TEXT NOT NULL,
  label TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('blocking', 'consent_window', 'notify_only')),
  primaries UUID[] NOT NULL DEFAULT '{}',
  alternates UUID[] NOT NULL DEFAULT '{}',
  overriders UUID[] NOT NULL DEFAULT '{}',
  independent_of TEXT[] NOT NULL DEFAULT '{}',
  timeout_days INTEGER CHECK (timeout_days IS NULL OR timeout_days BETWEEN 1 AND 365),
  fallback BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL CHECK (status IN ('open', 'satisfied', 'told', 'void')),
  content_hash TEXT NOT NULL,
  signature_id UUID,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  satisfied_at TIMESTAMPTZ,
  satisfied_by UUID,
  satisfied_via TEXT CHECK (satisfied_via IS NULL OR satisfied_via IN ('primary', 'alternate', 'override')),
  closed_at TIMESTAMPTZ,
  closed_reason TEXT,
  UNIQUE (roster_id, slot_kind),
  -- A satisfied slot names who, when and the bound signature; nothing else does.
  CONSTRAINT ticket_review_slots_satisfied_shape CHECK (
    (status = 'satisfied') = (satisfied_by IS NOT NULL AND satisfied_at IS NOT NULL AND signature_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS ticket_review_slots_ticket_idx ON ticket_review_slots (ticket_id, opened_at);
CREATE INDEX IF NOT EXISTS ticket_review_slots_org_status_idx ON ticket_review_slots (org_id, status, opened_at);

-- ── 2. the events (append-only) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_review_slot_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  roster_id UUID NOT NULL,
  slot_kind TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('opened', 'told', 'satisfied', 'voided')),
  actor_id UUID,
  actor_name TEXT,
  signature_id UUID,
  content_hash TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ticket_review_slot_events_ticket_idx ON ticket_review_slot_events (ticket_id, created_at);

CREATE OR REPLACE FUNCTION ticket_review_slot_events_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ticket_review_slot_events is append-only: a roster event is never rewritten.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A DELETE passes only once its ticket is gone (the ON DELETE CASCADE of a
  -- ticket the shed archived) or its org is gone (an org's deletion: the
  -- orgs -> events cascade may run BEFORE the orgs -> tickets one — the RI
  -- triggers fire in name order — and each runs after the org row is gone).
  IF EXISTS (SELECT 1 FROM tickets WHERE id = OLD.ticket_id)
     AND EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    RAISE EXCEPTION 'ticket_review_slot_events is append-only: a roster event is removed only with its ticket.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION ticket_review_slot_events_append_only() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_review_slot_events_append_only ON ticket_review_slot_events;
CREATE TRIGGER trg_ticket_review_slot_events_append_only
BEFORE UPDATE OR DELETE ON ticket_review_slot_events
FOR EACH ROW EXECUTE FUNCTION ticket_review_slot_events_append_only();

-- ── 3. row security: read as the ticket reads; write as the service role ───
ALTER TABLE ticket_review_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_review_slot_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_review_slots_read ON ticket_review_slots;
CREATE POLICY ticket_review_slots_read ON ticket_review_slots
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_review_slots.ticket_id AND t.org_id = ticket_review_slots.org_id));

DROP POLICY IF EXISTS ticket_review_slot_events_read ON ticket_review_slot_events;
CREATE POLICY ticket_review_slot_events_read ON ticket_review_slot_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_review_slot_events.ticket_id AND t.org_id = ticket_review_slot_events.org_id));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_review_slots FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_review_slot_events FROM anon, authenticated;
REVOKE ALL ON ticket_review_slots FROM anon;
REVOKE ALL ON ticket_review_slot_events FROM anon;

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 6 on a correct paste. Inventory rows: n = the count.
SELECT 'GAP-103: ticket_review_slots and ticket_review_slot_events exist, row security on' AS check,
       (SELECT COUNT(*) = 2 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname IN ('ticket_review_slots', 'ticket_review_slot_events') AND c.relrowsecurity) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'read follows the ticket: one SELECT policy each, asking the tickets table; no write policy',
       (SELECT COUNT(*) = 2 FROM pg_policies WHERE schemaname = 'public'
         AND tablename IN ('ticket_review_slots', 'ticket_review_slot_events') AND cmd = 'SELECT'
         AND qual LIKE '%FROM tickets t%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                        AND tablename IN ('ticket_review_slots', 'ticket_review_slot_events') AND cmd <> 'SELECT'),
       NULL
UNION ALL
SELECT 'no client role may insert, update or delete either table',
       NOT has_table_privilege('authenticated', 'public.ticket_review_slots', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_review_slots', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ticket_review_slot_events', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_review_slot_events', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.ticket_review_slots', 'SELECT'),
       NULL
UNION ALL
SELECT 'a satisfied slot names who, when and the bound signature (CHECK)',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_review_slots_satisfied_shape'),
       NULL
UNION ALL
SELECT 'events are append-only (BEFORE UPDATE OR DELETE trigger, enabled); a delete passes once the ticket or the org is gone',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_review_slot_events_append_only' AND NOT tgisinternal AND tgenabled = 'O')
       AND (SELECT prosrc LIKE '%EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id)%' FROM pg_proc WHERE proname = 'ticket_review_slot_events_append_only'),
       NULL
UNION ALL
SELECT 'DRLS-16: the trigger function is SECURITY DEFINER with search_path pinned, EXECUTE revoked from anon and authenticated',
       (SELECT prosecdef AND proconfig @> ARRAY['search_path=public'] FROM pg_proc WHERE proname = 'ticket_review_slot_events_append_only')
       AND NOT has_function_privilege('anon', 'public.ticket_review_slot_events_append_only()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.ticket_review_slot_events_append_only()', 'EXECUTE'),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM (SELECT ord, inventory, n FROM df_round_g_242_before ORDER BY ord) b
UNION ALL
SELECT 'after: roster slots on record', NULL, (SELECT COUNT(*) FROM ticket_review_slots)::text;
