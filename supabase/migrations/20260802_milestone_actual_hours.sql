-- 20260802_milestone_actual_hours.sql
--
-- Actual hours worked per task — the field input that makes the COST side of
-- earned value self-driving.
--
-- duration_hours is PLANNED work (the budget, MS Project Work / P6 budgeted
-- units). This is the ACTUAL expended labor a field crew logs as the job runs.
-- Σ(actual_hours) × the project's blended rate becomes ACWP, so CPI / CV / EAC
-- compute straight from field data — no separate cost feed, no manual actual-
-- cost keying. A manager can still pin a manual actual cost to fold in non-
-- labor spend; logged hours drive it otherwise.
--
-- Strictly additive; NULL = "not yet logged". The app tolerates this column's
-- absence on pre-migration environments (the field-log write detects the
-- unknown column and tells the user to run the migration).

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS actual_hours NUMERIC;

COMMENT ON COLUMN milestones.actual_hours IS
  'Actual labor hours expended on this task (ACWP source for EVM). NULL until logged from the field. Distinct from duration_hours, which is planned/budgeted work.';
