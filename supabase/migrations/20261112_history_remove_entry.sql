-- 20261112_history_remove_entry.sql
--
-- Remove a % entry from anywhere in a step's history (the trash can next
-- to Edit). The history log is written only by the trigger on milestones
-- and can't be edited from the app, so this function does it, for members
-- of the step's organisation.
--
--   remove_progress_entry(log line) - a % entry (same status before and
--     after, e.g. Progress 50% -> 65%) comes off the history. The entry
--     after it then counts from where this one started (65% -> Finished
--     reads 50% -> Finished), so progress per shift still adds up. The
--     step itself stays as it is now. Its comment is removed by the app.
--
-- Returns 'ok'; 'status' (a start, finish or hold - only the latest comes
-- off, with Take back); 'latest' (it's the latest entry - Take back);
-- 'error' (no such line).

CREATE OR REPLACE FUNCTION remove_progress_entry(p_log_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r milestone_progress_log%ROWTYPE;
  n milestone_progress_log%ROWTYPE;
BEGIN
  SELECT * INTO r FROM milestone_progress_log WHERE id = p_log_id;
  IF NOT FOUND THEN RETURN 'error'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = r.org_id AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF r.old_status IS NULL OR r.old_status IS DISTINCT FROM r.new_status THEN RETURN 'status'; END IF;
  -- The next real change (a line that changed nothing doesn't count).
  SELECT * INTO n FROM milestone_progress_log
   WHERE milestone_id = r.milestone_id AND id > r.id AND old_status IS NOT NULL
     AND NOT (old_status = new_status AND old_percent IS NOT DISTINCT FROM new_percent)
   ORDER BY id LIMIT 1;
  IF NOT FOUND THEN RETURN 'latest'; END IF;
  IF n.old_percent IS NOT DISTINCT FROM r.new_percent THEN
    UPDATE milestone_progress_log SET old_percent = r.old_percent WHERE id = n.id;
  END IF;
  DELETE FROM milestone_progress_log WHERE id = r.id;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION remove_progress_entry(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_progress_entry(BIGINT) TO authenticated;

NOTIFY pgrst, 'reload schema';
