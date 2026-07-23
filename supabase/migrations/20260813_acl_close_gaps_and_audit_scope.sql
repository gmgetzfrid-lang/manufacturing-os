-- 20260813_acl_close_gaps_and_audit_scope.sql
--
-- Phase 1 of the security remediation. Two independent, additive, fully
-- reversible hardenings. Neither changes behavior for any legitimate user:
-- at time of writing every documents/collections/document_sets row is
-- 'normal' visibility and every project is 'public', so the new SELECT
-- filters below evaluate TRUE for 100% of existing rows. They only ever
-- restrict FUTURE private/restricted records — and audit inserts are only
-- ever made against the caller's own org today.
--
-- Rollback for any policy: DROP POLICY <name> ON <table>;  (no data change)
--
-- ─────────────────────────────────────────────────────────────────────────
-- PART A — Close the ACL confidentiality gap (finding C3)
--
-- The RESTRICTIVE node_visible() SELECT overlay from 20260708 was only
-- attached to `documents` and `collections`. Three sibling tables that
-- expose the same private content were left with just the permissive
-- org-member policy, so any org member could read them directly via
-- PostgREST:
--   * document_versions — holds file_url (the actual bytes' storage key)
--   * document_sets      — has its own visibility/acl_index columns
--   * projects           — private projects were filtered client-side only
--
-- These are RESTRICTIVE FOR SELECT, so they AND with the existing permissive
-- org policy (a row must pass BOTH). Writes are unchanged.
-- ─────────────────────────────────────────────────────────────────────────

-- Is the parent document of a version visible to me? SECURITY DEFINER so it
-- reads `documents` WITHOUT re-applying that table's RLS inside this policy
-- (avoids nested-RLS surprises; there is no recursion since documents' own
-- policies never reference document_versions). Returns false for a missing
-- parent (a FK makes that impossible today, but be explicit).
CREATE OR REPLACE FUNCTION doc_is_visible(p_doc uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT node_visible(d.visibility, d.acl_index, d.org_id)
       FROM documents d WHERE d.id = p_doc),
    false);
$$;

DROP POLICY IF EXISTS document_versions_acl_select ON document_versions;
CREATE POLICY document_versions_acl_select ON document_versions
  AS RESTRICTIVE FOR SELECT
  USING (doc_is_visible(record_id));

-- document_sets carries its own visibility/acl_index — gate it directly,
-- exactly like documents/collections.
DROP POLICY IF EXISTS document_sets_acl_select ON document_sets;
CREATE POLICY document_sets_acl_select ON document_sets
  AS RESTRICTIVE FOR SELECT
  USING (node_visible(visibility, acl_index, org_id));

-- Projects use a membership model (project_members), not acl_index. A direct
-- reference to project_members here would mutually recurse with that table's
-- own RLS (which references projects), so resolve membership through a
-- SECURITY DEFINER helper that bypasses RLS.
CREATE OR REPLACE FUNCTION my_project_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT project_id FROM project_members WHERE user_id = auth.uid();
$$;

-- Mirrors lib/projects.ts exactly: visible if public, owned by me, or I'm a
-- member. (No admin override — matches the app's current documented rule.)
DROP POLICY IF EXISTS projects_visibility_select ON projects;
CREATE POLICY projects_visibility_select ON projects
  AS RESTRICTIVE FOR SELECT
  USING (
    COALESCE(visibility, 'public') <> 'private'
    OR owner_user_id = auth.uid()
    OR id IN (SELECT my_project_ids())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- PART B — Stop cross-org audit-log injection (finding H5)
--
-- The old insert policy only required user_id = auth.uid(), leaving org_id
-- unconstrained — so a member could write forged entries into ANOTHER org's
-- audit trail. Add an org-membership constraint. Legitimate inserts always
-- target the caller's own org (see lib/audit.ts), so nothing legitimate is
-- affected. Service-role server routes bypass RLS and are unaffected. Rows
-- remain append-only (no UPDATE/DELETE policy exists).
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))
  );
