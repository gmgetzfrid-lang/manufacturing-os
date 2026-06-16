-- 20260731_milestone_percent_complete.sql
--
-- Per-task PHYSICAL PROGRESS as a 0–100 percentage.
--
-- Until now a milestone was effectively binary: 'completed' or not, and the
-- earned-value rollup counted a task as 0% or 100%. Real field work is never
-- that crisp — a task is "60% done". This adds an explicit percent_complete so:
--   * leaf tasks carry their own % (the bar fills proportionally),
--   * summary/parent % is rolled up from children (computed at read time,
--     never stored — see lib/scheduleProgress.ts),
--   * earned value uses the real % instead of a binary completed flag.
--
-- Status/percent coupling is enforced in the app layer (lib/milestones.ts):
--   completed ⇒ 100,  planned ⇒ 0,  in_progress ⇒ 1..99 (typical);
--   blocked / on_hold / missed keep whatever % was already logged.
--
-- Additive + idempotent.

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS percent_complete NUMERIC NOT NULL DEFAULT 0;

-- Range guard (separate so it's idempotent even if the column already existed).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'milestones_percent_complete_range'
  ) THEN
    ALTER TABLE milestones
      ADD CONSTRAINT milestones_percent_complete_range
      CHECK (percent_complete >= 0 AND percent_complete <= 100);
  END IF;
END $$;

-- Backfill from the legacy binary status so existing schedules read sensibly:
-- completed work shows 100%; in-progress work with nothing logged yet shows a
-- nominal 50% (so it doesn't look untouched). Everything else stays 0.
UPDATE milestones SET percent_complete = 100 WHERE status = 'completed'   AND percent_complete = 0;
UPDATE milestones SET percent_complete = 50  WHERE status = 'in_progress' AND percent_complete = 0;
