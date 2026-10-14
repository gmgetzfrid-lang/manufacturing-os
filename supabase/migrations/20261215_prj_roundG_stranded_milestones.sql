-- 20261215_prj_roundG_stranded_milestones.sql
--
-- projects Round G — J20 INTAKE DOOR UNDER RLS AND PROJECT REMAINDERS:
-- projects-tab SEC-24 — milestones a document-only schedule re-import moved
-- OFF their project before J19 (20261198) are found by counts and put back by
-- an operator-confirmed, audited path. Never a blind rewrite.
--
-- WHAT WAS FOUND FIRST (by reading, recorded on SEC-24): no screen of the app
-- ever ran a document-only import. lib/milestones.ts importMilestonesFromParsed
-- and importGhostMilestones have exactly one caller in the repository's
-- history, components/projects/ScheduleImportModal.tsx, which has always
-- passed { orgId, projectId } and never a document; and no app writer gives a
-- milestone both a document and an external reference. So on a database
-- written only by the app, the population is empty: the move needed a direct
-- call of the library with a member's own session. The inventory below says
-- whether this database holds any (it is 20261198's inventory row 2, told
-- apart), and the function lets an operator put back what it finds.
--
--   * reattach_stranded_milestones(org, project, document, source, expected)
--     — SECURITY DEFINER, search_path pinned, EXECUTE for authenticated and the
--     service role only (PUBLIC and anon revoked — DRLS-16). The candidates are
--     the org's milestones of that document and import source on NO project,
--     with an external reference: exactly the rows a document-only re-import
--     of that document's schedule moved off a project (and any that were
--     always document-only — nothing in a row says which, so the OPERATOR
--     names the project, after reading the evidence the dry run counts).
--     COUNTS FIRST: called with expected NULL it writes nothing and answers
--     { applied: false, candidates, stampedOnProject (audit rows 20261157 §9
--     stamped with that project for the candidate milestones while they were
--     on it), siblingsOnProject (that document's milestones of that source
--     still on the project), collisions (candidates whose reference that
--     project already uses — a put-back would break its unique index),
--     privateProject }. APPLY: called with expected = the candidates counted,
--     it re-counts under a row lock, refuses if the count moved, refuses any
--     collision, and moves each candidate onto the project with one
--     MILESTONE_REATTACHED audit row per milestone (typed project, the
--     milestone, document, source, reference, from NULL, to the project).
--   * Who: an org controller (is_org_controller: Admin / Document Control,
--     held additively), or the SQL editor / service role (auth.uid() NULL —
--     the workspace operator). A signed-in move still meets 20261198's rail
--     (schedule authority on the project — every controller holds it — and no
--     move onto a PRIVATE project): so a private project's tasks are put back
--     only by the operator from the SQL editor, where the rail's service pass
--     applies — decided explicitly (SEC-24): the tasks return to the scope
--     they came from, and the rows they wrote while stranded were readable by
--     every member already, so nothing is exposed that was not.
--   * After a put-back, a re-import onto that project (with or without the
--     document) matches them by project and updates them in place (J19 keeps
--     each matched row's own project) instead of colliding.
--
-- HOW TO RUN THE REPAIR (operator): after this paste, its result set shows how
-- many candidates the database holds. If it is 0 there is nothing to do. If
-- not, for each (project, document, source) the user names:
--   SELECT reattach_stranded_milestones('<org>', '<project>', '<document>', '<source>');          -- the counts
--   SELECT reattach_stranded_milestones('<org>', '<project>', '<document>', '<source>', <count>); -- the put-back
-- in the SQL editor; each answers one jsonb row.
--
-- NOT a widening: the function moves rows only onto a project of the same
-- workspace and only the rows the caller counted; RLS and every trigger
-- (20261198's rail, the project record rail) still judge a signed-in caller.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true; inventory rows carry ok NULL and a count in n.
-- PASTE ORDER: after 20261198 (its rail judges the signed-in put-back) and
-- 20261157 (the audit stamp the dry run reads); the first statement refuses
-- to run, changing nothing, without 20261198.
-- DEPLOY ORDER: none — no app code calls the function.

DO $$
BEGIN
  IF to_regprocedure('public.enforce_milestone_project_move()') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261198_prj_roundG_milestone_project_and_party_delete.sql first — this file''s put-back is judged by its rail. Nothing was changed.';
  END IF;
END $$;

-- ── DEC-30 inventory, captured BEFORE the transaction (counts only) ───────
DROP TABLE IF EXISTS pg_temp.prj_g_j20_stranded_inventory;
CREATE TEMP TABLE prj_g_j20_stranded_inventory AS
SELECT 'inventory: imported milestones on a document and NO project (20261198 inventory row 2) — the candidates; 0 means there is nothing to put back' AS inventory,
       (SELECT COUNT(*) FROM milestones
         WHERE project_id IS NULL AND document_id IS NOT NULL AND external_ref IS NOT NULL)::text AS n
UNION ALL
SELECT 'inventory: …the (document, import source) groups they form — one put-back call each',
       (SELECT COUNT(*) FROM (SELECT DISTINCT org_id, document_id, source FROM milestones
                                WHERE project_id IS NULL AND document_id IS NOT NULL AND external_ref IS NOT NULL) g)::text
UNION ALL
SELECT 'inventory: …of them with an audit row stamped with a project (20261157 section 9: written while the milestone was on that project — evidence it was moved off)',
       (SELECT COUNT(*) FROM milestones m
         WHERE m.project_id IS NULL AND m.document_id IS NOT NULL AND m.external_ref IS NOT NULL
           AND EXISTS (SELECT 1 FROM audit_logs a
                        WHERE a.org_id = m.org_id AND left(a.action, 10) = 'MILESTONE_'
                          AND a.details->>'milestoneId' = m.id::text
                          AND a.details->>'projectIdFrom' = 'milestone'
                          AND (a.details->>'projectId') IS NOT NULL))::text
UNION ALL
SELECT 'inventory: …of them whose document still has milestones of the same source on a project (the rest of that schedule — evidence of where they belonged)',
       (SELECT COUNT(*) FROM milestones m
         WHERE m.project_id IS NULL AND m.document_id IS NOT NULL AND m.external_ref IS NOT NULL
           AND EXISTS (SELECT 1 FROM milestones s
                        WHERE s.org_id = m.org_id AND s.document_id = m.document_id AND s.source = m.source
                          AND s.project_id IS NOT NULL))::text;

BEGIN;

CREATE OR REPLACE FUNCTION public.reattach_stranded_milestones(p_org uuid, p_project uuid, p_document uuid, p_source text,
                                                              p_expected integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_private    boolean;
  v_n          integer;
  v_stamped    integer;
  v_siblings   integer;
  v_collisions integer;
  v_moved      integer := 0;
  r            record;
BEGIN
  IF v_uid IS NOT NULL AND NOT is_org_controller(p_org) THEN
    RAISE EXCEPTION 'Putting tasks back on a project needs Admin or Document Control; nothing was changed. (SEC-24, 20261215)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.visibility IS NOT DISTINCT FROM 'private' INTO v_private
    FROM projects p WHERE p.id = p_project AND p.org_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such project in this workspace; nothing was changed. (SEC-24, 20261215)' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = p_document AND d.org_id = p_org) THEN
    RAISE EXCEPTION 'No such document in this workspace; nothing was changed. (SEC-24, 20261215)' USING ERRCODE = 'no_data_found';
  END IF;
  -- The candidates, locked for the count and the move.
  PERFORM 1 FROM milestones m
   WHERE m.org_id = p_org AND m.project_id IS NULL AND m.document_id = p_document AND m.source = p_source AND m.external_ref IS NOT NULL
     FOR UPDATE;
  SELECT COUNT(*) INTO v_n FROM milestones m
   WHERE m.org_id = p_org AND m.project_id IS NULL AND m.document_id = p_document AND m.source = p_source AND m.external_ref IS NOT NULL;
  SELECT COUNT(*) INTO v_stamped FROM milestones m
   WHERE m.org_id = p_org AND m.project_id IS NULL AND m.document_id = p_document AND m.source = p_source AND m.external_ref IS NOT NULL
     AND EXISTS (SELECT 1 FROM audit_logs a
                  WHERE a.org_id = p_org AND left(a.action, 10) = 'MILESTONE_'
                    AND a.details->>'milestoneId' = m.id::text
                    AND a.details->>'projectIdFrom' = 'milestone'
                    AND a.details->>'projectId' = p_project::text);
  SELECT COUNT(*) INTO v_siblings FROM milestones s
   WHERE s.org_id = p_org AND s.project_id = p_project AND s.document_id = p_document AND s.source = p_source;
  SELECT COUNT(*) INTO v_collisions FROM milestones m
   WHERE m.org_id = p_org AND m.project_id IS NULL AND m.document_id = p_document AND m.source = p_source AND m.external_ref IS NOT NULL
     AND EXISTS (SELECT 1 FROM milestones o
                  WHERE o.org_id = p_org AND o.project_id = p_project AND o.source = p_source AND o.external_ref = m.external_ref);
  IF p_expected IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'candidates', v_n, 'stampedOnProject', v_stamped,
                              'siblingsOnProject', v_siblings, 'collisions', v_collisions, 'privateProject', v_private);
  END IF;
  IF p_expected IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'The tasks to put back changed: % now, % confirmed — read the counts again; nothing was changed. (SEC-24, 20261215)', v_n, p_expected
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_collisions > 0 THEN
    RAISE EXCEPTION '% of these tasks carry a reference the project already uses — resolve those first; nothing was changed. (SEC-24, 20261215)', v_collisions
      USING ERRCODE = 'unique_violation';
  END IF;
  IF v_private AND v_uid IS NOT NULL THEN
    RAISE EXCEPTION 'A private project''s tasks are put back by the workspace operator from the SQL editor (20261198 refuses a signed-in move onto a private project); nothing was changed. (SEC-24, 20261215)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR r IN SELECT m.id, m.name, m.external_ref FROM milestones m
            WHERE m.org_id = p_org AND m.project_id IS NULL AND m.document_id = p_document AND m.source = p_source AND m.external_ref IS NOT NULL
            ORDER BY m.id LOOP
    UPDATE milestones SET project_id = p_project, updated_at = NOW(), updated_by = v_uid WHERE id = r.id;
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, details)
    VALUES ('MILESTONE_REATTACHED', 'project', p_project::text, p_org, v_uid,
            jsonb_build_object('milestoneId', r.id, 'name', r.name, 'documentId', p_document, 'source', p_source,
                               'externalRef', r.external_ref, 'fromProjectId', NULL, 'toProjectId', p_project,
                               'repair', 'SEC-24'));
    v_moved := v_moved + 1;
  END LOOP;
  RETURN jsonb_build_object('applied', true, 'moved', v_moved, 'stampedOnProject', v_stamped,
                            'siblingsOnProject', v_siblings, 'privateProject', v_private);
END;
$$;

COMMENT ON FUNCTION public.reattach_stranded_milestones(uuid, uuid, uuid, text, integer) IS
  'SEC-24 (J20, 20261215): the org''s milestones of a document and import source on NO project (what a pre-J19 document-only re-import moved off a project), counted first (p_expected NULL: candidates, audit stamps naming the project, siblings still on it, reference collisions; nothing written) and then put back onto the project the operator names (p_expected = that count: re-counted under lock, refused on a moved count or a collision), one MILESTONE_REATTACHED audit row each. An org controller, or the SQL editor / service role (a private project only from there — 20261198''s rail).';

REVOKE ALL ON FUNCTION public.reattach_stranded_milestones(uuid, uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reattach_stranded_milestones(uuid, uuid, uuid, text, integer) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only.
--    pg_proc.prosrc is verbatim (an apostrophe in a literal is written '''').
SELECT 'reattach_stranded_milestones is SECURITY DEFINER with search_path pinned; authenticated and the service role may EXECUTE it, anon may not' AS check,
       (SELECT p.prosecdef
               AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'reattach_stranded_milestones') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'it counts first (expected NULL writes nothing), re-counts under lock, refuses a moved count, a reference collision and a signed-in non-controller, and writes one MILESTONE_REATTACHED audit row per milestone',
       (SELECT prosrc LIKE '%IF v_uid IS NOT NULL AND NOT is_org_controller(p_org) THEN%'
               AND prosrc LIKE '%IF p_expected IS NULL THEN%RETURN jsonb_build_object(''applied'', false%'
               AND prosrc LIKE '%FOR UPDATE;%'
               AND prosrc LIKE '%IF p_expected IS DISTINCT FROM v_n THEN%'
               AND prosrc LIKE '%IF v_collisions > 0 THEN%'
               AND prosrc LIKE '%VALUES (''MILESTONE_REATTACHED'', ''project''%'
          FROM pg_proc WHERE proname = 'reattach_stranded_milestones'),
       NULL
UNION ALL
SELECT '20261198''s rail still judges a signed-in move of milestones.project_id (the put-back included)',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgfoid = 'public.enforce_milestone_project_move()'::regprocedure AND NOT t.tgisinternal
                  AND t.tgrelid = 'public.milestones'::regclass AND t.tgenabled <> 'D'),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j20_stranded_inventory;
