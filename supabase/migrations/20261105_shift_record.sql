-- 20261105_shift_record.sql
--
-- Shift notes for the turnover, and the time each thing was really done.
-- Run this one file; it includes 20261104_progress_for_shift.sql (safe to
-- run again if that one was run already).
--
--   1. shift_handovers.record — what a shift records about itself at its
--      turnover: each crew's supervisor at the meeting and head count on
--      site, safety incidents (or "none"), and notes & actions (follow-ups
--      stay on the reports until cleared). The row for "2026-10-27:day" is
--      that shift's.
--   2. milestone_notes.happened_at — a comment entered after the fact
--      carries the time the work was really done.
--   3. milestone_notes kind 'behind' — why a step is behind plan, said for
--      the report next to its hours.
--   4. (from 20261104) the progress log line a change writes can be moved
--      to the time it really happened — credit_progress_to(), with the
--      time it was typed in kept in entered_at.

-- 1. ─────────────────────────────────────────────────────────────────────
ALTER TABLE shift_handovers ADD COLUMN IF NOT EXISTS record JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN shift_handovers.record IS 'The shift''s own record at its turnover: crews {name: {supervisor, headcount}}, incidents {none, items}, notes [{at, text, followUp, cleared}].';

-- 2. ─────────────────────────────────────────────────────────────────────
ALTER TABLE milestone_notes ADD COLUMN IF NOT EXISTS happened_at TIMESTAMPTZ;
COMMENT ON COLUMN milestone_notes.happened_at IS 'When what the note describes happened, when entered later. Null = created_at.';

-- 3. ─────────────────────────────────────────────────────────────────────
ALTER TABLE milestone_notes DROP CONSTRAINT IF EXISTS milestone_notes_kind_check;
ALTER TABLE milestone_notes ADD CONSTRAINT milestone_notes_kind_check
  CHECK (kind IN ('status','reschedule','note','field','behind'));

-- 4. (20261104) ──────────────────────────────────────────────────────────
ALTER TABLE milestone_progress_log ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ;
COMMENT ON COLUMN milestone_progress_log.entered_at IS 'When a change filed at an earlier time was really entered (at = when it happened). Null = entered at "at".';

-- Guard rails: only the change just saved (its line is under 2 minutes
-- old) and only once; only back to within 7 days, never into the future;
-- never before another change to the same step (the history stays in
-- order); only members of the step's organisation.
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

-- PostgREST picks up the new columns and function without a restart.
NOTIFY pgrst, 'reload schema';
