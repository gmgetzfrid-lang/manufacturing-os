-- 20260705_milestones_execution_richdata.sql
--
-- Execution-layer upgrade. The original phase-7 schema deliberately
-- excluded resources, cost, and anything beyond planned/actual dates.
-- The Execution view has outgrown that: field crews need the work
-- order #, who's responsible (and who ACTUALLY did it), the
-- contractor/department, location, planned work hours, and an
-- arbitrary bag of whatever extra columns the source schedule
-- carried (every org labels them differently). They also need to
-- mark work On Hold and leave a breadcrumb note on every status
-- change ("waiting on parts", "contractor no-show").
--
-- Strictly additive. Existing rows keep working with NULL/{} in the
-- new columns; older views ignore them.

ALTER TABLE milestones
  -- EAM / CMMS work order reference (Infor EAM, Maximo, SAP PM, ...).
  ADD COLUMN IF NOT EXISTS work_order_ref    TEXT,
  -- PLANNED ownership.
  ADD COLUMN IF NOT EXISTS responsible_party TEXT,   -- person / crew name
  ADD COLUMN IF NOT EXISTS responsible_kind  TEXT,   -- 'employee' | 'contractor' | free text
  ADD COLUMN IF NOT EXISTS responsible_org   TEXT,   -- department or contractor company
  -- ACTUAL ownership (who really executed it — may differ from plan).
  ADD COLUMN IF NOT EXISTS actual_party      TEXT,
  ADD COLUMN IF NOT EXISTS actual_kind       TEXT,
  ADD COLUMN IF NOT EXISTS actual_org        TEXT,
  -- Where the work happens (area / unit / equipment tag).
  ADD COLUMN IF NOT EXISTS location          TEXT,
  -- Planned work in hours (MS Project "Work" / P6 budgeted units).
  ADD COLUMN IF NOT EXISTS duration_hours    NUMERIC,
  -- Catch-all for any source column we don't have a first-class home
  -- for: custom Text1-30 fields, resource lists, predecessors, etc.
  -- Keyed by the source's own column label so it's self-describing.
  ADD COLUMN IF NOT EXISTS attributes        JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Widen the status set to include 'on_hold'.
ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_status_check;
ALTER TABLE milestones
  ADD CONSTRAINT milestones_status_check
  CHECK (status IN ('planned','in_progress','completed','missed','blocked','on_hold'));

-- ── Breadcrumb / activity notes on a milestone ──────────────────
-- Every status change or free-form field note lands here so the task
-- carries its own running log: who, when, what status, and why.
CREATE TABLE IF NOT EXISTS milestone_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  milestone_id    UUID NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  -- 'status'    → emitted on a status transition
  -- 'reschedule'→ emitted when dragged / dates changed
  -- 'note'      → free-form note the user typed
  kind            TEXT NOT NULL DEFAULT 'note'
                  CHECK (kind IN ('status','reschedule','note','field')),
  -- The status the milestone was in at the moment of the note.
  status_at       TEXT,
  body            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  created_by      UUID NOT NULL,
  created_by_name TEXT
);

CREATE INDEX IF NOT EXISTS milestone_notes_milestone_idx ON milestone_notes(milestone_id, created_at DESC);
CREATE INDEX IF NOT EXISTS milestone_notes_org_idx       ON milestone_notes(org_id);

ALTER TABLE milestone_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "milestone_notes_member_all" ON milestone_notes;
CREATE POLICY "milestone_notes_member_all" ON milestone_notes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = milestone_notes.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = milestone_notes.org_id AND uid = auth.uid() AND status = 'active'));

COMMENT ON COLUMN milestones.attributes      IS 'Self-describing bag of source columns we have no first-class field for (custom Text fields, resource lists, predecessors). Keyed by source label.';
COMMENT ON COLUMN milestones.duration_hours  IS 'Planned work in hours (MS Project Work / P6 budgeted units).';
COMMENT ON TABLE  milestone_notes            IS 'Per-milestone activity log: status changes, reschedules, and free-form field notes.';
