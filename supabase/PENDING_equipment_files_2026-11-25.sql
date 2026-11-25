-- Pending database step for the Equipment Files library (Nov 25, 2026).
-- Run once in the Supabase SQL editor. Safe to run more than once.
--
-- The map of the Equipment Files library (org_configurations key
-- 'equipment_files_place': which folder is which unit, type and piece of
-- equipment) is a workspace setting. Today the permissive org policy lets
-- any active member write that row, so a member could point every piece
-- of equipment's files at another library from the browser. After this,
-- only Admin and Document Control write it, the same people who make the
-- library's folders (collections inserts are already Admin/DocCtrl only,
-- 20261011). The app already writes it only for them.
--
-- Same policies as 20261120_signin_admin_writes.sql, with one more key.
-- Needs is_org_controller() (20260814), which this database already has.

DROP POLICY IF EXISTS org_config_key_writes_ins ON org_configurations;
CREATE POLICY org_config_key_writes_ins ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    WHEN 'equipment_files_place' THEN is_org_controller(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_upd ON org_configurations;
CREATE POLICY org_config_key_writes_upd ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    WHEN 'equipment_files_place' THEN is_org_controller(org_id)
    ELSE true END)
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    WHEN 'equipment_files_place' THEN is_org_controller(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_del ON org_configurations;
CREATE POLICY org_config_key_writes_del ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'signin'   THEN is_org_admin(org_id)
    WHEN 'equipment_files_place' THEN is_org_controller(org_id)
    ELSE true END);
