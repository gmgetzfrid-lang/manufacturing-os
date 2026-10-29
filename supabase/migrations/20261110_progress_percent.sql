-- 20261110_progress_percent.sql
--
-- Correcting the % of a progress entry already in a step's history. The
-- history log is written only by the trigger on milestones, so this does
-- it, for members of the step's organisation: the entry's % changes, the
-- entries after it that carried that % (a hold keeps the %) follow, and
-- when nothing after it changed the %, the step itself stands at the new %.
--
-- Returns 'ok', or 'start' (the line from when it was made), 'status' (not
-- a progress entry — a finish is 100%, not started is 0%), 'range' (0–99).

CREATE OR REPLACE FUNCTION set_progress_percent(p_log_id BIGINT, p_pct NUMERIC) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r milestone_progress_log%ROWTYPE;
  x milestone_progress_log%ROWTYPE;
  was NUMERIC;
  carried BOOLEAN := TRUE;
  last_id BIGINT;
BEGIN
  SELECT * INTO r FROM milestone_progress_log WHERE id = p_log_id;
  IF NOT FOUND THEN RETURN 'error'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = r.org_id AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF r.old_status IS NULL THEN RETURN 'start'; END IF;
  IF r.new_status NOT IN ('in_progress', 'on_hold', 'blocked') THEN RETURN 'status'; END IF;
  IF p_pct < 0 OR p_pct > 99 THEN RETURN 'range'; END IF;
  was := r.new_percent;
  UPDATE milestone_progress_log SET new_percent = p_pct WHERE id = r.id;
  -- What came after it: each starts from the corrected %, and one that only
  -- carried it (a hold, back to work) carries the new one.
  FOR x IN SELECT * FROM milestone_progress_log WHERE milestone_id = r.milestone_id AND id > r.id ORDER BY id LOOP
    IF x.old_percent IS NOT DISTINCT FROM was THEN
      UPDATE milestone_progress_log SET old_percent = p_pct WHERE id = x.id;
    END IF;
    IF x.new_percent IS NOT DISTINCT FROM was AND x.new_status IN ('in_progress', 'on_hold', 'blocked') THEN
      UPDATE milestone_progress_log SET new_percent = p_pct WHERE id = x.id;
    ELSE
      carried := FALSE;
      EXIT;
    END IF;
  END LOOP;
  -- Nothing after it changed the %: the step stands at it now. The line the
  -- trigger writes for that isn't a change anyone made, so it goes.
  IF carried THEN
    SELECT max(id) INTO last_id FROM milestone_progress_log WHERE milestone_id = r.milestone_id;
    UPDATE milestones SET percent_complete = p_pct, updated_at = now()
     WHERE id = r.milestone_id AND status IN ('in_progress', 'on_hold', 'blocked');
    DELETE FROM milestone_progress_log WHERE milestone_id = r.milestone_id AND id > last_id;
  END IF;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION set_progress_percent(BIGINT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_progress_percent(BIGINT, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';
