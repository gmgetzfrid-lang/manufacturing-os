-- 20260818_followups_rls.sql
--
-- Remediation follow-ups: per-model delete gating, H6 config write gating,
-- and two helper RPCs (share counter, rev-up orphan rollback). Every policy
-- is RESTRICTIVE (ANDs with the existing permissive org policy) and reversible
-- via DROP.

-- ── Helpers ─────────────────────────────────────────────────────
-- Can the caller manage a project (owner, Admin/Manager, or project member)?
CREATE OR REPLACE FUNCTION can_manage_project(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p WHERE p.id = p_project AND (
      p.owner_user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = p.org_id AND om.uid = auth.uid()
                 AND om.status = 'active' AND (om.role IN ('Admin','Manager') OR om.roles && ARRAY['Admin','Manager']::text[]))
      OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
    )
  );
$$;

-- Does the caller hold a request-routing (assign_drafters) role?
CREATE OR REPLACE FUNCTION is_org_assign_drafters(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members WHERE uid = auth.uid() AND org_id = p_org AND status = 'active'
      AND (role IN ('Admin','Manager','Supervisor','DraftingSupervisor')
           OR roles && ARRAY['Admin','Manager','Supervisor','DraftingSupervisor']::text[])
  );
$$;

-- ── Per-model deletes ───────────────────────────────────────────
-- document_sets: SetManager gates every set mutation to controllers (Admin/
-- DocCtrl), so mirror that at the DB.
DROP POLICY IF EXISTS document_sets_delete_controllers ON document_sets;
CREATE POLICY document_sets_delete_controllers ON document_sets
  AS RESTRICTIVE FOR DELETE USING (is_org_controller(org_id));

-- milestones: project-management model — deletable by Admin/Manager, the
-- creator, or someone who can manage the owning project. Blocks a random
-- member (Viewer) from deleting another team's schedule via the API.
DROP POLICY IF EXISTS milestones_delete_guard ON milestones;
CREATE POLICY milestones_delete_guard ON milestones
  AS RESTRICTIVE FOR DELETE USING (
    is_org_admin_or_manager(org_id)
    OR created_by = auth.uid()
    OR (project_id IS NOT NULL AND can_manage_project(project_id))
  );

-- transmittals: same shape (issuer / project manager / Admin/Manager).
DROP POLICY IF EXISTS transmittals_delete_guard ON transmittals;
CREATE POLICY transmittals_delete_guard ON transmittals
  AS RESTRICTIVE FOR DELETE USING (
    is_org_admin_or_manager(org_id)
    OR created_by = auth.uid()
    OR (project_id IS NOT NULL AND can_manage_project(project_id))
  );

-- ── H6: org_configurations writes, per key ──────────────────────
-- Only the two keys the app actually writes are constrained; any other key is
-- left to the permissive org policy so no unknown writer is broken.
--   branding -> Admin (matches the intent of 20260713, which never applied)
--   drafting -> assign_drafters roles (routing config)
DROP POLICY IF EXISTS org_config_key_writes_ins ON org_configurations;
CREATE POLICY org_config_key_writes_ins ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_upd ON org_configurations;
CREATE POLICY org_config_key_writes_upd ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    ELSE true END)
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_del ON org_configurations;
CREATE POLICY org_config_key_writes_del ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    ELSE true END);

-- ── Helper RPCs ─────────────────────────────────────────────────
-- Atomic share access counter (fixes the client-side "= 1" write). SECURITY
-- DEFINER so it increments regardless of the caller's row access.
CREATE OR REPLACE FUNCTION bump_share_access(p_share uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE document_shares
     SET access_count = COALESCE(access_count, 0) + 1,
         access_last_at = now()
   WHERE id = p_share;
$$;

-- Compensating rollback for a failed rev-up: remove the orphan version that
-- was inserted before the parent-document promotion failed, and un-supersede
-- the previous version. SECURITY DEFINER so it works from the drafter's
-- session despite the controller-only delete policy on document_versions.
CREATE OR REPLACE FUNCTION revup_rollback_orphan(p_version uuid, p_prev uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM document_versions WHERE id = p_version;
  IF p_prev IS NOT NULL THEN
    UPDATE document_versions SET superseded_at = NULL WHERE id = p_prev;
  END IF;
END;
$$;
