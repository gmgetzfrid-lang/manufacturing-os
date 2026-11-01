-- Project co-owners (Members > Co-owner): everything the project's owner can
-- do - its members and their permissions, its settings (Setup: shift
-- times, night crews, letterhead, project type, time zone), its status -
-- except delete the project or hand over ownership (the app keeps those to
-- the owner). Editors ("collaborator") update the work; viewers
-- ("observer") read.
--
-- Safe to run more than once.

-- 1. The new permission.
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_check
  CHECK (role IN ('owner', 'co_owner', 'collaborator', 'observer'));

-- 2. Co-owners count as owners wherever the owner is checked: members
--    (add, remove, change permission), the activity feed, intake links.
CREATE OR REPLACE FUNCTION is_project_owner(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM projects
                 WHERE id = p_project AND owner_user_id::text = auth.uid()::text)
      OR EXISTS (SELECT 1 FROM project_members
                 WHERE project_id = p_project AND user_id::text = auth.uid()::text
                   AND role = 'co_owner');
$$;

-- 3. ... and may change the project's settings.
DROP POLICY IF EXISTS projects_update_owner ON projects;
CREATE POLICY projects_update_owner ON projects FOR UPDATE USING (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text OR is_project_owner(id)
) WITH CHECK (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text OR is_project_owner(id)
);
