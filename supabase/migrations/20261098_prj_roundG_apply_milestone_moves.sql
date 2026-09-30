-- 20261098_prj_roundG_apply_milestone_moves.sql
--
-- projects Round G — PC SCHED-4 + PT SCH-7 (+ PC SCHED-9 writer half): ONE
-- re-creation of apply_milestone_moves, base = 20260907_milestone_batch_move.sql.
--
--   * SCHED-4: the NULL-uid branch trusted ANY absent uid — the anon key has
--     none either. It now tests auth.role() = 'service_role' explicitly, and
--     EXECUTE is revoked from PUBLIC and anon (granted to authenticated and
--     service_role only), so a bare-anon-key call gets 42501.
--   * DEC-35: the schedule-editing predicate lives in ONE helper,
--     can_edit_project_schedule (caller_holds_any_role over the same four
--     roles 20260907 listed, OR the project owner) — the baseline RPCs in
--     20261099 enforce the same predicate. No widening: same set as before.
--   * SCH-7: each move may carry expected_updated_at; the UPDATE adds it to
--     the WHERE, so a row edited since the caller loaded it is left alone and
--     returned in `unmatched`. The count is ROW_COUNT, not the request size.
--     The return type changes (INT → JSONB), so the old signature is dropped
--     first; the client accepts both shapes.
--   * SCHED-9: shift follows the moved start — a day / night row whose start
--     moves into the other band (06:00–17:59 UTC = day) is re-labelled; an
--     unlabelled row, a hand-set 'swing' and a move within the band keep the
--     stored value. Existing imported rows are NOT recomputed here (they may
--     have been hand-corrected) — inventoried.
--
-- Apply after 20261097.

-- ── DEC-30 inventory, captured BEFORE the transaction ─────────────────────
CREATE TEMP TABLE prj_roundg_moves_inventory AS
SELECT 'inventory: anon could EXECUTE apply_milestone_moves before this migration' AS check,
       CASE WHEN to_regprocedure('public.apply_milestone_moves(uuid,uuid,jsonb)') IS NULL THEN 'function absent'
            ELSE has_function_privilege('anon', 'public.apply_milestone_moves(uuid,uuid,jsonb)', 'EXECUTE')::text END AS n
UNION ALL
SELECT 'inventory: imported rows carrying a stored shift (SCHED-9 recompute candidates; recompute is opt-in per project)',
       COUNT(*)::text
  FROM milestones
 WHERE source IN ('p6', 'msproject', 'csv', 'mpxj') AND shift IS NOT NULL
UNION ALL
SELECT 'inventory: projects holding such rows', COUNT(DISTINCT project_id)::text
  FROM milestones
 WHERE source IN ('p6', 'msproject', 'csv', 'mpxj') AND shift IS NOT NULL AND project_id IS NOT NULL;

BEGIN;

