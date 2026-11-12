-- Materials register: every material and off-site repair an event needs,
-- each with its specification, an owner, a status, a need-by date and any
-- open question. Opened at scope freeze and checked at every gate.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS project_materials (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The phase it is for (projects.shift_times.phases), when the project has phases.
  phase_id         TEXT,
  -- material | offsite (a repair or calibration sent out)
  kind             TEXT NOT NULL DEFAULT 'material',
  item             TEXT NOT NULL,
  spec             TEXT,
  -- What the specification still lacks ("length"); empty when complete.
  spec_missing     TEXT,
  qty              TEXT,
  -- The work order or equipment it is for, and its step when picked.
  work_order       TEXT,
  milestone_id     UUID,
  owner            TEXT,
  vendor           TEXT,
  -- to_specify | ready | ordered | at_vendor | received | checked | short | cancelled
  status           TEXT NOT NULL DEFAULT 'to_specify',
  need_by          DATE,
  eta              DATE,
  eta_note         TEXT,
  -- A question holding it up, who asked and when; and its answer.
  question         TEXT,
  question_at      TIMESTAMPTZ,
  question_by      TEXT,
  answer           TEXT,
  answered_at      TIMESTAMPTZ,
  note             TEXT,
  created_by       UUID,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_name  TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_materials_kind_check CHECK (kind IN ('material', 'offsite')),
  CONSTRAINT project_materials_status_check CHECK (status IN ('to_specify', 'ready', 'ordered', 'at_vendor', 'received', 'checked', 'short', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS project_materials_project_idx ON project_materials(project_id);

ALTER TABLE project_materials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_materials_read ON project_materials;
CREATE POLICY project_materials_read ON project_materials FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_materials.org_id AND uid = auth.uid() AND status = 'active'));
DROP POLICY IF EXISTS project_materials_insert ON project_materials;
CREATE POLICY project_materials_insert ON project_materials FOR INSERT TO authenticated
  WITH CHECK (can_edit_project(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_materials.project_id AND p.org_id = project_materials.org_id));
DROP POLICY IF EXISTS project_materials_update ON project_materials;
CREATE POLICY project_materials_update ON project_materials FOR UPDATE TO authenticated
  USING (can_edit_project(project_id))
  WITH CHECK (can_edit_project(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_materials.project_id AND p.org_id = project_materials.org_id));
DROP POLICY IF EXISTS project_materials_delete ON project_materials;
CREATE POLICY project_materials_delete ON project_materials FOR DELETE TO authenticated
  USING (can_edit_project(project_id));

COMMENT ON TABLE project_materials IS 'Materials register: each material and off-site repair for an event, with its specification, owner, status, need-by date and open question.';

NOTIFY pgrst, 'reload schema';
