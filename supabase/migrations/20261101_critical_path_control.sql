-- 20261101_critical_path_control.sql
--
-- Control over the critical path.
--   projects.critical_mode — where it comes from: 'file' (the schedule
--     file's own Critical flags), 'estimate' (the app's estimate) or
--     'none' (only what people mark). NULL = the file's flags when the
--     import has them, else the estimate.
--   milestones.critical_override — set by hand: 'yes' on the path, 'no'
--     off it, for the task and every step under it. NULL = as the project's
--     source has it. A re-import leaves it alone.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS critical_mode TEXT;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_critical_mode_check;
ALTER TABLE projects ADD CONSTRAINT projects_critical_mode_check
  CHECK (critical_mode IS NULL OR critical_mode IN ('file', 'estimate', 'none'));

ALTER TABLE milestones ADD COLUMN IF NOT EXISTS critical_override TEXT;
ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_critical_override_check;
ALTER TABLE milestones ADD CONSTRAINT milestones_critical_override_check
  CHECK (critical_override IS NULL OR critical_override IN ('yes', 'no'));
