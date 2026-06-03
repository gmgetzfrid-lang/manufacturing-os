-- 20260713_branding_admin_writes.sql
-- Lock org branding (org_configurations key='branding') so only Admins can
-- write it, at the DATABASE layer — not just the UI. org_configurations
-- has a broad permissive "any active member" policy shared with other
-- settings keys, so we ADD restrictive write policies that AND with it:
-- for the 'branding' key, writes require Admin; all other keys are
-- unaffected. SELECT is intentionally left open so every member can read
-- the branding to apply the logo/palette.

-- Is the current user an Admin of the row's org?
CREATE OR REPLACE FUNCTION is_org_admin(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' AND role = 'Admin'
  );
$$;

DROP POLICY IF EXISTS org_config_branding_insert ON org_configurations;
CREATE POLICY org_config_branding_insert ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (key <> 'branding' OR is_org_admin(org_id));

DROP POLICY IF EXISTS org_config_branding_update ON org_configurations;
CREATE POLICY org_config_branding_update ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (key <> 'branding' OR is_org_admin(org_id))
  WITH CHECK (key <> 'branding' OR is_org_admin(org_id));

DROP POLICY IF EXISTS org_config_branding_delete ON org_configurations;
CREATE POLICY org_config_branding_delete ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (key <> 'branding' OR is_org_admin(org_id));
