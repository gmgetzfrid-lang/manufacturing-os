-- 20261198_prj_roundG_milestone_project_and_party_delete.sql
--
-- projects Round G — J19 PROJECTS REMAINDERS. Two database rails, in one
-- paste. The numbers below are the body's section numbers (the `-- ── n.`
-- headings), which the records cite.
--
-- WHAT:
--   1. projects-tab SEC-21 residual 3 — a milestone keeps its project.
--      `enforce_milestone_project_move` (BEFORE UPDATE OF project_id ON
--      milestones, WHEN the value changes; SECURITY DEFINER, search_path
--      pinned, EXECUTE revoked from PUBLIC, anon and authenticated): a
--      signed-in write that moves a milestone onto, off or between projects
--      is refused unless the caller holds schedule-editing authority on
--      EVERY project the move touches — `can_edit_project_schedule`
--      (20261098: the Admin / DocCtrl / Manager / Supervisor role collection,
--      or the project's owner; the predicate apply_milestone_moves and the
--      baseline RPCs already enforce). A move onto a project of another
--      workspace is refused outright, and so is any signed-in move onto or
--      off a PRIVATE project, whoever makes it: the rows a milestone wrote
--      keep the reach of the scope they were written under (20261157 §6), so
--      such a move would leave its history readable outside the private
--      project, or hide its stamped history from the new project's readers
--      (SEC-21 done-when 1 / residual 3). Passes: the service role (auth.uid()
--      NULL — a restore, the SQL editor); the project's own delete
--      (`milestones.project_id` is ON DELETE SET NULL: an UPDATE with the
--      project row already gone); the audited purge of the project
--      (`app.record_purge = 'project:<id>'`, 20261103's setting). Why: rows
--      a milestone wrote keep the reach of the scope it had when they were
--      written (SEC-21 §6 of 20261157), so a move by someone without the
--      project's authority re-scopes its history silently; and a
--      document-only schedule re-import moved each matched milestone OFF its
--      project (lib/milestones.ts, fixed in the same package: a matched row
--      keeps its own project). No app path moves a milestone's project
--      (lib/milestones.ts PATCH_COLUMN has no project_id; the import now
--      writes each matched row's own project).
--   2. projects-tab MON-14 — a contractor is not deleted from under its
--      quotes. `enforce_project_party_delete` (BEFORE DELETE ON
--      project_parties; SECURITY DEFINER, search_path pinned, EXECUTE revoked
--      from PUBLIC, anon and authenticated): a signed-in delete of a
--      contractor is refused (a) while an OPEN quote (draft / parsed) names
--      it — the bid under evaluation keeps who submitted it; and (b) while a
--      quote in ANY status answers, through this contractor, for a flagged
--      company (`cost_doc_companies_barred`, 20261179, read as the definer)
--      that it would no longer answer for once its `party_id` is nulled by
--      the foreign key — 20261179 §3's own test, before and after, and for
--      the same reason it judges a decided quote: nothing refuses a
--      signed-in reopen, so a contractor deleted under a declined quote
--      would let a reopened award skip the flag with no reason recorded.
--      Passes: the service role; the project's own delete or the org's
--      (project_parties cascades from both — the project / org row already
--      gone); the audited purge of the project (`app.record_purge`;
--      `delete_project_record` deletes the quotes before the contractors, so
--      none is found there anyway). A contractor no quote names, or named
--      only by decided quotes that answer for no flagged company through it,
--      is deleted exactly as before. No app path deletes a contractor.
--
-- NOT a widening: both sections refuse writes RLS allowed and grant nothing.
-- The DEC-30 inventory (aggregate COUNTs only, never rows) is captured
-- BEFORE the transaction and returned with the probes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true; inventory rows carry ok NULL and a count in n.
--
-- PASTE ORDER: after 20261179 (the guard below refuses otherwise — section 2
-- calls its `cost_doc_companies_barred`; section 1 calls 20261098's
-- `can_edit_project_schedule`). 20261179 is itself after 20261157 (HOLD), so
-- this file pastes in the same window or later.
-- DEPLOY ORDER: either. The app carrying J19 writes each matched row's own
-- project on a re-import, so the rail never sees a move from it. The app
-- before J19, after this paste: a document-only re-import by someone without
-- the project's authority, or of a private project's rows, has its chunk
-- upsert refused (42501); the importer's per-row fallback then updates each
-- row WITHOUT the scope columns, so the rows still take the file and keep
-- their project (slower, same result). With the authority on an open
-- project, the old app's move still lands, as today, until the J19 app is
-- deployed. No app path deletes a contractor.

DO $$
BEGIN
  IF to_regprocedure('public.cost_doc_companies_barred(uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.can_edit_project_schedule(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261179_prj_roundG_award_answers_for_each.sql (after 20261157) and 20261098_prj_roundG_apply_milestone_moves.sql first — this file calls cost_doc_companies_barred and can_edit_project_schedule. Nothing was changed.';
  END IF;
END $$;

-- ── DEC-30 inventory, captured BEFORE the transaction (counts only) ───────
DROP TABLE IF EXISTS pg_temp.prj_g_j19_inventory;
CREATE TEMP TABLE prj_g_j19_inventory AS
SELECT 'inventory: imported milestones on a project that also carry a document (a document-only re-import of that document''s schedule moved these off their project before the J19 app)' AS inventory,
       (SELECT COUNT(*) FROM milestones
         WHERE project_id IS NOT NULL AND document_id IS NOT NULL AND external_ref IS NOT NULL)::text AS n
UNION ALL
SELECT 'inventory: imported milestones on a document and no project (a re-import may already have moved some off a project; not told apart here — the rail stops further moves)',
       (SELECT COUNT(*) FROM milestones
         WHERE project_id IS NULL AND document_id IS NOT NULL AND external_ref IS NOT NULL)::text
UNION ALL
SELECT 'inventory: milestones on a private project (a signed-in move of any of them onto or off its project is refused from this paste on)',
       (SELECT COUNT(*) FROM milestones m JOIN projects p ON p.id = m.project_id
         WHERE p.visibility IS NOT DISTINCT FROM 'private')::text
UNION ALL
SELECT 'inventory: contractors named by an open quote (draft / parsed) — a signed-in delete of each is refused from this paste on',
       (SELECT COUNT(DISTINCT d.party_id) FROM cost_documents d
         WHERE d.kind = 'quote' AND d.status IN ('draft', 'parsed') AND d.party_id IS NOT NULL)::text
UNION ALL
SELECT 'inventory: contractors linked to a flagged registry company (inactive / DO NOT USE) and named by a quote in any status — a signed-in delete is refused while the quote would stop answering for the flag',
       (SELECT COUNT(DISTINCT pp.id) FROM project_parties pp
          JOIN companies c ON c.id = pp.company_id
         WHERE c.status IN ('inactive', 'do_not_use')
           AND EXISTS (SELECT 1 FROM cost_documents d WHERE d.party_id = pp.id AND d.kind = 'quote'))::text
UNION ALL
SELECT 'inventory: other row triggers on milestones that fire on UPDATE OF project_id, and on project_parties that fire BEFORE DELETE (besides this file''s)',
       (SELECT COUNT(*) FROM pg_trigger t
         WHERE NOT t.tgisinternal
           AND t.tgname NOT IN ('trg_milestones_project_move', 'trg_project_parties_delete_guard')
           AND ((t.tgrelid = 'public.milestones'::regclass AND pg_get_triggerdef(t.oid) LIKE '%UPDATE OF %project_id%')
             OR (t.tgrelid = 'public.project_parties'::regclass AND pg_get_triggerdef(t.oid) LIKE '%BEFORE DELETE%')))::text;

BEGIN;

-- ── 1. SEC-21 residual 3: a milestone's project moves only with its authority
CREATE OR REPLACE FUNCTION public.enforce_milestone_project_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass: restores, the SQL editor
  -- The project's own delete: milestones.project_id is ON DELETE SET NULL, an UPDATE with the project row already gone.
  IF NEW.project_id IS NULL AND OLD.project_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
    RETURN NEW;
  END IF;
  -- delete_project_record's audited purge of this project (20261103).
  IF OLD.project_id IS NOT NULL
     AND COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.project_id::text THEN
    RETURN NEW;
  END IF;
  IF NEW.project_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'A milestone can be moved only onto a project of its own workspace; nothing was changed. (SEC-21, 20261198)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A private project on either side: the rows the milestone already wrote keep the reach of the scope they were
  -- written under (20261157 section 6), so moving it onto a private project would leave its history readable by
  -- people outside that project, and moving it off one would hide its stamped history from the new project's readers.
  IF EXISTS (SELECT 1 FROM public.projects p
              WHERE p.id IN (OLD.project_id, NEW.project_id) AND p.visibility IS NOT DISTINCT FROM 'private') THEN
    RAISE EXCEPTION 'A milestone cannot be moved onto or off a private project: the history it already wrote would keep its old reach. Create it on the project instead; nothing was changed. (SEC-21, 20261198)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.project_id IS NOT NULL AND NOT public.can_edit_project_schedule(OLD.org_id, OLD.project_id))
     OR (NEW.project_id IS NOT NULL AND NOT public.can_edit_project_schedule(NEW.org_id, NEW.project_id)) THEN
    RAISE EXCEPTION 'Moving a milestone onto or off a project needs schedule-editing rights on that project (its owner, or an Admin, Document Control, Manager or Supervisor); nothing was changed. (SEC-21, 20261198)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_milestone_project_move() IS
  'SEC-21 residual 3 (20261198): a signed-in write that moves milestones.project_id onto, off or between projects needs can_edit_project_schedule on every project it touches and a target project of the milestone''s own org, and is refused outright when either project is private (the history the milestone wrote keeps the reach it was written under). The service role, the project''s own delete (FK SET NULL with the project gone) and delete_project_record''s purge (app.record_purge) pass.';

REVOKE ALL ON FUNCTION public.enforce_milestone_project_move() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_milestone_project_move() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_milestone_project_move() FROM authenticated;

DROP TRIGGER IF EXISTS trg_milestones_project_move ON milestones;
CREATE TRIGGER trg_milestones_project_move
  BEFORE UPDATE OF project_id ON milestones
  FOR EACH ROW
  WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id)
  EXECUTE FUNCTION public.enforce_milestone_project_move();

-- ── 2. MON-14: a contractor is not deleted from under its quotes ──────────
CREATE OR REPLACE FUNCTION public.enforce_project_party_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open integer;
  v_doc record;
  v_before jsonb;
  v_after jsonb;
  v_left jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN OLD; END IF;              -- the service pass: restores, the SQL editor
  -- The project's or the org's own delete: project_parties cascades from both, the parent row already gone.
  IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id)
     OR NOT EXISTS (SELECT 1 FROM public.orgs o WHERE o.id = OLD.org_id) THEN
    RETURN OLD;
  END IF;
  -- delete_project_record's audited purge of this project (20261103).
  IF COALESCE(current_setting('app.record_purge', true), '') = 'project:' || OLD.project_id::text THEN RETURN OLD; END IF;
  -- (a) An open quote names this contractor.
  SELECT COUNT(*) INTO v_open
    FROM public.cost_documents d
   WHERE d.party_id = OLD.id AND d.kind = 'quote' AND d.status IN ('draft', 'parsed');
  IF v_open > 0 THEN
    RAISE EXCEPTION '% is the contractor on % open quote(s) — decide or void them first; nothing was deleted. (MON-14, 20261198)',
      OLD.name, v_open
      USING ERRCODE = 'check_violation';
  END IF;
  -- (b) A quote, in any status, answers through this contractor for a flagged company.
  FOR v_doc IN
    SELECT d.org_id, NULLIF(to_jsonb(d) ->> 'company_id', '')::uuid AS company_id, d.vendor_name
      FROM public.cost_documents d
     WHERE d.party_id = OLD.id AND d.kind = 'quote'
  LOOP
    v_before := cost_doc_companies_barred(v_doc.org_id, v_doc.company_id, OLD.id, v_doc.vendor_name);
    CONTINUE WHEN jsonb_array_length(v_before) = 0;
    v_after := cost_doc_companies_barred(v_doc.org_id, v_doc.company_id, NULL, v_doc.vendor_name);
    SELECT e INTO v_left
      FROM jsonb_array_elements(v_before) e
     WHERE NOT v_after @> jsonb_build_array(jsonb_build_object('id', e -> 'id'))
     LIMIT 1;
    IF v_left IS NOT NULL THEN
      RAISE EXCEPTION '% is flagged % in the company registry — a quote answers for it through this contractor, so the contractor cannot be deleted; nothing was deleted. (MON-14, 20261198)',
        v_left ->> 'name', CASE v_left ->> 'status' WHEN 'do_not_use' THEN 'DO NOT USE' ELSE 'inactive' END
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.enforce_project_party_delete() IS
  'MON-14 (20261198): a signed-in delete of a contractor is refused while an open quote (draft / parsed) names it, or while a quote in any status answers through it for a flagged company (cost_doc_companies_barred before and after its party_id is nulled — 20261179 section 3''s test). The service role, the project''s or org''s own delete (parent row gone) and delete_project_record''s purge (app.record_purge) pass.';

REVOKE ALL ON FUNCTION public.enforce_project_party_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_project_party_delete() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_project_party_delete() FROM authenticated;

DROP TRIGGER IF EXISTS trg_project_parties_delete_guard ON project_parties;
CREATE TRIGGER trg_project_parties_delete_guard
  BEFORE DELETE ON project_parties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_party_delete();

COMMIT;

SELECT 'SEC-21 residual 3: enforce_milestone_project_move is a SECURITY DEFINER trigger function with search_path pinned; it passes the service role, the project''s own delete and the purge, refuses a target project of another org and any move onto or off a private project, and asks can_edit_project_schedule for the old AND the new project' AS check,
       (SELECT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
               AND prosrc LIKE '%NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id)%'
               AND prosrc LIKE '%app.record_purge%'
               AND prosrc LIKE '%p.id = NEW.project_id AND p.org_id = NEW.org_id%'
               AND prosrc LIKE '%WHERE p.id IN (OLD.project_id, NEW.project_id) AND p.visibility IS NOT DISTINCT FROM ''private'') THEN%'
               AND prosrc LIKE '%public.can_edit_project_schedule(OLD.org_id, OLD.project_id)%'
               AND prosrc LIKE '%public.can_edit_project_schedule(NEW.org_id, NEW.project_id)%'
          FROM pg_proc WHERE proname = 'enforce_milestone_project_move' AND pronargs = 0) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'SEC-21 residual 3 (DRLS-16): neither anon nor authenticated can execute enforce_milestone_project_move',
       NOT has_function_privilege('anon', 'public.enforce_milestone_project_move()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.enforce_milestone_project_move()', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'SEC-21 residual 3: trg_milestones_project_move fires BEFORE UPDATE OF project_id on milestones, for each row, only when the value changes',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.milestones'::regclass AND t.tgname = 'trg_milestones_project_move'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF project_id ON public.milestones FOR EACH ROW WHEN ((old.project_id IS DISTINCT FROM new.project_id))%'),
       NULL::text
UNION ALL
SELECT 'MON-14: enforce_project_party_delete is a SECURITY DEFINER trigger function with search_path pinned; it passes the service role, the project''s or org''s own delete and the purge, refuses a contractor an open quote names, and judges every quote by cost_doc_companies_barred before and after',
       (SELECT prosecdef AND proconfig::text LIKE '%search_path=public%'
               AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN OLD; END IF;%'
               AND prosrc LIKE '%NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id)%'
               AND prosrc LIKE '%NOT EXISTS (SELECT 1 FROM public.orgs o WHERE o.id = OLD.org_id)%'
               AND prosrc LIKE '%app.record_purge%'
               AND prosrc LIKE '%d.status IN (''draft'', ''parsed'')%'
               AND prosrc LIKE '%v_before := cost_doc_companies_barred(v_doc.org_id, v_doc.company_id, OLD.id, v_doc.vendor_name);%'
               AND prosrc LIKE '%v_after := cost_doc_companies_barred(v_doc.org_id, v_doc.company_id, NULL, v_doc.vendor_name);%'
          FROM pg_proc WHERE proname = 'enforce_project_party_delete' AND pronargs = 0),
       NULL::text
UNION ALL
SELECT 'MON-14 (DRLS-16): neither anon nor authenticated can execute enforce_project_party_delete',
       NOT has_function_privilege('anon', 'public.enforce_project_party_delete()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.enforce_project_party_delete()', 'EXECUTE'),
       NULL::text
UNION ALL
SELECT 'MON-14: trg_project_parties_delete_guard fires BEFORE DELETE on project_parties, for each row',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.project_parties'::regclass AND t.tgname = 'trg_project_parties_delete_guard'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE DELETE ON public.project_parties FOR EACH ROW%'),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j19_inventory;
