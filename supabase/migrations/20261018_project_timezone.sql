-- Project timezone: the plant's IANA zone ("America/Chicago").
--
-- Every schedule date is displayed, bucketed into calendar days and typed
-- into forms in THIS zone, for every viewer, so a turnaround crew in three
-- cities sees the same day boundaries. Milestone timestamps stay UTC
-- instants; only the interpretation changes.
--
-- NULL means UTC, which is exactly how schedules behaved before this
-- column existed, so no existing project moves until someone sets the
-- plant's zone in project settings (which re-anchors the schedule's
-- wall-clock times, see lib/milestones.ts shiftScheduleTimeZone).

ALTER TABLE projects ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN projects.timezone IS
  'IANA zone the schedule is read and written in (NULL = UTC).';
