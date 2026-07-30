-- 20260907_milestone_batch_move.sql
--
-- Atomic schedule reflow. A cascading drag used to persist as N separate
-- row updates from the browser — if write 17 of 30 failed, the schedule
-- was left HALF-MOVED in the database. This RPC applies the whole batch
-- in one transaction: all rows move, or none do.
--
-- Authorization inside the function (SECURITY DEFINER): the caller must
-- be an active member of the org AND either hold a schedule-editing role
-- (Admin / DocCtrl / Manager / Supervisor) or own the project.
--
-- Apply after 20260906.

CREATE OR REPLACE FUNCTION apply_milestone_moves(
  p_org UUID,
  p_project UUID,
  p_moves JSONB   -- [{"id": "...", "start": "ISO", "finish": "ISO"}, ...]
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_roles TEXT[];
  v_owner TEXT;
  v_move JSONB;
  v_count INT := 0;
BEGIN
  IF v_uid IS NULL THEN
    -- service role: trusted server code
    NULL;
  ELSE
    SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
    FROM org_members
    WHERE org_id = p_org AND uid = v_uid AND status = 'active'
    LIMIT 1;
    IF v_role IS NULL THEN
      RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
    END IF;
    SELECT owner_user_id::text INTO v_owner FROM projects WHERE id = p_project AND org_id = p_org;
    IF NOT (
      v_roles && ARRAY['Admin','DocCtrl','Manager','Supervisor']
      OR v_owner = v_uid::text
    ) THEN
      RAISE EXCEPTION 'You do not have schedule-editing rights on this project' USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR v_move IN SELECT jsonb_array_elements(p_moves) LOOP
    UPDATE milestones
    SET planned_start_at = (v_move->>'start')::timestamptz,
        planned_at = (v_move->>'finish')::timestamptz,
        updated_at = NOW(),
        updated_by = v_uid
    WHERE id = (v_move->>'id')::uuid
      AND org_id = p_org
      AND project_id = p_project;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
