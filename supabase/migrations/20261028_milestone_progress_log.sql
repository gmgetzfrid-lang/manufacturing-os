-- 20261028_milestone_progress_log.sql
--
-- Where every task stood, over time. The schedule keeps only each task's
-- CURRENT % and status, so a shift report for an earlier shift could only
-- show today's progress. This log records every change — before and after
-- — so the report can show the job exactly as it stood at the end of any
-- shift.
--
-- Written by a trigger on milestones (every path that changes progress is
-- covered: the app, imports, undo, bulk changes), so nothing can forget.

CREATE TABLE IF NOT EXISTS milestone_progress_log (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL,
  project_id    UUID,
  -- No foreign key: the history outlives a delete, so a task brought back
  -- by Undo (same id) keeps its record of where it stood.
  milestone_id  UUID NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_status    TEXT,
  old_percent   NUMERIC,
  new_status    TEXT NOT NULL,
  new_percent   NUMERIC
);

CREATE INDEX IF NOT EXISTS milestone_progress_log_project_idx ON milestone_progress_log(project_id, at);
CREATE INDEX IF NOT EXISTS milestone_progress_log_milestone_idx ON milestone_progress_log(milestone_id, at);

ALTER TABLE milestone_progress_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS milestone_progress_log_read ON milestone_progress_log;
CREATE POLICY milestone_progress_log_read ON milestone_progress_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = milestone_progress_log.org_id AND uid = auth.uid() AND status = 'active'));
-- No insert / update / delete policy: only the trigger writes, and the
-- history can't be edited from the app.

CREATE OR REPLACE FUNCTION log_milestone_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO milestone_progress_log (org_id, project_id, milestone_id, old_status, old_percent, new_status, new_percent)
    VALUES (NEW.org_id, NEW.project_id, NEW.id, NULL, NULL, NEW.status, NEW.percent_complete);
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.percent_complete IS DISTINCT FROM OLD.percent_complete THEN
    INSERT INTO milestone_progress_log (org_id, project_id, milestone_id, old_status, old_percent, new_status, new_percent)
    VALUES (NEW.org_id, NEW.project_id, NEW.id, OLD.status, OLD.percent_complete, NEW.status, NEW.percent_complete);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS milestones_progress_log ON milestones;
CREATE TRIGGER milestones_progress_log
  AFTER INSERT OR UPDATE OF status, percent_complete ON milestones
  FOR EACH ROW EXECUTE FUNCTION log_milestone_progress();

-- Starting point: where every task stands now. (old = new: what it was
-- before this moment isn't known — the report says so for earlier shifts.)
INSERT INTO milestone_progress_log (org_id, project_id, milestone_id, at, old_status, old_percent, new_status, new_percent)
SELECT m.org_id, m.project_id, m.id, now(), m.status, m.percent_complete, m.status, m.percent_complete
FROM milestones m
WHERE NOT EXISTS (SELECT 1 FROM milestone_progress_log l WHERE l.milestone_id = m.id);

COMMENT ON TABLE milestone_progress_log IS 'Every change to a task''s status / % complete, before and after — so a shift report can show the job as it stood at the end of any past shift.';
