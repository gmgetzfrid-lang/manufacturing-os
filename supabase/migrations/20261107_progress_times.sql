-- Progress times: catching up after a reset.
--
-- 1. credit_progress_to: a change saved now, put at the time it happened.
--    It has to come after the step's last change, so the history (and the
--    reports, which read the log by time) stay in order. The log's
--    starting line (old_status null, written when the step was created or
--    reset) isn't a change, so back-filling after a reset works. Back to
--    30 days.
-- 2. set_progress_time: correct when a logged change happened, later.
--    The app keeps it between the changes before and after it.

CREATE OR REPLACE FUNCTION credit_progress_to(p_milestone_id UUID, p_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r milestone_progress_log%ROWTYPE;
  prior TIMESTAMPTZ;
BEGIN
  SELECT * INTO r FROM milestone_progress_log
   WHERE milestone_id = p_milestone_id
   ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'late'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = r.org_id AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF r.entered_at IS NOT NULL OR r.at < now() - interval '2 minutes' THEN RETURN 'late'; END IF;
  IF p_at >= now() OR p_at < now() - interval '30 days' THEN RETURN 'range'; END IF;
  SELECT max(at) INTO prior FROM milestone_progress_log
   WHERE milestone_id = p_milestone_id AND id <> r.id AND old_status IS NOT NULL;
  IF prior IS NOT NULL AND prior > p_at THEN RETURN 'changed'; END IF;
  UPDATE milestone_progress_log SET entered_at = at, at = p_at WHERE id = r.id;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION credit_progress_to(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_progress_to(UUID, TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION set_progress_time(p_log_id BIGINT, p_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r milestone_progress_log%ROWTYPE;
BEGIN
  SELECT * INTO r FROM milestone_progress_log WHERE id = p_log_id;
  IF NOT FOUND THEN RETURN 'error'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = r.org_id AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF r.old_status IS NULL THEN RETURN 'start'; END IF;
  IF p_at > now() + interval '1 minute' OR p_at < now() - interval '60 days' THEN RETURN 'range'; END IF;
  UPDATE milestone_progress_log SET entered_at = COALESCE(entered_at, at), at = p_at WHERE id = r.id;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION set_progress_time(BIGINT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_progress_time(BIGINT, TIMESTAMPTZ) TO authenticated;

NOTIFY pgrst, 'reload schema';
