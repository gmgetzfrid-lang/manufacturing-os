-- 20260605_rls_policies_new_tables.sql
--
-- RLS policies for every table created across recent feature pushes.
-- Without these, INSERT/SELECT/UPDATE/DELETE from the client-side
-- Supabase client (which uses the user's JWT, not service-role) are
-- rejected with "new row violates row-level security policy".
--
-- Pattern: org-scoped tables grant read/write to active org members.
-- User-scoped tables (favorites, notification_preferences) grant
-- read/write only to the owning user.
--
-- Role-based authorization (e.g. only Admins can delete an asset) is
-- handled in application code, not RLS — RLS just prevents
-- cross-tenant data access.

-- ─── Asset Registry (Phase A of Asset Registry) ─────────────────

ALTER TABLE asset_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_types_member_all" ON asset_types;
CREATE POLICY "asset_types_member_all" ON asset_types
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = asset_types.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = asset_types.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "assets_member_all" ON assets;
CREATE POLICY "assets_member_all" ON assets
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = assets.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = assets.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE asset_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_photos_member_all" ON asset_photos;
CREATE POLICY "asset_photos_member_all" ON asset_photos
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = asset_photos.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = asset_photos.org_id AND uid = auth.uid() AND status = 'active'));

-- ─── Documents library extras (Phases 2-5 of doc library upgrade) ─

-- Curated collections: org-scope visible to org members, user-scope only owner
ALTER TABLE curated_collections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "collections_select" ON curated_collections;
DROP POLICY IF EXISTS "collections_write" ON curated_collections;
CREATE POLICY "collections_select" ON curated_collections
  FOR SELECT TO authenticated
  USING (
    (scope = 'org' AND EXISTS (SELECT 1 FROM org_members WHERE org_id = curated_collections.org_id AND uid = auth.uid() AND status = 'active'))
    OR (scope = 'user' AND owner_user_id = auth.uid())
  );
CREATE POLICY "collections_write" ON curated_collections
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM org_members WHERE org_id = curated_collections.org_id AND uid = auth.uid() AND status = 'active')
    AND (scope = 'org' OR owner_user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members WHERE org_id = curated_collections.org_id AND uid = auth.uid() AND status = 'active')
    AND (scope = 'org' OR owner_user_id = auth.uid())
  );

ALTER TABLE curated_collection_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "collection_items_all" ON curated_collection_items;
CREATE POLICY "collection_items_all" ON curated_collection_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM curated_collections cc
    JOIN org_members om ON om.org_id = cc.org_id AND om.uid = auth.uid() AND om.status = 'active'
    WHERE cc.id = curated_collection_items.collection_id
      AND (cc.scope = 'org' OR cc.owner_user_id = auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM curated_collections cc
    JOIN org_members om ON om.org_id = cc.org_id AND om.uid = auth.uid() AND om.status = 'active'
    WHERE cc.id = curated_collection_items.collection_id
      AND (cc.scope = 'org' OR cc.owner_user_id = auth.uid())
  ));

-- Document favorites: user-scoped
ALTER TABLE document_favorites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "favorites_own" ON document_favorites;
CREATE POLICY "favorites_own" ON document_favorites
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Library views: same pattern as collections
ALTER TABLE library_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "views_select" ON library_views;
DROP POLICY IF EXISTS "views_write" ON library_views;
CREATE POLICY "views_select" ON library_views
  FOR SELECT TO authenticated
  USING (
    (scope = 'org' AND EXISTS (SELECT 1 FROM org_members WHERE org_id = library_views.org_id AND uid = auth.uid() AND status = 'active'))
    OR (scope = 'user' AND owner_user_id = auth.uid())
  );
CREATE POLICY "views_write" ON library_views
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM org_members WHERE org_id = library_views.org_id AND uid = auth.uid() AND status = 'active')
    AND (scope = 'org' OR owner_user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members WHERE org_id = library_views.org_id AND uid = auth.uid() AND status = 'active')
    AND (scope = 'org' OR owner_user_id = auth.uid())
  );

-- ─── Notifications (Phase B of drafting workflow) ───────────────

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notif_prefs_own" ON notification_preferences;
CREATE POLICY "notif_prefs_own" ON notification_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- email_notifications is written by client (queueEmail) and read by
-- service-role (the cron). Client needs INSERT only; reads happen
-- via service role which bypasses RLS.
ALTER TABLE email_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_notif_insert" ON email_notifications;
CREATE POLICY "email_notif_insert" ON email_notifications
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = email_notifications.org_id AND uid = auth.uid() AND status = 'active'));

-- Org SLA defaults: read for any org member, write for org admins (app enforces)
ALTER TABLE sla_defaults ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sla_defaults_member_all" ON sla_defaults;
CREATE POLICY "sla_defaults_member_all" ON sla_defaults
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = sla_defaults.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = sla_defaults.org_id AND uid = auth.uid() AND status = 'active'));

-- ─── Data export (D3 + D4) ──────────────────────────────────────
-- These tables are managed exclusively via the service-role-key API
-- endpoints (lib/serverAuth.ts gates by role). Client never directly
-- touches them. RLS off is fine here, but we'll set policies anyway
-- for defense-in-depth.

ALTER TABLE export_destinations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "export_dest_member_select" ON export_destinations;
CREATE POLICY "export_dest_member_select" ON export_destinations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = export_destinations.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE export_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "export_runs_member_select" ON export_runs;
CREATE POLICY "export_runs_member_select" ON export_runs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = export_runs.org_id AND uid = auth.uid() AND status = 'active'));
