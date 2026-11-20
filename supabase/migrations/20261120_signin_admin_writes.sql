-- Only Admins may change a workspace's sign-in rules (org_configurations
-- key 'signin'). Without this, the permissive org policy lets any active
-- member write that row, which would let them turn off "Microsoft only".
-- Same pattern as branding (Admin) and drafting (assign-drafters roles).

DROP POLICY IF EXISTS org_config_key_writes_ins ON org_configurations;
CREATE POLICY org_config_key_writes_ins ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_upd ON org_configurations;
CREATE POLICY org_config_key_writes_upd ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    ELSE true END)
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_del ON org_configurations;
CREATE POLICY org_config_key_writes_del ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    ELSE true END);
