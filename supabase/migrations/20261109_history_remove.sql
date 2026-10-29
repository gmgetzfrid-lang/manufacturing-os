-- 20261109_history_remove.sql
--
-- Taking back what was entered on a step. The history log is written only
-- by the trigger on milestones and can't be edited from the app, so these
-- two functions do it, for members of the step's organisation:
--
--   undo_last_progress(step)  — the step's latest change is taken back: the
--     step goes back to how it stood before it (status, %, its start or
--     finish time, who finished it, a hold's reason), and that line leaves
--     the history. Its comments are removed by the app.
--   reset_step_progress(step) — start over: the step back to not started,
--     no times, its history and its comments gone. A discovery's note on
--     it and its plan moves stay.
--
-- Returns 'ok', or 'none' (nothing to take back), 'missing' (no such step).

CREATE OR REPLACE FUNCTION undo_last_progress(p_milestone_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m milestones%ROWTYPE;
  r milestone_progress_log%ROWTYPE;
  reason TEXT;
  first_done TIMESTAMPTZ;
  last_done TIMESTAMPTZ;
BEGIN
  SELECT * INTO m FROM milestones WHERE id = p_milestone_id;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = m.org_id AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  -- The latest real change (the line from when it was made isn't one).
  SELECT * INTO r FROM milestone_progress_log
   WHERE milestone_id = p_milestone_id AND old_status IS NOT NULL
     AND NOT (old_status = new_status AND old_percent IS NOT DISTINCT FROM new_percent)
   ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  -- Going back onto a hold: its reason, as it was said.
  IF r.old_status IN ('on_hold', 'blocked') THEN
    SELECT body INTO reason FROM milestone_notes
     WHERE milestone_id = p_milestone_id AND kind = 'status' AND status_at = r.old_status AND body IS NOT NULL
     ORDER BY created_at DESC LIMIT 1;
  END IF;
  -- Taking back a finish: the first finish on record is the one before it, if any.
  IF r.new_status = 'completed' AND r.old_status <> 'completed' THEN
    SELECT min(at) INTO first_done FROM milestone_progress_log
     WHERE milestone_id = p_milestone_id AND new_status = 'completed' AND old_status IS DISTINCT FROM 'completed' AND id <> r.id;
  END IF;
  -- Taking back a reopen: it's done again, at the finish it had.
  IF r.old_status = 'completed' THEN
    SELECT at INTO last_done FROM milestone_progress_log
     WHERE milestone_id = p_milestone_id AND new_status = 'completed' AND id < r.id
     ORDER BY id DESC LIMIT 1;
  END IF;
  UPDATE milestones SET
    status = r.old_status,
    percent_complete = r.old_percent,
    actual_start_at = CASE WHEN r.old_status IN ('planned', 'missed') THEN NULL ELSE actual_start_at END,
    actual_at = CASE WHEN r.old_status = 'completed' THEN COALESCE(actual_at, last_done) ELSE NULL END,
    first_completed_at = CASE WHEN r.new_status = 'completed' AND r.old_status <> 'completed' THEN first_done ELSE first_completed_at END,
    completed_by = CASE WHEN r.old_status = 'completed' THEN completed_by ELSE NULL END,
    completed_by_name = CASE WHEN r.old_status = 'completed' THEN completed_by_name ELSE NULL END,
    status_reason = CASE WHEN r.old_status IN ('on_hold', 'blocked') THEN COALESCE(reason, status_reason) ELSE NULL END,
    updated_at = now()
  WHERE id = p_milestone_id;
  -- The change taken back, and the line the trigger just wrote for taking it back.
  DELETE FROM milestone_progress_log WHERE milestone_id = p_milestone_id AND id >= r.id;
  -- The bare status line the app wrote with it.
  DELETE FROM milestone_notes
   WHERE milestone_id = p_milestone_id AND kind = 'status' AND body IS NULL
     AND created_at BETWEEN COALESCE(r.entered_at, r.at) - interval '2 minutes' AND COALESCE(r.entered_at, r.at) + interval '2 minutes';
  RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION reset_step_progress(p_milestone_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m milestones%ROWTYPE;
BEGIN
  SELECT * INTO m FROM milestones WHERE id = p_milestone_id;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = m.org_id AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE milestones SET
    status = 'planned', percent_complete = 0,
    actual_start_at = NULL, actual_at = NULL, first_completed_at = NULL,
    completed_by = NULL, completed_by_name = NULL, status_reason = NULL,
    updated_at = now()
  WHERE id = p_milestone_id;
  -- Every change, and the line the reset itself just wrote; the line from
  -- when the step was made stays.
  DELETE FROM milestone_progress_log WHERE milestone_id = p_milestone_id AND old_status IS NOT NULL;
  DELETE FROM milestone_notes
   WHERE milestone_id = p_milestone_id AND kind IN ('status', 'note', 'behind', 'field')
     AND NOT (coalesce(body, '') LIKE 'Discovery: %' OR coalesce(body, '') LIKE 'Added scope: %');
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION undo_last_progress(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_step_progress(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION undo_last_progress(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION reset_step_progress(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
