-- 20261104_progress_for_shift.sql
--
-- Corrections land on the shift they belong to. The progress log stamps
-- every change with the moment it was saved, so fixing yesterday's % this
-- morning counted as this shift's progress (or this shift's loss) — and
-- the shift it was really about never showed it.
--
-- The progress editor now asks which shift a change counts for. When it's
-- an earlier one, the app saves the change as usual and then calls
-- credit_progress_to(): the log line the save just wrote moves to that
-- shift (a minute before it ended). The moment it was really typed in is
-- kept in entered_at.
--
-- Guard rails:
--   - only the change just saved (its line is under 2 minutes old) and
--     only once;
--   - only back to within the last 7 days, never into the future;
--   - never before another change to the same step (the history stays in
--     order — "changed" is returned and the change stays where it is);
--   - only members of the step's organisation.

ALTER TABLE milestone_progress_log ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ;
COMMENT ON COLUMN milestone_progress_log.entered_at IS 'When a change filed under an earlier shift was really entered (at = the shift it counts for). Null = entered at "at".';

CREATE OR REPLACE FUNCTION credit_progress_to(p_milestone_id UUID, p_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r milestone_progress_log%ROWTYPE;
  prior TIMESTAMPTZ;
BEGIN
  SELECT * INTO r FROM milestone_progress_log
   WHERE milestone_id = p_milestone_id
   ORDER BY at DESC, id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN 'late'; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = r.org_id AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF r.entered_at IS NOT NULL OR r.at < now() - interval '2 minutes' THEN RETURN 'late'; END IF;
  IF p_at >= now() OR p_at < now() - interval '7 days' THEN RETURN 'range'; END IF;
  SELECT max(at) INTO prior FROM milestone_progress_log
   WHERE milestone_id = p_milestone_id AND id <> r.id;
  IF prior IS NOT NULL AND prior >= p_at THEN RETURN 'changed'; END IF;
  UPDATE milestone_progress_log SET entered_at = at, at = p_at WHERE id = r.id;
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION credit_progress_to(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit_progress_to(UUID, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION credit_progress_to(UUID, TIMESTAMPTZ) IS 'Files the progress change just saved on a step under an earlier shift (moves its log line to p_at, keeps the real time in entered_at). Returns ok | changed | late | range.';

-- PostgREST picks up the new function without a restart.
NOTIFY pgrst, 'reload schema';
