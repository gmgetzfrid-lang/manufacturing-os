-- OPTIONAL. Viewers read only, in the database too. The app already keeps a
-- project's viewers ("observer") from changing its schedule and shift
-- records; until this runs, the database lets any active member of the
-- organization write them (an API call could). After it, writing a
-- project's tasks and shift records takes: the owner, a co-owner or editor
-- on the project, or an org Admin, Manager, Supervisor or Document Control.
-- Run 20261113_project_co_owners.sql first. Safe to run more than once.

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

-- Tasks on a project (milestones with no project are left as they are).
DROP POLICY IF EXISTS milestones_insert_editors ON milestones;
CREATE POLICY milestones_insert_editors ON milestones AS RESTRICTIVE FOR INSERT
  WITH CHECK (project_id IS NULL OR can_edit_project(project_id));
DROP POLICY IF EXISTS milestones_update_editors ON milestones;
CREATE POLICY milestones_update_editors ON milestones AS RESTRICTIVE FOR UPDATE
  USING (project_id IS NULL OR can_edit_project(project_id))
  WITH CHECK (project_id IS NULL OR can_edit_project(project_id));

-- Shift records (meetings, hour by hour, lock report).
DROP POLICY IF EXISTS shift_handovers_write_editors ON shift_handovers;
CREATE POLICY shift_handovers_write_editors ON shift_handovers AS RESTRICTIVE FOR INSERT
  WITH CHECK (can_edit_project(project_id));
DROP POLICY IF EXISTS shift_handovers_update_editors ON shift_handovers;
CREATE POLICY shift_handovers_update_editors ON shift_handovers AS RESTRICTIVE FOR UPDATE
  USING (can_edit_project(project_id)) WITH CHECK (can_edit_project(project_id));
