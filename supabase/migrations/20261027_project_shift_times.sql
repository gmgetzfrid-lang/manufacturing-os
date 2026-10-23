-- 20261027_project_shift_times.sql
--
-- The shift-change times (day starts 05:30, night starts 17:30 …) belong to
-- the project, not to one browser: every laptop and contractor tablet must
-- split day and night work the same way, or their shift reports disagree.
-- Shape: {"dayStart":"05:30","nightStart":"17:30"}. NULL = the defaults.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS shift_times JSONB;
COMMENT ON COLUMN projects.shift_times IS 'Shift-change times {dayStart, nightStart} as HH:MM in the project zone. NULL = 05:30 / 17:30.';
