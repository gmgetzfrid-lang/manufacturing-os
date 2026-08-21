-- 20261010_explorer_view_prefs.sql
--
-- File-explorer view preferences.
--
-- 1. table_views.view_config — the per-(library × folder) presentation state
--    beyond columns/sort that already live on the row: layout (details |
--    list | grid | thumbs) and density. Stored per scope exactly like
--    columns: a tv_user_… row is one person's saved default, a tv_org_… row
--    is the org-wide default an Admin/DocCtrl publishes. Read-side
--    resolution is user → org → app default.
--
-- 2. Write-scope hardening on table_views. The table's one permissive
--    policy (schema.sql "table_views" FOR ALL) lets ANY active member write
--    ANY row in their org — including the tv_org_… org-default rows. The UI
--    only offers org saves to controllers, but the API surface didn't
--    enforce it. These restrictive policies make the DB match the product
--    rule: you may write your own rows; only Admin/DocCtrl may write the
--    org-default rows. Reads are untouched.

ALTER TABLE table_views ADD COLUMN IF NOT EXISTS view_config JSONB DEFAULT NULL;

COMMENT ON COLUMN table_views.view_config IS
  'Explorer presentation state: {"layout":"details|list|grid|thumbs","density":"compact|comfy"}. NULL = inherit (org default for user rows, app default for org rows).';

DROP POLICY IF EXISTS table_views_write_own_or_controller_ins ON table_views;
CREATE POLICY table_views_write_own_or_controller_ins ON table_views
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    owner_user_id = auth.uid()
    OR (owner_user_id IS NULL AND is_org_controller(org_id))
  );

DROP POLICY IF EXISTS table_views_write_own_or_controller_upd ON table_views;
CREATE POLICY table_views_write_own_or_controller_upd ON table_views
  AS RESTRICTIVE FOR UPDATE
  USING (
    owner_user_id = auth.uid()
    OR (owner_user_id IS NULL AND is_org_controller(org_id))
  )
  WITH CHECK (
    owner_user_id = auth.uid()
    OR (owner_user_id IS NULL AND is_org_controller(org_id))
  );

DROP POLICY IF EXISTS table_views_write_own_or_controller_del ON table_views;
CREATE POLICY table_views_write_own_or_controller_del ON table_views
  AS RESTRICTIVE FOR DELETE
  USING (
    owner_user_id = auth.uid()
    OR (owner_user_id IS NULL AND is_org_controller(org_id))
  );
