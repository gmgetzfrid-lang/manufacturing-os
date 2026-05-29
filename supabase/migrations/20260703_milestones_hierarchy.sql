-- 20260703_milestones_hierarchy.sql
--
-- Real schedule model upgrade for the Execution view.
--
-- The original phase-7 schema treated milestones as flat dated
-- checkpoints — fine for "is this revision out yet?" gates, but not
-- enough to render a real execution schedule with parent tasks,
-- sub-tasks, start times, and shift breakdowns.
--
-- This migration is strictly additive — every existing milestone
-- keeps working with NULL parent / start columns. The Execution
-- view drives off the new fields; the existing Gantt + List views
-- ignore them and behave as before.

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS parent_id          UUID REFERENCES milestones(id) ON DELETE SET NULL,
  -- planned_start_at: when work BEGINS. planned_at remains the finish
  -- date for backward compatibility (every existing row has a finish
  -- date but no start). New imports populate both.
  ADD COLUMN IF NOT EXISTS planned_start_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_start_at    TIMESTAMPTZ,
  -- Summary tasks (a.k.a. rollup parents) — derived from MS Project's
  -- <Summary>1</Summary> and P6's WBS nodes. UI doesn't let users
  -- "complete" a summary directly; it rolls up from children.
  ADD COLUMN IF NOT EXISTS is_summary         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Outline level (1 = top, 2 = first child, etc). Lets the UI
  -- indent without recomputing from parent chains every render.
  ADD COLUMN IF NOT EXISTS outline_level      INTEGER,
  -- Source-tool WBS code, like "1.2.3" — purely decorative.
  ADD COLUMN IF NOT EXISTS wbs                TEXT,
  -- Execution shift. Heuristic on import (8am-6pm = day) but the
  -- user can override per row in the Execution view.
  ADD COLUMN IF NOT EXISTS shift              TEXT
                            CHECK (shift IS NULL OR shift IN ('day','night','swing'));

-- Allow the existing CHECK on `source` to accept new import sources
-- the MPXJ converter may emit. Drop + recreate so we widen the set
-- without losing the constraint.
ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_source_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_source_check
  CHECK (source IN ('manual','p6','msproject','csv','mpxj'));

CREATE INDEX IF NOT EXISTS milestones_parent_idx ON milestones(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS milestones_project_planned_start_idx
  ON milestones(project_id, planned_start_at) WHERE project_id IS NOT NULL;

COMMENT ON COLUMN milestones.parent_id        IS 'Parent task in the WBS. NULL = top level.';
COMMENT ON COLUMN milestones.planned_start_at IS 'When work is scheduled to begin. planned_at is the scheduled finish.';
COMMENT ON COLUMN milestones.actual_start_at  IS 'When work actually began. Set on first status=in_progress transition.';
COMMENT ON COLUMN milestones.is_summary       IS 'True for rollup parents — completion derives from children, not user action.';
COMMENT ON COLUMN milestones.outline_level    IS '1-based outline depth from the source file. Cached so the UI can indent without traversing parent chains.';
COMMENT ON COLUMN milestones.wbs              IS 'Decorative WBS code from the source tool ("1.2.3").';
COMMENT ON COLUMN milestones.shift            IS 'Execution shift the task lives on. day / night / swing. NULL = unset.';
