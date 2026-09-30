-- 20261107_prj_roundG_milestone_delete.sql
--
-- projects Round G — PT SCH-17 (review fix): deleting a milestone WITHOUT
-- orphaning its subtree, all or nothing.
--
--   lib/milestones.ts deleteMilestone promoted the row's children, stripped the
--   link from every dependent, and only then ran an UNCHECKED DELETE. Those
--   UPDATEs pass the permissive milestones_member_all (every active member),
--   but the DELETE sits behind the RESTRICTIVE milestones_delete_guard
--   (20260818: Admin / Manager, the row's creator, or someone who can manage
--   the project). A delete that guard refuses matches 0 rows and PostgREST
--   returns no error — so the phase stayed, emptied of its sub-tasks, its
--   dependents' links gone, and the audit log said it was deleted.
--
--   delete_milestone_keep_subtree(p_id) does the three steps in ONE
--   transaction and checks the last one:
--     1. the direct children move up to the row's parent (the top level when
--        it has none) — grandchildren keep their parent;
--     2. every task in the same project (the same org for a row with no
--        project) whose depends_on names the row loses exactly that link;
--     3. the row is deleted, and GET DIAGNOSTICS on the DELETE must say 1 —
--        0 (refused by the delete guard) RAISEs 42501, which rolls steps 1
--        and 2 back: nothing is changed.
--   It returns the prior structure (the children moved, each dependent's
--   links before) so the client's MILESTONE_DELETED audit row records it,
--   and { deleted: false } when the caller cannot see the row (already gone).
--
--   * SECURITY INVOKER: every step runs under the caller's row-level
--     security — the delete guard still decides who may delete. search_path
--     is pinned all the same. EXECUTE is revoked from PUBLIC and anon and
--     granted to authenticated and service_role.
--   * The client calls it first and, on a database without it (PGRST202),
--     falls back to the same steps in the checked order: the DELETE first,
--     with the deleted row read back (0 rows = refused, nothing changed),
--     then the children and the links.
--
-- NOT widening: SECURITY INVOKER, so nobody can do anything through it that
-- the milestones policies did not already let them do directly; the change is
-- that a refused delete now changes nothing. New function; no policy, table
-- or trigger is touched. Apply after 20261106.

-- ── DEC-30 inventory, captured BEFORE the transaction ─────────────────────
CREATE TEMP TABLE prj_roundg_milestone_delete_inventory AS
SELECT 'inventory: delete_milestone_keep_subtree already defined before this migration (1 = re-applied)' AS check,
       (CASE WHEN to_regprocedure('public.delete_milestone_keep_subtree(uuid)') IS NULL THEN 0 ELSE 1 END)::text AS n
UNION ALL
SELECT 'inventory: dependency links naming a milestone that no longer exists (left by earlier deletes; the engines ignore them)',
       COUNT(*)::text
  FROM milestones m
 CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(m.depends_on) = 'array' THEN m.depends_on ELSE '[]'::jsonb END) AS dep(v)
 WHERE NOT EXISTS (SELECT 1 FROM milestones x WHERE x.id::text = dep.v)
UNION ALL
SELECT 'inventory: milestones_delete_guard policies on milestones (1 expected)',
       COUNT(*)::text
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'milestones' AND policyname = 'milestones_delete_guard';

BEGIN;

