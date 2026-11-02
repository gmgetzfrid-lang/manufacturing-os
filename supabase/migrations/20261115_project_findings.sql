-- Findings: what a job taught, kept for the next one.
--
-- A finding is a problem, a lesson, a material shortfall or missed scope,
-- written during the job (+ Finding on a step, a work order, the hour by
-- hour) or found in the record at the close-out (added scope, discoveries,
-- comments, hold reasons, the team's lessons). Each one says what it applies
-- to: one piece of equipment, the unit, this project, or every job. Nothing
-- reaches the Intelligence graph, Ask or the next project's plan until the
-- close-out review keeps it.
--
-- finding_acks: a later project's answer to a finding shown under
-- "From past jobs" on its plan: planned for it, or not relevant.
--
-- Reading: any active member of the organization. Writing: the project's
-- owner, a co-owner or editor, or an org Admin, Manager, Supervisor or
-- Document Control (can_edit_project, from 20261114; created here if that
-- one hasn't been run). Also lets a project's owner, co-owners and editors
-- link it to its unit and equipment (Setup). Safe to run more than once.
-- Changes no existing data.

-- 1. Who may change a project's work (same as 20261114).
CREATE OR REPLACE FUNCTION can_edit_project(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p WHERE p.id = p_project AND (
      p.owner_user_id::text = auth.uid()::text
      OR EXISTS (SELECT 1 FROM org_members om
                 WHERE om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'
                   AND (om.role IN ('Admin', 'Manager', 'Supervisor', 'DocCtrl')
                        OR om.roles && ARRAY['Admin', 'Manager', 'Supervisor', 'DocCtrl']::text[]))
      OR EXISTS (SELECT 1 FROM project_members pm
                 WHERE pm.project_id = p.id AND pm.user_id::text = auth.uid()::text
                   AND pm.role IN ('owner', 'co_owner', 'collaborator'))
    )
  );
$$;
GRANT EXECUTE ON FUNCTION can_edit_project(uuid) TO authenticated;

-- 2. Findings.
CREATE TABLE IF NOT EXISTS project_findings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- problem | lesson | material | missed_scope
  kind             TEXT NOT NULL DEFAULT 'problem',
  -- equipment | unit | project | all
  applies_to       TEXT NOT NULL DEFAULT 'project',
  -- Materials | Planning | Contractors | Permits | Staffing | Safety | Scheduling | Other
  topic            TEXT NOT NULL DEFAULT 'Other',
  -- What happened, and what to do next time.
  body             TEXT NOT NULL,
  next_time        TEXT,
  -- What it's about (applies_to equipment: the asset; unit: the codebook unit).
  asset_id         UUID,
  asset_tag        TEXT,
  unit_code        TEXT,
  -- The project's type when it was written ("Turnaround"), so an all-jobs
  -- lesson reaches the next project of the same kind.
  project_type     TEXT,
  -- Where it came from on the schedule.
  milestone_id     UUID,
  work_order_ref   TEXT,
  -- Hours it cost (added work, time on hold), when the record says.
  hours            NUMERIC,
  -- manual | discovery | note | hold | lesson | lessons_learned
  source           TEXT NOT NULL DEFAULT 'manual',
  -- The record it came from (a discovery id, a comment id…), so a
  -- suggestion is reviewed once.
  source_ref       TEXT,
  -- open (not reviewed yet) | kept | dropped
  status           TEXT NOT NULL DEFAULT 'open',
  found_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID,
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by      UUID,
  reviewed_by_name TEXT,
  reviewed_at      TIMESTAMPTZ,
  CONSTRAINT project_findings_kind_check CHECK (kind IN ('problem', 'lesson', 'material', 'missed_scope')),
  CONSTRAINT project_findings_applies_check CHECK (applies_to IN ('equipment', 'unit', 'project', 'all')),
  CONSTRAINT project_findings_status_check CHECK (status IN ('open', 'kept', 'dropped'))
);

-- A suggestion is reviewed once: one row per project, source and record.
-- A plain unique index, not a partial one: keeping a suggestion saves with
-- ON CONFLICT on these three columns, which only a plain index can answer.
-- Findings written by hand have no source_ref, and NULLs never clash.
DROP INDEX IF EXISTS project_findings_source_uidx;
CREATE UNIQUE INDEX project_findings_source_uidx ON project_findings(project_id, source, source_ref);
CREATE INDEX IF NOT EXISTS project_findings_project_idx ON project_findings(project_id, status);
CREATE INDEX IF NOT EXISTS project_findings_org_idx ON project_findings(org_id, status);
CREATE INDEX IF NOT EXISTS project_findings_asset_idx ON project_findings(asset_id) WHERE asset_id IS NOT NULL;

ALTER TABLE project_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_findings_read ON project_findings;
CREATE POLICY project_findings_read ON project_findings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_findings.org_id AND uid = auth.uid() AND status = 'active'));
DROP POLICY IF EXISTS project_findings_insert ON project_findings;
CREATE POLICY project_findings_insert ON project_findings FOR INSERT TO authenticated
  WITH CHECK (can_edit_project(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_findings.project_id AND p.org_id = project_findings.org_id));
