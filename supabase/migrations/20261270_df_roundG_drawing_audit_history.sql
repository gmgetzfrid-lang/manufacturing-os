-- ─────────────────────────────────────────────────────────────────────────────
-- 20261270_df_roundG_drawing_audit_history.sql
--
-- drafting-flow Round G — F5 DRAWING AUDIT HISTORY (drafting-flow EVID-14,
-- done-whens 1, 2 and 4; the integrator's rulings under DEC-90).
--
-- drawing_audit_logs keeps ONE row per (org, library, sheet, revision)
-- (20261124) and every writer upserts it: the drawing route
-- (app/api/knowledge/drawing/route.ts) and the orchestrator tool
-- log_audit_completion (lib/orchestrator/tools.ts). Neither can LOWER a
-- stored verdict (DWG-6), but a re-record at the same severity — or a raise —
-- replaced the stored status and findings in place, and nothing kept the
-- verdict it replaced. Nor did the row say who produced it.
--
--   1. THE HISTORY. drawing_audit_log_history: one row per verdict a write
--      REPLACED (an UPDATE that changed the row — the upsert conflict path) or
--      a delete REMOVED (a document delete cascades to its verdicts), holding
--      the replaced row whole (status, source, findings in audit_details,
--      audited_at, its key), what replaced it (status, source), when, and the
--      signed-in uid of the writer when there is one. Written ONLY by the
--      AFTER trigger drawing_audit_logs_record_history() in the same
--      statement as the change — every existing writer keeps working
--      unchanged, and drawing_audit_logs keeps its one current row per key,
--      so every reader of it answers exactly as before. No foreign key on
--      log_id or document_id: the history outlives the row and its document.
--      org_id cascades with the workspace: deleting a workspace deletes its
--      history, and its cascading verdict deletes write none.
--      Reading it: the SAME predicate as drawing_audit_logs_read (an active
--      member of the org) — never wider; the final SELECT compares the two
--      policy expressions. Writing it: nobody — INSERT, UPDATE, DELETE and
--      TRUNCATE are revoked from anon, authenticated and service_role, and no
--      write policy exists; only the trigger (SECURITY DEFINER, DRLS-16)
--      appends.
--   2. THE SOURCE. drawing_audit_logs.source, nullable, CHECK over
--      (engine, orchestrator, human): the drawing route writes engine, the
--      orchestrator tool writes orchestrator, and a signed-in session that
--      writes the row directly (the SURF-7 controller INSERT / UPDATE
--      policies, 20261048) is stamped human by the BEFORE trigger
--      drawing_audit_logs_stamp_source() whatever it sent — a person cannot
--      file a verdict as the engine. NULL = recorded before this column (no
--      row is backfilled: who wrote an existing row is not known, only
--      suggested — the inventory counts the suggestions).
--
-- What it does NOT do: no existing row, policy, index, function or grant of
-- drawing_audit_logs is changed (its three policies and its key are probed
-- unchanged below); no reader of it changes its answer.
-- WIDENS nothing: the new table is readable by exactly who reads
-- drawing_audit_logs, and writable by nobody but the trigger.
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261124 (the first statement refuses,
-- changing nothing, without drawing_audit_logs.library_id). Either order with
-- the app deploy is safe; RECOMMENDED: deploy the app first, then paste.
--   * App deployed, not pasted: each writer tries its write with source; the
--     database answers 42703 / PGRST204 (no such column, nothing written) and
--     the writer sends the write it sends today, byte-identical. No history.
--   * Pasted, app not yet deployed: the writers send no source (rows they
--     write keep NULL, or the source a newer write left); the history is kept
--     from the paste on, whatever the app version.
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS; the
-- REVOKEs are idempotent.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.drawing_audit_logs') IS NULL
     OR to_regclass('public.orgs') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'drawing_audit_logs'
                       AND column_name = 'library_id') THEN
    RAISE EXCEPTION '20261270 needs 20260929 and 20261124 (drawing_audit_logs.library_id) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS df_round_g_270_before;