-- ── 1. The schedule-editing predicate, once ─────────────────────────────
-- The same four roles 20260907 listed inline, read through the collection
-- funnel, OR the project owner. Used by apply_milestone_moves here and by
-- set_project_baseline / clear_project_baseline in 20261099.
CREATE OR REPLACE FUNCTION can_edit_project_schedule(p_org uuid, p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT caller_holds_any_role(p_org, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[])
      OR EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project AND p.org_id = p_org AND p.owner_user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION can_edit_project_schedule(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION can_edit_project_schedule(uuid, uuid) TO authenticated, service_role;

-- ── 2. apply_milestone_moves — return type changes, so drop + create ──────
DROP FUNCTION IF EXISTS apply_milestone_moves(uuid, uuid, jsonb);

CREATE FUNCTION apply_milestone_moves(
  p_org UUID,
  p_project UUID,
  p_moves JSONB   -- [{"id": "...", "start": "ISO", "finish": "ISO", "expected_updated_at": "ISO" | null}, ...]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_move JSONB;
  v_id UUID;
  v_n INT;
  v_count INT := 0;
  v_matched UUID[] := ARRAY[]::uuid[];
  v_unmatched UUID[] := ARRAY[]::uuid[];
BEGIN
  IF v_uid IS NULL THEN
    -- Only the service role is trusted without a session. The anon key has
    -- no uid either and used to walk straight past this block (PC SCHED-4).
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT caller_is_active_member(p_org) THEN
      RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
    END IF;
    IF NOT can_edit_project_schedule(p_org, p_project) THEN
      RAISE EXCEPTION 'You do not have schedule-editing rights on this project' USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR v_move IN SELECT jsonb_array_elements(p_moves) LOOP
    v_id := (v_move->>'id')::uuid;
    UPDATE milestones
    SET planned_start_at = (v_move->>'start')::timestamptz,
        planned_at = (v_move->>'finish')::timestamptz,
        -- Shift follows the task (PC SCHED-9): a labelled day / night row
        -- whose start moves into the other band (06:00–17:59 wall-clock-as-
        -- UTC = day) is re-labelled. An unlabelled row, a hand-set 'swing',
        -- a row with no prior start and a move that stays in its band keep
        -- the stored value (planned_start_at here is the row BEFORE the SET).
        shift = CASE
          WHEN (v_move->>'start') IS NULL OR planned_start_at IS NULL OR shift IS NULL OR shift = 'swing' THEN shift
          WHEN (EXTRACT(HOUR FROM (planned_start_at AT TIME ZONE 'UTC')) BETWEEN 6 AND 17)
             = (EXTRACT(HOUR FROM ((v_move->>'start')::timestamptz AT TIME ZONE 'UTC')) BETWEEN 6 AND 17) THEN shift
          WHEN EXTRACT(HOUR FROM ((v_move->>'start')::timestamptz AT TIME ZONE 'UTC')) BETWEEN 6 AND 17 THEN 'day'
          ELSE 'night'
        END,
        updated_at = NOW(),
        updated_by = v_uid
    WHERE id = v_id
      AND org_id = p_org
      AND project_id = p_project
      -- Optimistic lock (PT SCH-7): a row edited since the caller loaded it
      -- is left alone and reported, never silently overwritten.
      AND ((v_move->>'expected_updated_at') IS NULL
           OR updated_at IS NOT DISTINCT FROM (v_move->>'expected_updated_at')::timestamptz);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_matched := v_matched || v_id;
      v_count := v_count + v_n;
    ELSE
      v_unmatched := v_unmatched || v_id;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'count', v_count,
    'matched', to_jsonb(v_matched),
    'unmatched', to_jsonb(v_unmatched)
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_milestone_moves(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION apply_milestone_moves(uuid, uuid, jsonb) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (one result set) ────────────────────────────
SELECT 'apply_milestone_moves(uuid,uuid,jsonb) exists and returns jsonb' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'apply_milestone_moves'
                  AND pg_get_function_result(p.oid) = 'jsonb') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the NULL-uid branch tests auth.role() = service_role',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'apply_milestone_moves'
                  AND p.prosrc LIKE '%auth.role() IS DISTINCT FROM ''service_role''%'),
       NULL
UNION ALL
SELECT 'the UPDATE carries the expected_updated_at lock',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'apply_milestone_moves'
                  AND p.prosrc LIKE '%(v_move->>''expected_updated_at'')::timestamptz%'),
       NULL
UNION ALL
SELECT 'the role list reads through can_edit_project_schedule → caller_holds_any_role',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'apply_milestone_moves'
                  AND p.prosrc LIKE '%can_edit_project_schedule(p_org, p_project)%')
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'can_edit_project_schedule'
                  AND p.prosrc LIKE '%caller_holds_any_role(p_org, ARRAY[''Admin'',''DocCtrl'',''Manager'',''Supervisor'']::text[])%'),
       NULL
UNION ALL
SELECT 'search_path pinned on both functions',
       (SELECT bool_and(p.proconfig::text LIKE '%search_path=public%')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('apply_milestone_moves', 'can_edit_project_schedule')),
       NULL
UNION ALL
SELECT 'anon can NOT execute apply_milestone_moves (after)',
       NOT has_function_privilege('anon', 'public.apply_milestone_moves(uuid,uuid,jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'authenticated CAN execute apply_milestone_moves',
       has_function_privilege('authenticated', 'public.apply_milestone_moves(uuid,uuid,jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'service_role CAN execute apply_milestone_moves',
       has_function_privilege('service_role', 'public.apply_milestone_moves(uuid,uuid,jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT "check", NULL::boolean, n FROM prj_roundg_moves_inventory;