DROP POLICY IF EXISTS project_findings_update ON project_findings;
CREATE POLICY project_findings_update ON project_findings FOR UPDATE TO authenticated
  USING (can_edit_project(project_id))
  WITH CHECK (can_edit_project(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_findings.project_id AND p.org_id = project_findings.org_id));
DROP POLICY IF EXISTS project_findings_delete ON project_findings;
CREATE POLICY project_findings_delete ON project_findings FOR DELETE TO authenticated
  USING (can_edit_project(project_id));

COMMENT ON TABLE project_findings IS 'What a job taught: problems, lessons, material shortfalls and missed scope, each tied to equipment, a unit, the project or every job. Kept ones feed the Intelligence graph, Ask and the next project''s plan.';

-- 3. A later project's answer to a past finding.
CREATE TABLE IF NOT EXISTS finding_acks (
  finding_id   UUID NOT NULL REFERENCES project_findings(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id       UUID NOT NULL,
  -- planned | not_relevant
  status       TEXT NOT NULL,
  note         TEXT,
  by_user      UUID,
  by_name      TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (finding_id, project_id),
  CONSTRAINT finding_acks_status_check CHECK (status IN ('planned', 'not_relevant'))
);

CREATE INDEX IF NOT EXISTS finding_acks_project_idx ON finding_acks(project_id);

ALTER TABLE finding_acks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finding_acks_read ON finding_acks;
CREATE POLICY finding_acks_read ON finding_acks FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = finding_acks.org_id AND uid = auth.uid() AND status = 'active'));
DROP POLICY IF EXISTS finding_acks_write ON finding_acks;
CREATE POLICY finding_acks_write ON finding_acks FOR INSERT TO authenticated
  WITH CHECK (can_edit_project(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = finding_acks.project_id AND p.org_id = finding_acks.org_id));
DROP POLICY IF EXISTS finding_acks_update ON finding_acks;
CREATE POLICY finding_acks_update ON finding_acks FOR UPDATE TO authenticated
  USING (can_edit_project(project_id)) WITH CHECK (can_edit_project(project_id));
DROP POLICY IF EXISTS finding_acks_delete ON finding_acks;
CREATE POLICY finding_acks_delete ON finding_acks FOR DELETE TO authenticated
  USING (can_edit_project(project_id));

COMMENT ON TABLE finding_acks IS 'A project''s answer to a past finding shown on its plan: planned for it, or not relevant.';

-- 4. Setup › Unit & equipment: the project's owner, co-owners and editors
--    may link their own project to its unit and equipment (project_scope
--    links from proj:<id>), not only org Admins, Managers, Supervisors and
--    Document Control. Nothing else about the links changes.
DROP POLICY IF EXISTS estate_edges_project_scope_editors ON estate_edges;
CREATE POLICY estate_edges_project_scope_editors ON estate_edges FOR ALL TO authenticated
  USING (CASE WHEN type = 'project_scope' AND a ~ '^proj:[0-9a-fA-F-]{36}$'
              THEN can_edit_project(substring(a FROM 6)::uuid) ELSE false END)
  WITH CHECK (CASE WHEN type = 'project_scope' AND a ~ '^proj:[0-9a-fA-F-]{36}$'
                   THEN can_edit_project(substring(a FROM 6)::uuid)
                        AND EXISTS (SELECT 1 FROM projects p WHERE p.id = substring(a FROM 6)::uuid AND p.org_id = estate_edges.org_id)
                   ELSE false END);

NOTIFY pgrst, 'reload schema';
