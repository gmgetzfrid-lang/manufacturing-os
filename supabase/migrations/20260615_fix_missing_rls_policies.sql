-- 20260615_fix_missing_rls_policies.sql
--
-- BUGFIX — fills in RLS policies that were missing for tables
-- created in 20260527_projects_and_collaboration.sql but never
-- covered by 20260605_rls_policies_new_tables.sql.
--
-- Symptom that surfaced this gap:
--   ERROR: new row violates row-level security policy for table "projects"
--
-- If RLS is enabled on a table but no policy grants the operation,
-- Supabase rejects every INSERT/SELECT/UPDATE/DELETE from authenticated
-- users (service role still bypasses). Supabase Studio enables RLS
-- by default when you create tables through its UI, so this is easy
-- to miss in migration-first workflows.
--
-- This migration explicitly enables RLS AND adds the standard
-- org-member-all policy to every affected table. Pattern matches
-- 20260605 exactly so behavior is uniform across the codebase.
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already on,
-- DROP POLICY IF EXISTS + CREATE POLICY is safe to re-run.

-- ─── projects ───────────────────────────────────────────────────
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "projects_member_all" ON projects;
CREATE POLICY "projects_member_all" ON projects
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = projects.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = projects.org_id AND uid = auth.uid() AND status = 'active'));

-- ─── project_members ────────────────────────────────────────────
-- project_members has no org_id column directly — we join through
-- the parent project. Membership in the parent project's org is
-- what gates access.
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_members_via_project" ON project_members;
CREATE POLICY "project_members_via_project" ON project_members
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM projects p
    JOIN org_members om ON om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'
    WHERE p.id = project_members.project_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM projects p
    JOIN org_members om ON om.org_id = p.org_id AND om.uid = auth.uid() AND om.status = 'active'
    WHERE p.id = project_members.project_id
  ));

-- ─── project_activity ───────────────────────────────────────────
-- project_activity DOES carry org_id directly, so we use the
-- standard pattern.
ALTER TABLE project_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_activity_member_all" ON project_activity;
CREATE POLICY "project_activity_member_all" ON project_activity
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_activity.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_activity.org_id AND uid = auth.uid() AND status = 'active'));

-- ─── markup_requests ────────────────────────────────────────────
ALTER TABLE markup_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "markup_requests_member_all" ON markup_requests;
CREATE POLICY "markup_requests_member_all" ON markup_requests
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = markup_requests.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = markup_requests.org_id AND uid = auth.uid() AND status = 'active'));

-- ─── document_supersessions ─────────────────────────────────────
-- Created in 20260526_supersede_archive.sql, never got an RLS
-- policy. Same potential symptom: silent INSERT denial during
-- a supersede / split / merge.
ALTER TABLE document_supersessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_supersessions_member_all" ON document_supersessions;
CREATE POLICY "document_supersessions_member_all" ON document_supersessions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_supersessions.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_supersessions.org_id AND uid = auth.uid() AND status = 'active'));
