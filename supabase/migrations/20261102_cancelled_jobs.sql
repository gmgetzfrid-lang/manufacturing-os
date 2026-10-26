-- 20261102_cancelled_jobs.sql
--
-- A job taken off this schedule that still gets done somewhere else.
-- Nothing is deleted: the row stays, leaves every view and progress
-- number, and is listed on the close-out report with its note so it
-- isn't forgotten. Its steps go with it. A re-import leaves these alone.
--   cancelled_at        when it came off (NULL = on the schedule)
--   cancelled_by(_name) who took it off
--   cancel_note         why / what happens to it
--   moved_to            where it went: a date, an outage, a work order

ALTER TABLE milestones ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS cancelled_by UUID;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS cancel_note TEXT;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS moved_to TEXT;
