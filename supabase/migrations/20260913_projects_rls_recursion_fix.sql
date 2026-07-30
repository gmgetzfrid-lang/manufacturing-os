-- 20260913_projects_rls_recursion_fix.sql
--
-- HOTFIX: 20260906 created a policy recursion loop —
--
--   projects  (RESTRICTIVE visibility SELECT) ──looks up──▶ project_members
--   project_members (SELECT)                  ──looks up──▶ projects
--
-- Postgres detects the cycle (42P17 "infinite recursion detected in
-- policy") and every SELECT on either table returns HTTP 500 through
-- PostgREST — the dashboard's project widgets, the projects page, and
-- anything that touches project_activity / intake links along the way.
--
-- Fix: the cross-table lookups move into SECURITY DEFINER helpers, which
-- read the other table WITHOUT re-entering its RLS — the recursion chain
-- terminates at the function boundary. Policy INTENT is unchanged: same
-- people can see and do exactly the same things as 20260906 intended.
--
-- Idempotent. Apply after 20260906 (safe any time after).

-- ── SECURITY DEFINER helpers (the recursion breakers) ────────────────────
CREATE OR REPLACE FUNCTION is_project_member(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM project_members
                 WHERE project_id = p_project AND user_id::text = auth.uid()::text);
$$;

CREATE OR REPLACE FUNCTION project_org(p_project uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM projects WHERE id = p_project;
$$;

CREATE OR REPLACE FUNCTION is_project_owner(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM projects
                 WHERE id = p_project AND owner_user_id::text = auth.uid()::text);
$$;

-- Full visibility rule in one place: org member AND (project not private,
-- or viewer is its owner / a controller / on the roster).
CREATE OR REPLACE FUNCTION project_visible_to_me(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
    JOIN org_members om ON om.org_id = p.org_id
      AND om.uid = auth.uid() AND om.status = 'active'
    WHERE p.id = p_project
      AND (p.visibility IS DISTINCT FROM 'private'
           OR p.owner_user_id::text = auth.uid()::text
           OR is_org_controller(p.org_id)
           OR EXISTS (SELECT 1 FROM project_members pm
                      WHERE pm.project_id = p.id
                        AND pm.user_id::text = auth.uid()::text))
  );
$$;

GRANT EXECUTE ON FUNCTION is_project_member(uuid),
                          project_org(uuid),
                          is_project_owner(uuid),
                          project_visible_to_me(uuid) TO authenticated;

-- ── projects: restrictive visibility, now recursion-free ─────────────────
DROP POLICY IF EXISTS projects_visibility_select ON projects;
CREATE POLICY projects_visibility_select ON projects
  AS RESTRICTIVE FOR SELECT
  USING (
    visibility IS DISTINCT FROM 'private'
    OR owner_user_id::text = auth.uid()::text
    OR is_org_controller(org_id)
    OR is_project_member(projects.id)
  );

-- ── project_members: read via org lookup, write via owner/controller ─────
DROP POLICY IF EXISTS project_members_select ON project_members;
CREATE POLICY project_members_select ON project_members FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members
          WHERE org_id = project_org(project_members.project_id)
            AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS project_members_write ON project_members;
CREATE POLICY project_members_write ON project_members FOR ALL USING (
  is_org_controller(project_org(project_members.project_id))
  OR is_project_owner(project_members.project_id)
) WITH CHECK (
  is_org_controller(project_org(project_members.project_id))
  OR is_project_owner(project_members.project_id)
);

-- ── project_activity: visibility-aware read; owner/controller delete ─────
DROP POLICY IF EXISTS project_activity_select ON project_activity;
CREATE POLICY project_activity_select ON project_activity FOR SELECT USING (
  project_visible_to_me(project_activity.project_id)
);
DROP POLICY IF EXISTS project_activity_delete ON project_activity;
CREATE POLICY project_activity_delete ON project_activity FOR DELETE USING (
  is_org_controller(org_id) OR is_project_owner(project_activity.project_id)
);

-- ── intake links: controllers + the project owner ────────────────────────
DROP POLICY IF EXISTS project_intake_links_select ON project_intake_links;
CREATE POLICY project_intake_links_select ON project_intake_links FOR SELECT USING (
  is_org_controller(org_id) OR is_project_owner(project_intake_links.project_id)
);