CREATE TEMP TABLE df_round_g_270_before AS
SELECT 1 AS ord, 'inventory (before apply): drawing_audit_logs rows (all orgs)' AS inventory,
       COUNT(*)::text AS n FROM drawing_audit_logs
UNION ALL
SELECT 2, 'inventory (before apply): verdict rows filed for a library (library_id set) — source stays NULL, recorded before the column',
       COUNT(*)::text FROM drawing_audit_logs WHERE library_id IS NOT NULL
UNION ALL
SELECT 3, 'inventory (before apply): org-wide verdict rows (library_id NULL) — source stays NULL, recorded before the column',
       COUNT(*)::text FROM drawing_audit_logs WHERE library_id IS NULL
UNION ALL
SELECT 4, 'inventory (before apply): rows whose details name the orchestrator (audit_details source orchestrator) — a suggestion only, never backfilled',
       COUNT(*)::text FROM drawing_audit_logs WHERE audit_details ->> 'source' = 'orchestrator';
-- Row 5 reads the history only where it exists (a re-paste).
DO $$
DECLARE v_n bigint := 0;
BEGIN
  IF to_regclass('public.drawing_audit_log_history') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.drawing_audit_log_history' INTO v_n;
  END IF;
  INSERT INTO df_round_g_270_before (ord, inventory, n)
  VALUES (5, 'inventory (before apply): history rows already kept (0 on a first paste; a re-paste keeps every one)', v_n::text);
END
$$;

BEGIN;

-- ── 1. who produced the verdict ─────────────────────────────────────────────
ALTER TABLE drawing_audit_logs ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE drawing_audit_logs DROP CONSTRAINT IF EXISTS drawing_audit_logs_source_check;
ALTER TABLE drawing_audit_logs ADD CONSTRAINT drawing_audit_logs_source_check
  CHECK (source IS NULL OR source IN ('engine', 'orchestrator', 'human'));
COMMENT ON COLUMN drawing_audit_logs.source IS
  'EVID-14 (20261270): who produced the verdict. engine = the drawing route (the connector audit), orchestrator = the log_audit_completion tool (a controller confirmed it), human = a signed-in session writing the row directly (stamped by drawing_audit_logs_stamp_source). NULL = recorded before this column.';

CREATE OR REPLACE FUNCTION public.drawing_audit_logs_stamp_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- A signed-in session (PostgREST runs it as authenticated) writes as a
  -- person, whatever source it sent. The server paths (service_role) say
  -- which of engine or orchestrator produced the verdict.
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.source := 'human';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.drawing_audit_logs_stamp_source() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.drawing_audit_logs_stamp_source() IS
  'EVID-14 (20261270): a signed-in session writing drawing_audit_logs directly is recorded as source human; server writes keep the source they name.';

DROP TRIGGER IF EXISTS trg_drawing_audit_logs_stamp_source ON drawing_audit_logs;
CREATE TRIGGER trg_drawing_audit_logs_stamp_source
  BEFORE INSERT OR UPDATE ON drawing_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.drawing_audit_logs_stamp_source();

-- ── 2. the history of every verdict a write replaced or removed ────────────
CREATE TABLE IF NOT EXISTS drawing_audit_log_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id UUID NOT NULL,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID,
  document_id UUID,
  sheet_number TEXT NOT NULL,
  revision_code TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT,
  audit_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  audited_at TIMESTAMPTZ NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('replaced', 'deleted')),
  replaced_by_status TEXT,
  replaced_by_source TEXT,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS drawing_audit_log_history_key_idx
  ON drawing_audit_log_history (org_id, sheet_number, revision_code, changed_at);
CREATE INDEX IF NOT EXISTS drawing_audit_log_history_log_idx
  ON drawing_audit_log_history (log_id, changed_at);

COMMENT ON TABLE drawing_audit_log_history IS
  'EVID-14 (20261270): append-only. One row per drawing_audit_logs verdict that a write replaced (change replaced) or a delete removed (change deleted), the replaced row whole, written only by drawing_audit_logs_record_history in the same statement. No client or server role writes it.';
