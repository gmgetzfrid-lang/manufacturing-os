-- 20261106_links_and_discovery.sql
--
-- The critical path calculated from the schedule's links.
--   projects.critical_mode gains 'links': the chain of linked work that
--   sets the finish date, recalculated as work moves (lib/cpm). NULL still
--   means "the app picks": calculated when the schedule is linked, else the
--   file's flags, else the estimate.
--
-- Discovery work needs no new columns: the steps it adds are ordinary
-- steps, marked in milestones.attributes.discovery (what was found, when,
-- by whom, and what it did to the schedule when it was added).

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_critical_mode_check;
ALTER TABLE projects ADD CONSTRAINT projects_critical_mode_check
  CHECK (critical_mode IS NULL OR critical_mode IN ('links', 'file', 'estimate', 'none'));

NOTIFY pgrst, 'reload schema';
