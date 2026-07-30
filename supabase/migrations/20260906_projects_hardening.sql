-- 20260906_projects_hardening.sql
--
-- Projects-section audit remediation (database layer):
--
--   1. document_versions.review_state admits 'rejected' — the intake
--      review queue's Reject wrote a value the CHECK forbade, silently
--      half-completing (doc unblocked, version stuck "in_review").
--   2. The blanket projects_member_all FOR ALL policy let ANY org member
--      (including Viewer) UPDATE or DELETE any project. Split into:
--      member read/insert; owner-or-controller update/delete. Same
--      treatment for project_members, project_activity, markup_requests.
--   3. Admin/DocCtrl can now see private projects (the restrictive
--      visibility policy previously had no controller override, silently
--      contradicting the app's "admins see everything").
--   4. project_activity SELECT now honors project visibility — private
--      projects' activity was readable org-wide.
--   5. Cost tables (project_parties, cost_accounts, cost_documents,
--      cost_entries): write access drops from "any member" to
--      controllers; members keep read. (The cost module manages them.)
--   6. project_intake_links SELECT narrows to controllers + the project
--      owner — every org member could read contractor upload tokens.
--
-- Additive + idempotent. Apply after 20260905 (or 20260903 if you skipped
-- the unit-models era).

-- ── 1. review_state: allow 'rejected' ───────────────────────────────────
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'document_versions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%review_state%'
  LOOP
    EXECUTE format('ALTER TABLE document_versions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_review_state_check
  CHECK (review_state IS NULL OR review_state IN ('in_review','approved','rejected'));

-- ── helper predicates (inline, no new functions needed) ─────────────────
-- is_org_controller(org_id) already exists (Admin/DocCtrl).

-- ── 2. projects: split the blanket policy ───────────────────────────────
DROP POLICY IF EXISTS "projects_member_all" ON projects;
DROP POLICY IF EXISTS projects_select_member ON projects;
CREATE POLICY projects_select_member ON projects FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = projects.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS projects_insert_member ON projects;
CREATE POLICY projects_insert_member ON projects FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = projects.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS projects_update_owner ON projects;
CREATE POLICY projects_update_owner ON projects FOR UPDATE USING (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text
) WITH CHECK (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text
);
DROP POLICY IF EXISTS projects_delete_owner ON projects;
CREATE POLICY projects_delete_owner ON projects FOR DELETE USING (
  is_org_controller(org_id) OR owner_user_id::text = auth.uid()::text
);

-- ── 3. visibility: controllers see private projects ─────────────────────
DROP POLICY IF EXISTS projects_visibility_select ON projects;
CREATE POLICY projects_visibility_select ON projects
  AS RESTRICTIVE FOR SELECT
  USING (
    visibility IS DISTINCT FROM 'private'
    OR owner_user_id::text = auth.uid()::text
    OR is_org_controller(org_id)
    OR EXISTS (SELECT 1 FROM project_members pm
               WHERE pm.project_id = projects.id AND pm.user_id::text = auth.uid()::text)
  );

-- ── project_members: read member; write owner/controller ────────────────
DROP POLICY IF EXISTS project_members_via_project ON project_members;
DROP POLICY IF EXISTS "project_members_via_project" ON project_members;
DROP POLICY IF EXISTS project_members_select ON project_members;
CREATE POLICY project_members_select ON project_members FOR SELECT USING (
  EXISTS (SELECT 1 FROM projects p
          JOIN org_members om ON om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'
          WHERE p.id = project_members.project_id)
);
DROP POLICY IF EXISTS project_members_write ON project_members;
CREATE POLICY project_members_write ON project_members FOR ALL USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_members.project_id
          AND (is_org_controller(p.org_id) OR p.owner_user_id::text = auth.uid()::text))
) WITH CHECK (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_members.project_id
          AND (is_org_controller(p.org_id) OR p.owner_user_id::text = auth.uid()::text))
);

-- ── 4. project_activity: visibility-aware read; member insert ───────────
DROP POLICY IF EXISTS project_activity_member_all ON project_activity;
DROP POLICY IF EXISTS "project_activity_member_all" ON project_activity;
DROP POLICY IF EXISTS project_activity_select ON project_activity;
CREATE POLICY project_activity_select ON project_activity FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM projects p
    JOIN org_members om ON om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'
    WHERE p.id = project_activity.project_id
      AND (p.visibility IS DISTINCT FROM 'private'
           OR p.owner_user_id::text = auth.uid()::text
           OR is_org_controller(p.org_id)
           OR EXISTS (SELECT 1 FROM project_members pm
                      WHERE pm.project_id = p.id AND pm.user_id::text = auth.uid()::text))
  )
);
DROP POLICY IF EXISTS project_activity_insert ON project_activity;
CREATE POLICY project_activity_insert ON project_activity FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = project_activity.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS project_activity_delete ON project_activity;
CREATE POLICY project_activity_delete ON project_activity FOR DELETE USING (
  is_org_controller(org_id)
  OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_activity.project_id
             AND p.owner_user_id::text = auth.uid()::text)
);

-- ── markup_requests: participants mutate, members read ──────────────────
DROP POLICY IF EXISTS markup_requests_member_all ON markup_requests;
DROP POLICY IF EXISTS "markup_requests_member_all" ON markup_requests;
DROP POLICY IF EXISTS markup_requests_select ON markup_requests;
CREATE POLICY markup_requests_select ON markup_requests FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = markup_requests.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS markup_requests_insert ON markup_requests;
CREATE POLICY markup_requests_insert ON markup_requests FOR INSERT WITH CHECK (
  requested_by_user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM org_members WHERE org_id = markup_requests.org_id
              AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS markup_requests_update ON markup_requests;
CREATE POLICY markup_requests_update ON markup_requests FOR UPDATE USING (
  is_org_controller(org_id)
  OR requested_by_user_id = auth.uid()
  OR requested_from_user_id = auth.uid()
) WITH CHECK (
  is_org_controller(org_id)
  OR requested_by_user_id = auth.uid()
  OR requested_from_user_id = auth.uid()
);
DROP POLICY IF EXISTS markup_requests_delete ON markup_requests;
CREATE POLICY markup_requests_delete ON markup_requests FOR DELETE USING (
  is_org_controller(org_id) OR requested_by_user_id = auth.uid()
);

-- ── 5. cost tables: members read, controllers write ─────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_parties','cost_accounts','cost_documents','cost_entries'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = t) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_member_all', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = %I.org_id AND uid = auth.uid() AND status = ''active''))',
        t || '_select', t, t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (is_org_controller(org_id)) WITH CHECK (is_org_controller(org_id))',
        t || '_write', t);
    END IF;
  END LOOP;
END $$;

-- ── 6. intake links: tokens visible only to those who manage them ───────
DROP POLICY IF EXISTS project_intake_links_select ON project_intake_links;
CREATE POLICY project_intake_links_select ON project_intake_links FOR SELECT USING (
  is_org_controller(org_id)
  OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_intake_links.project_id
             AND p.owner_user_id::text = auth.uid()::text)
);