COMMENT ON COLUMN drawing_audit_log_history.log_id IS
  'The drawing_audit_logs row id, kept as a plain value (no foreign key): the history outlives the row.';
COMMENT ON COLUMN drawing_audit_log_history.document_id IS
  'The controlled document the replaced verdict named, kept as a plain value: a document delete removes its verdicts, and this history keeps them.';
COMMENT ON COLUMN drawing_audit_log_history.changed_by IS
  'auth.uid() of the session that made the change; NULL for a server write (the writer named in audit_details.by of the replacing row) or a cascade.';

ALTER TABLE drawing_audit_log_history ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON drawing_audit_log_history FROM anon, authenticated, service_role;

DROP POLICY IF EXISTS drawing_audit_log_history_read ON drawing_audit_log_history;
CREATE POLICY drawing_audit_log_history_read ON drawing_audit_log_history FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = drawing_audit_log_history.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
COMMENT ON POLICY drawing_audit_log_history_read ON drawing_audit_log_history IS
  'EVID-14: the same reader as drawing_audit_logs_read (an active member of the org). No write policy exists by design.';

CREATE OR REPLACE FUNCTION public.drawing_audit_logs_record_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_change text;
  v_status text;
  v_source text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The workspace itself is being deleted: its history goes with it.
    IF NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id) THEN
      RETURN NULL;
    END IF;
    v_change := 'deleted';
    v_status := NULL;
    v_source := NULL;
  ELSE
    v_change := 'replaced';
    v_status := NEW.status;
    v_source := NEW.source;
  END IF;
  INSERT INTO drawing_audit_log_history
    (log_id, org_id, library_id, document_id, sheet_number, revision_code, status, source,
     audit_details, audited_at, change, replaced_by_status, replaced_by_source, changed_by)
  VALUES
    (OLD.id, OLD.org_id, OLD.library_id, OLD.document_id, OLD.sheet_number, OLD.revision_code, OLD.status, OLD.source,
     OLD.audit_details, OLD.audited_at, v_change, v_status, v_source, auth.uid());
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.drawing_audit_logs_record_history() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.drawing_audit_logs_record_history() IS
  'EVID-14 (20261270): appends the replaced or removed drawing_audit_logs row to drawing_audit_log_history in the same statement. SECURITY DEFINER (search_path pinned, EXECUTE revoked from every client role — DRLS-16): the history has no write grant or policy for any client.';

DROP TRIGGER IF EXISTS trg_drawing_audit_logs_history_update ON drawing_audit_logs;
CREATE TRIGGER trg_drawing_audit_logs_history_update
  AFTER UPDATE ON drawing_audit_logs
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.drawing_audit_logs_record_history();

DROP TRIGGER IF EXISTS trg_drawing_audit_logs_history_delete ON drawing_audit_logs;
CREATE TRIGGER trg_drawing_audit_logs_history_delete
  AFTER DELETE ON drawing_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.drawing_audit_logs_record_history();

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT v."check", v.ok, v.n FROM (
SELECT 0 AS ord,
       'drawing_audit_logs.source exists (text, nullable) with its CHECK over engine, orchestrator, human' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'drawing_audit_logs'
                  AND column_name = 'source' AND data_type = 'text' AND is_nullable = 'YES')
       AND EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.drawing_audit_logs'::regclass
                      AND c.conname = 'drawing_audit_logs_source_check' AND c.contype = 'c' AND c.convalidated
                      AND pg_get_constraintdef(c.oid) LIKE '%engine%'
                      AND pg_get_constraintdef(c.oid) LIKE '%orchestrator%'
                      AND pg_get_constraintdef(c.oid) LIKE '%human%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 0, 'drawing_audit_log_history exists with row-level security enabled',
       EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                WHERE ns.nspname = 'public' AND c.relname = 'drawing_audit_log_history' AND c.relrowsecurity),
       NULL