CREATE OR REPLACE FUNCTION delete_milestone_keep_subtree(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_row milestones%ROWTYPE;
  v_new_parent UUID;
  v_children JSONB := '[]'::jsonb;
  v_dependents JSONB := '[]'::jsonb;
  v_n INT;
BEGIN
  -- The row as the caller sees it (row-level security applies).
  SELECT * INTO v_row FROM milestones WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'reparented', 0, 'unlinked', 0,
                              'children', '[]'::jsonb, 'dependents', '[]'::jsonb);
  END IF;
  v_new_parent := CASE WHEN v_row.parent_id IS NOT NULL AND v_row.parent_id <> p_id THEN v_row.parent_id END;

  -- 1. The direct children move up a level.
  WITH moved AS (
    UPDATE milestones
       SET parent_id = v_new_parent,
           updated_at = NOW(),
           updated_by = COALESCE(auth.uid(), updated_by)
     WHERE parent_id = p_id AND id <> p_id
    RETURNING id, name
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name, id), '[]'::jsonb)
    INTO v_children
    FROM moved;

  -- 2. Every dependent loses exactly the link to this row (its other links
  --    keep their order); its links before are returned for the audit row.
  WITH before AS (
    SELECT d.id, d.depends_on AS links_before
      FROM milestones d
     WHERE d.depends_on @> jsonb_build_array(p_id::text)
       AND d.id <> p_id
       AND CASE WHEN v_row.project_id IS NOT NULL THEN d.project_id = v_row.project_id
                ELSE d.org_id = v_row.org_id END
     FOR UPDATE
  ), unlinked AS (
    UPDATE milestones d
       SET depends_on = (SELECT COALESCE(jsonb_agg(x.e ORDER BY x.o), '[]'::jsonb)
                           FROM jsonb_array_elements(d.depends_on) WITH ORDINALITY AS x(e, o)
                          WHERE x.e <> to_jsonb(p_id::text)),
           updated_at = NOW(),
           updated_by = COALESCE(auth.uid(), d.updated_by)
      FROM before b
     WHERE d.id = b.id
    RETURNING d.id, d.name, b.links_before
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'depends_on_before', links_before) ORDER BY name, id), '[]'::jsonb)
    INTO v_dependents
    FROM unlinked;

  -- 3. The row itself — CHECKED. A delete the delete guard refuses matches
  --    no row and raises no error on its own; raising here rolls 1 and 2 back.
  DELETE FROM milestones WHERE id = p_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'You cannot delete this task — nothing was changed'
      USING ERRCODE = '42501',
            HINT = 'Deleting a milestone needs Admin or Manager, being its creator, or managing its project.';
  END IF;

  RETURN jsonb_build_object(
    'deleted', true,
    'reparented', jsonb_array_length(v_children),
    'unlinked', jsonb_array_length(v_dependents),
    'prior_parent_id', v_row.parent_id,
    'new_parent_id', v_new_parent,
    'children', v_children,
    'dependents', v_dependents
  );
END;
$$;

REVOKE ALL ON FUNCTION delete_milestone_keep_subtree(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_milestone_keep_subtree(uuid) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (one result set) ────────────────────────────
SELECT 'delete_milestone_keep_subtree(uuid) exists' AS check,
       to_regprocedure('public.delete_milestone_keep_subtree(uuid)') IS NOT NULL AS ok,
       NULL::text AS n
UNION ALL
SELECT 'it runs as the caller (SECURITY INVOKER) — the delete guard still decides who may delete',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'delete_milestone_keep_subtree' AND NOT p.prosecdef),
       NULL
UNION ALL
SELECT 'its search_path is pinned to public',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'delete_milestone_keep_subtree'
                  AND p.proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 'a delete that matches no row raises (so the re-parent and the unlink roll back)',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'delete_milestone_keep_subtree'
                  AND p.prosrc LIKE '%GET DIAGNOSTICS v_n = ROW_COUNT;%'
                  AND p.prosrc LIKE '%IF v_n = 0 THEN%RAISE EXCEPTION%'),
       NULL
UNION ALL
SELECT 'anon cannot EXECUTE it',
       CASE WHEN to_regprocedure('public.delete_milestone_keep_subtree(uuid)') IS NULL THEN false
            ELSE NOT has_function_privilege('anon', 'public.delete_milestone_keep_subtree(uuid)', 'EXECUTE') END,
       NULL
UNION ALL
SELECT 'authenticated can EXECUTE it',
       CASE WHEN to_regprocedure('public.delete_milestone_keep_subtree(uuid)') IS NULL THEN false
            ELSE has_function_privilege('authenticated', 'public.delete_milestone_keep_subtree(uuid)', 'EXECUTE') END,
       NULL
UNION ALL
SELECT 'milestones_delete_guard is still RESTRICTIVE FOR DELETE on milestones',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'milestones' AND policyname = 'milestones_delete_guard'
                  AND permissive = 'RESTRICTIVE' AND cmd = 'DELETE'),
       NULL
UNION ALL
SELECT "check", NULL::boolean, n FROM prj_roundg_milestone_delete_inventory;
