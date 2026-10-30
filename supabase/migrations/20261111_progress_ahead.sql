-- Signing off ahead: a step finished (or started) a little later than the
-- moment it's entered - the supervisor signs it off before leaving. The
-- app asks first ("That's 30 min from now. Save it anyway?") and never
-- takes more than 12 hours ahead (a wrong day or AM / PM). Its progress
-- log line goes at that time too, so the hourly notes and the history
-- read the same time as the step.
--
-- credit_progress_to: as in 20261107, but up to 12 hours ahead.
-- set_progress_time: unchanged (fixing a logged time stays in the past).

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
  IF p_at > now() + interval '12 hours' OR p_at < now() - interval '30 days' THEN RETURN 'range'; END IF;
  SELECT max(at) INTO prior FROM milestone_progress_log
   WHERE milestone_id = p_milestone_id AND id <> r.id AND old_status IS NOT NULL;
  IF prior IS NOT NULL AND prior > p_at THEN RETURN 'changed'; END IF;
  UPDATE milestone_progress_log SET entered_at = at, at = p_at WHERE id = r.id;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION credit_progress_to(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_progress_to(UUID, TIMESTAMPTZ) TO authenticated;

NOTIFY pgrst, 'reload schema';
