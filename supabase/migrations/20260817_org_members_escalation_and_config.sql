-- 20260817_org_members_escalation.sql
--
-- CRITICAL privilege escalation via org_members UPDATE.
--
-- org_members_update was USING (org_id IN my_org_ids()) — i.e. ANY active
-- member could UPDATE any org_members row in their org, including their own
-- role. A Viewer could self-promote to Admin with a single PostgREST call.
-- The only client update path is the admin Team-management page (already
-- admin-gated in the UI), so restricting this at the DB breaks nothing
-- legitimate. We also stop a Manager from granting/keeping Admin (only an
-- Admin may confer Admin) — on both UPDATE and INSERT.
--
-- (H6 / org_configurations write-gating is intentionally NOT here: the
-- 'drafting' routing config is saved via the user client and may legitimately
-- be edited by non-controller roles — e.g. Supervisors with assign_drafters —
-- so it needs a per-key role mapping, not a blanket controller gate.)
--
-- Reversible via DROP POLICY (restoring the prior policies from schema.sql).

-- Helper: is the caller an Admin or Manager of the org (additive roles aware)?
CREATE OR REPLACE FUNCTION is_org_admin_or_manager(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active'
      AND (role IN ('Admin', 'Manager') OR roles && ARRAY['Admin', 'Manager']::text[])
  );
$$;

-- org_members UPDATE: Admin/Manager only, and only an Admin may confer Admin.
DROP POLICY IF EXISTS org_members_update ON org_members;
CREATE POLICY org_members_update ON org_members
  FOR UPDATE
  USING (is_org_admin_or_manager(org_id))
  WITH CHECK (
    is_org_admin_or_manager(org_id)
    AND (
      NOT (role = 'Admin' OR roles && ARRAY['Admin']::text[])
      OR is_org_admin(org_id)
    )
  );

-- org_members INSERT: keep Admin/Manager, but only an Admin may create an Admin.
DROP POLICY IF EXISTS org_members_write ON org_members;
CREATE POLICY org_members_write ON org_members
  FOR INSERT
  WITH CHECK (
    is_org_admin_or_manager(org_id)
    AND (
      NOT (role = 'Admin' OR roles && ARRAY['Admin']::text[])
      OR is_org_admin(org_id)
    )
  );
