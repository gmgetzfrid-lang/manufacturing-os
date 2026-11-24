-- Materials register: two owners and "Used on the job" (docs/next-update.md,
-- section 7).
--
--   - owner (kept as it is) is now the warehouse owner: gets it in and
--     checks it.
--   - crew_owner is new: the turnaround crew person who makes sure it is
--     used on the job. A line with either owner missing is flagged.
--   - status 'used' ("Used on the job") comes after 'checked' ("Received,
--     checked"), marked by the crew owner, so done means done.
--
-- Run after 20261119_project_materials.sql. Safe to run more than once.
-- Row level security is unchanged. Until this runs, the app saves a line
-- without the crew owner and "used" and says so.

ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS crew_owner TEXT;

ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_materials_status_check;
ALTER TABLE project_materials ADD CONSTRAINT project_materials_status_check
  CHECK (status IN ('to_specify', 'ready', 'ordered', 'at_vendor', 'received', 'checked', 'used', 'short', 'cancelled'));

COMMENT ON COLUMN project_materials.owner IS 'Warehouse owner: gets it in and checks it.';
COMMENT ON COLUMN project_materials.crew_owner IS 'Crew owner: makes sure it is used on the job, and marks it used.';

NOTIFY pgrst, 'reload schema';
