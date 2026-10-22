-- ─────────────────────────────────────────────────────────────────────────────
-- 20261266_df_roundG_examination_scope.sql
--
-- drafting-flow Round G — DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE
-- (GAP-102 acceptances 4 and 1; the integrator's rulings (1)–(3) and (6) for
-- DF-P24 under DEC-90: industry best practice, fail-safe, no regression).
-- One addition, nothing renamed, no existing function, policy or trigger
-- re-created:
--
--   ticket_examination_scopes (new) — the examination data a request carries:
--   one row per request, `field_values` = { <field key>: { value, by, byName,
--   at } } with each value picked from the workspace's own list (the fields
--   and their values are configuration — org_configurations 'drafting', key
--   examinationScope, Admin → Request forms; DEC-35: no facility word in
--   code), and `waiver` = why the request issues without data its
--   requirement names (a required reason, who, when, the fields it covers and
--   the revision it was recorded for) or NULL. Written ONLY by the service
--   role (/api/tickets/examination-scope, after its checks: the drafter or
--   the engineer already in the flow, or the assignment queue, records
--   values; a person who holds the issue authority records a waiver; each
--   write's audit row first). Read as the request reads (a member who can
--   read the ticket reads its row). No client holds a write grant or policy.
--   A guard trigger (SECURITY INVOKER, search_path pinned) keeps each row in
--   its request's workspace and its request fixed. Removed with its request
--   (ON DELETE CASCADE) or workspace.
--
-- The workflow route's issue gate reads this row only for a request a
-- configured requirement applies to; a workspace that configures nothing
-- never reads it (today's path, byte for byte).
--
-- PASTE / DEPLOY ORDER. Either order is safe; RECOMMENDED: deploy the app
-- first, then paste.
--   * App deployed, not pasted: no examination data can be recorded (the
--     fill route answers 503 not_migrated, said) and a configured requirement
--     never refuses an issue (a 42P01 / PGRST205 on the table reads as "not
--     migrated": the issue goes ahead, its audit row says the data could not
--     be checked) — today's path.
--   * Pasted, app not yet deployed: nothing reads or writes the table.
--   * No workspace has a requirement at the paste: the inventory counts the
--     drafting configurations already carrying an examinationScope key
--     (expected 0) and the requests open at the paste (a requirement binds
--     only requests filed after it is stored, so none of them is ever newly
--     blocked).
--
-- Not a widening of any existing authority: one new table, readable exactly
-- as its request is; no client gains a write; no SECURITY DEFINER. The
-- counts-only inventory is captured first anyway (DEC-30).
-- Re-runnable: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, DROP … IF
-- EXISTS.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.tickets') IS NULL OR to_regclass('public.org_configurations') IS NULL THEN
    RAISE EXCEPTION '20261266 needs the tickets and org_configurations tables; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_266_before;
CREATE TEMP TABLE df_round_g_266_before AS
SELECT 1 AS ord, 'inventory (before apply): workspaces whose request-form configuration already carries an examinationScope key (expected 0 — none means no requirement and no gate anywhere)' AS inventory,
       COUNT(*)::text AS n
  FROM org_configurations
 WHERE key = 'drafting' AND jsonb_typeof(data) = 'object' AND data ? 'examinationScope'
UNION ALL
SELECT 2, 'inventory (before apply): requests open at the paste (not closed, canceled or archived) — a requirement binds only requests filed after it is stored, so none of these is ever newly blocked (each shows what is missing as a warning)',
       COUNT(*)::text
  FROM tickets
 WHERE status NOT IN ('CLOSED', 'CANCELED') AND archived_at IS NULL;

BEGIN;

CREATE TABLE IF NOT EXISTS ticket_examination_scopes (
  ticket_id UUID PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  field_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  waiver JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID,
  CONSTRAINT ticket_examination_scopes_values_object CHECK (jsonb_typeof(field_values) = 'object'),
  CONSTRAINT ticket_examination_scopes_waiver_object CHECK (waiver IS NULL OR jsonb_typeof(waiver) = 'object')
);
CREATE INDEX IF NOT EXISTS ticket_examination_scopes_org_idx ON ticket_examination_scopes (org_id);

CREATE OR REPLACE FUNCTION ticket_examination_scopes_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN
    RAISE EXCEPTION 'a request''s examination data stays with its request.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tickets t WHERE t.id = NEW.ticket_id AND t.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'a request''s examination data belongs to its request''s workspace.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION ticket_examination_scopes_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_ticket_examination_scopes_guard ON ticket_examination_scopes;
CREATE TRIGGER trg_ticket_examination_scopes_guard
BEFORE INSERT OR UPDATE ON ticket_examination_scopes
FOR EACH ROW EXECUTE FUNCTION ticket_examination_scopes_guard();

ALTER TABLE ticket_examination_scopes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_examination_scopes_read ON ticket_examination_scopes;
CREATE POLICY ticket_examination_scopes_read ON ticket_examination_scopes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_examination_scopes.ticket_id AND t.org_id = ticket_examination_scopes.org_id));
GRANT SELECT ON ticket_examination_scopes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_examination_scopes TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ticket_examination_scopes FROM anon, authenticated;
REVOKE ALL ON ticket_examination_scopes FROM anon;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'ticket_examination_scopes exists: one row per request (ticket_id primary key, cascading), its workspace, the values object and the waiver'::text AS check,
       (to_regclass('public.ticket_examination_scopes') IS NOT NULL
        AND (SELECT COUNT(*) = 6 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'ticket_examination_scopes'
                AND column_name IN ('ticket_id', 'org_id', 'field_values', 'waiver', 'updated_at', 'updated_by'))
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_examination_scopes_pkey')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_examination_scopes_values_object')
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_examination_scopes_waiver_object')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'row level security is on; ONE policy, a SELECT read as the request reads; no write policy',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ticket_examination_scopes'::regclass), false)
       AND (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_examination_scopes' AND cmd = 'SELECT'
             AND qual LIKE '%FROM tickets t%' AND qual LIKE '%t.org_id = ticket_examination_scopes.org_id%')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ticket_examination_scopes' AND cmd <> 'SELECT'),
       NULL
UNION ALL
SELECT 1, 3, 'no client writes it: authenticated holds no INSERT / UPDATE / DELETE grant, anon not even SELECT; the service role writes',
       has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ticket_examination_scopes', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.ticket_examination_scopes', 'SELECT')
       AND has_table_privilege('service_role', 'public.ticket_examination_scopes', 'INSERT')
       AND has_table_privilege('service_role', 'public.ticket_examination_scopes', 'UPDATE'),
       NULL
UNION ALL
SELECT 1, 4, 'the guard keeps each row in its request''s workspace and its request fixed (SECURITY INVOKER, search_path pinned, executable by no client role; enabled)',
       COALESCE((SELECT NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                   AND p.prosrc LIKE '%t.org_id = NEW.org_id%' AND p.prosrc LIKE '%NEW.ticket_id IS DISTINCT FROM OLD.ticket_id%'
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'ticket_examination_scopes_guard'), false)
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_examination_scopes_guard' AND NOT tgisinternal AND tgenabled = 'O')
       AND NOT has_function_privilege('authenticated', 'public.ticket_examination_scopes_guard()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.ticket_examination_scopes_guard()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM df_round_g_266_before
UNION ALL
SELECT 3, 1, 'after: requests with examination data on record (0 right after the first paste)', NULL,
       (SELECT COUNT(*) FROM ticket_examination_scopes)::text
) AS final_rows
ORDER BY sec, ord;
