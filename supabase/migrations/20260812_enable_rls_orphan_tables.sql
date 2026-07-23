-- 20260812_enable_rls_orphan_tables.sql
--
-- SECURITY BUGFIX — enables RLS on two tables that were created directly
-- against the database (outside this migration set) and therefore never
-- received the ENABLE ROW LEVEL SECURITY + org-scoped policy treatment
-- that every other public table has.
--
-- Supabase flagged both as CRITICAL "RLS Disabled in Public":
--   • public.asset_files
--   • public.document_review_events
--
-- Every table in the public schema is exposed through PostgREST, so a
-- table with RLS off is readable/writable by anyone holding the anon or
-- authenticated API key, with no per-tenant filtering — a cross-tenant
-- data exposure in a multi-tenant app.
--
-- Both tables carry an org_id, so they get the same org-member policy as
-- their siblings (asset_photos / document_assets, document_disposition_
-- events / document_review_signoffs). Pattern matches 20260605 and
-- 20260615 exactly so behavior stays uniform.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already on;
-- DROP POLICY IF EXISTS + CREATE POLICY is safe to re-run.

-- ─── asset_files ────────────────────────────────────────────────
-- org_id is NOT NULL with an FK to orgs — identical shape to
-- asset_photos, so it gets the identical "*_member_all" policy.
ALTER TABLE asset_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "asset_files_member_all" ON asset_files;
CREATE POLICY "asset_files_member_all" ON asset_files
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = asset_files.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = asset_files.org_id AND uid = auth.uid() AND status = 'active'));

-- ─── document_review_events ─────────────────────────────────────
-- Audit/event trail for document reviews — same family as
-- document_disposition_events. org_id here is nullable and has no FK
-- (unlike its siblings); the policy below is still correct, but any
-- pre-existing row with a NULL org_id becomes visible only to the
-- service role (which bypasses RLS). See the optional hardening block
-- at the end to bring org_id in line with the sibling tables.
ALTER TABLE document_review_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_review_events_member_all" ON document_review_events;
CREATE POLICY "document_review_events_member_all" ON document_review_events
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_events.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_events.org_id AND uid = auth.uid() AND status = 'active'));

-- ─── OPTIONAL hardening for document_review_events ──────────────
-- Uncomment ONLY after confirming there are no rows with a NULL org_id
-- (or backfilling them). This aligns the column with every sibling
-- event table (NOT NULL + FK to orgs) and guarantees no row can ever
-- escape the org-scoped policy above.
--
--   -- 1. Verify / backfill first:
--   --    SELECT count(*) FROM document_review_events WHERE org_id IS NULL;
--   --    (backfill via the parent document if any exist:)
--   --    UPDATE document_review_events e
--   --       SET org_id = d.org_id
--   --      FROM documents d
--   --     WHERE d.id = e.document_id AND e.org_id IS NULL;
--   --
--   -- 2. Then enforce:
--   -- ALTER TABLE document_review_events
--   --   ALTER COLUMN org_id SET NOT NULL,
--   --   ADD CONSTRAINT document_review_events_org_id_fkey
--   --     FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE;