UNION ALL
SELECT 0, 'drawing_audit_log_history: exactly one policy, SELECT, with the same expression as drawing_audit_logs_read (never wider)',
       (SELECT COUNT(*) = 1 AND bool_and(h.cmd = 'SELECT')
               AND bool_and(h.qual = replace(r.qual, 'drawing_audit_logs.org_id', 'drawing_audit_log_history.org_id'))
               AND bool_and(h.roles = r.roles)
          FROM pg_policies h
          JOIN pg_policies r ON r.schemaname = 'public' AND r.tablename = 'drawing_audit_logs' AND r.policyname = 'drawing_audit_logs_read'
         WHERE h.schemaname = 'public' AND h.tablename = 'drawing_audit_log_history')
       AND (SELECT COUNT(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drawing_audit_log_history'),
       NULL
UNION ALL
SELECT 0, 'drawing_audit_log_history: no INSERT, UPDATE, DELETE or TRUNCATE for anon, authenticated or service_role',
       NOT has_table_privilege('anon', 'public.drawing_audit_log_history', 'INSERT, UPDATE, DELETE, TRUNCATE')
       AND NOT has_table_privilege('authenticated', 'public.drawing_audit_log_history', 'INSERT, UPDATE, DELETE, TRUNCATE')
       AND NOT has_table_privilege('service_role', 'public.drawing_audit_log_history', 'INSERT, UPDATE, DELETE, TRUNCATE'),
       NULL
UNION ALL
SELECT 0, 'drawing_audit_logs_record_history(): SECURITY DEFINER, search_path pinned, EXECUTE for no client role (DRLS-16)',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'drawing_audit_logs_record_history'
                  AND p.prosecdef AND 'search_path=public' = ANY (p.proconfig))
       AND NOT has_function_privilege('anon', 'public.drawing_audit_logs_record_history()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.drawing_audit_logs_record_history()', 'EXECUTE')
       AND NOT has_function_privilege('service_role', 'public.drawing_audit_logs_record_history()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 0, 'drawing_audit_logs_stamp_source(): SECURITY INVOKER, search_path pinned, EXECUTE for no client role',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'drawing_audit_logs_stamp_source'
                  AND NOT p.prosecdef AND 'search_path=public' = ANY (p.proconfig))
       AND NOT has_function_privilege('anon', 'public.drawing_audit_logs_stamp_source()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.drawing_audit_logs_stamp_source()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 0, 'the three triggers are bound to drawing_audit_logs: source stamp (BEFORE INSERT OR UPDATE), history on a changing UPDATE, history on DELETE',
       (SELECT COUNT(*) = 3 FROM pg_trigger t
         WHERE t.tgrelid = 'public.drawing_audit_logs'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
           AND t.tgname IN ('trg_drawing_audit_logs_stamp_source', 'trg_drawing_audit_logs_history_update', 'trg_drawing_audit_logs_history_delete'))
       AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.drawing_audit_logs'::regclass
                     AND t.tgname = 'trg_drawing_audit_logs_history_update'
                     AND pg_get_triggerdef(t.oid) LIKE '%AFTER UPDATE%WHEN ((old.* IS DISTINCT FROM new.*))%'),
       NULL
UNION ALL
SELECT 0, 'drawing_audit_logs unchanged: its key UNIQUE (org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT, and exactly its three policies (member SELECT, controller INSERT / UPDATE; no DELETE)',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'drawing_audit_logs'
                  AND indexname = 'drawing_audit_logs_scope_sheet_rev_idx'
                  AND indexdef LIKE '%(org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT%')
       AND (SELECT COUNT(*) = 3 AND COUNT(*) FILTER (WHERE cmd = 'DELETE') = 0
              FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drawing_audit_logs'),
       NULL
UNION ALL
SELECT ord, inventory, NULL, n FROM df_round_g_270_before
UNION ALL
SELECT 6, 'inventory (after apply): history rows kept', NULL, COUNT(*)::text FROM drawing_audit_log_history
) v
ORDER BY v.ord, v."check";
