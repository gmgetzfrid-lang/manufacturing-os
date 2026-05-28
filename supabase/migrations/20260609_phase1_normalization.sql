-- 20260609_phase1_normalization.sql
--
-- Phase 1 completion — normalize document↔asset and project↔document
-- relationships into proper join tables. Until now, those relationships
-- were carried implicitly:
--
--   - document↔asset: documents.asset_tags JSONB held free-form tag
--     strings; the canonical assets row was found by ad-hoc tag lookup.
--     Useful for grids, useless for "which documents reference asset X".
--
--   - project↔document: there was no direct link at all. The only way
--     to find a project's documents was to LEFT JOIN through
--     checkout_sessions and dedupe. That's not normalization, that's
--     archaeology.
--
-- Design choices:
--
-- 1. Two new join tables. RLS by org-member-all. Both populated
--    automatically by triggers from the existing write surfaces:
--    - asset_tags JSONB changes on documents → resync document_assets
--    - new asset created → backfill document_assets for matching tags
--    - checkout_sessions row with project_id → upsert project_documents
--    No caller has to change. The JSONB and checkout writes remain
--    the source-of-truth write surface; the join tables are the
--    normalized read view.
--
-- 2. Strict ON DELETE CASCADE on the join rows — when a document or
--    asset or project is hard-deleted, the join rows go with it.
--    Documents are typically archived (not deleted), so this rarely
--    fires; when it does, the join rows are pure derivable state.
--
-- 3. tag_text preserved on document_assets so we can see *which* tag
--    string in the JSONB matched the canonical asset (`FE-201` vs
--    `FE 201` vs `fe201` — all normalize the same, but humans want
--    to see what was actually written).
--
-- 4. SQL-side tag normalization mirrors lib/assets.ts:normalizeTag:
--    lowercase + strip non-alphanumerics. Lives in a SECURITY DEFINER
--    function so triggers can call it from any row's RLS context.

-- ─── normalize_tag(text) — mirror of lib/assets.ts normalizeTag ──
CREATE OR REPLACE FUNCTION normalize_tag(t TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(regexp_replace(COALESCE(t,''), '[^a-zA-Z0-9]+', '', 'g'));
$$;

-- ─── document_assets join table ────────────────────────────────
CREATE TABLE IF NOT EXISTS document_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  asset_id      UUID NOT NULL REFERENCES assets(id)    ON DELETE CASCADE,
  tag_text      TEXT,           -- the human-typed tag that resolved to this asset
  source        TEXT NOT NULL DEFAULT 'jsonb_sync' CHECK (source IN ('jsonb_sync','manual')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (document_id, asset_id)
);
CREATE INDEX IF NOT EXISTS document_assets_doc_idx   ON document_assets(document_id);
CREATE INDEX IF NOT EXISTS document_assets_asset_idx ON document_assets(asset_id);
CREATE INDEX IF NOT EXISTS document_assets_org_idx   ON document_assets(org_id);

-- ─── project_documents join table ──────────────────────────────
CREATE TABLE IF NOT EXISTS project_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  source        TEXT NOT NULL DEFAULT 'checkout' CHECK (source IN ('checkout','manual')),
  UNIQUE (project_id, document_id)
);
CREATE INDEX IF NOT EXISTS project_documents_project_idx  ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS project_documents_document_idx ON project_documents(document_id);
CREATE INDEX IF NOT EXISTS project_documents_org_idx      ON project_documents(org_id);

-- ─── Trigger: documents.asset_tags ⇄ document_assets ────────────
-- On every documents INSERT/UPDATE-of-asset_tags-or-org_id, rebuild
-- the jsonb_sync rows for that document. We delete and re-insert
-- (rather than diff) because a sheet rarely has more than a handful
-- of tags; the simpler logic is worth the extra writes.
CREATE OR REPLACE FUNCTION documents_resync_assets()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tag_record RECORD;
BEGIN
  -- Wipe existing trigger-managed rows. Manual links (source='manual')
  -- are preserved.
  DELETE FROM document_assets
   WHERE document_id = NEW.id AND source = 'jsonb_sync';

  IF NEW.asset_tags IS NULL OR jsonb_array_length(NEW.asset_tags) = 0 THEN
    RETURN NEW;
  END IF;

  FOR tag_record IN
    SELECT DISTINCT elem->>'tag' AS tag_text
      FROM jsonb_array_elements(NEW.asset_tags) AS elem
     WHERE elem ? 'tag' AND COALESCE(elem->>'tag','') <> ''
  LOOP
    INSERT INTO document_assets (org_id, document_id, asset_id, tag_text, source)
    SELECT NEW.org_id, NEW.id, a.id, tag_record.tag_text, 'jsonb_sync'
      FROM assets a
     WHERE a.org_id = NEW.org_id
       AND a.tag_normalized = normalize_tag(tag_record.tag_text)
     LIMIT 1
    ON CONFLICT (document_id, asset_id) DO NOTHING;
  END LOOP;

  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS documents_resync_assets_trg ON documents;
CREATE TRIGGER documents_resync_assets_trg
  AFTER INSERT OR UPDATE OF asset_tags, org_id ON documents
  FOR EACH ROW
  EXECUTE FUNCTION documents_resync_assets();

-- ─── Trigger: assets INSERT → backfill document_assets ─────────
-- When a new canonical asset is created, link it to any existing
-- documents whose asset_tags JSONB already references it. Without
-- this, an asset that gets registered AFTER the drawings already
-- tag it would have empty back-references.
CREATE OR REPLACE FUNCTION assets_backfill_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO document_assets (org_id, document_id, asset_id, tag_text, source)
  SELECT NEW.org_id, d.id, NEW.id, elem->>'tag', 'jsonb_sync'
    FROM documents d
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.asset_tags, '[]'::jsonb)) AS elem
   WHERE d.org_id = NEW.org_id
     AND elem ? 'tag'
     AND normalize_tag(elem->>'tag') = NEW.tag_normalized
  ON CONFLICT (document_id, asset_id) DO NOTHING;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS assets_backfill_documents_trg ON assets;
CREATE TRIGGER assets_backfill_documents_trg
  AFTER INSERT ON assets
  FOR EACH ROW
  EXECUTE FUNCTION assets_backfill_documents();

-- ─── Trigger: checkout_sessions.project_id → project_documents ─
-- Any checkout that names a project_id contributes a row. last_seen_at
-- moves forward on every touch so "most-recently-active documents in
-- a project" is a cheap query.
CREATE OR REPLACE FUNCTION checkouts_resync_project_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NULL OR NEW.document_id IS NULL OR NEW.org_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO project_documents (org_id, project_id, document_id, first_seen_at, last_seen_at, source)
  VALUES (NEW.org_id, NEW.project_id, NEW.document_id, NOW(), NOW(), 'checkout')
  ON CONFLICT (project_id, document_id) DO UPDATE
    SET last_seen_at = NOW();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS checkouts_resync_project_documents_trg ON checkout_sessions;
CREATE TRIGGER checkouts_resync_project_documents_trg
  AFTER INSERT OR UPDATE OF project_id, document_id ON checkout_sessions
  FOR EACH ROW
  EXECUTE FUNCTION checkouts_resync_project_documents();

-- ─── Backfill existing data ────────────────────────────────────
-- Fire the resync trigger for every existing document by touching
-- asset_tags = asset_tags (idempotent, safe to re-run). Same for
-- checkouts. New assets backfill themselves via the assets trigger.
UPDATE documents
   SET asset_tags = asset_tags
 WHERE jsonb_typeof(asset_tags) = 'array'
   AND jsonb_array_length(asset_tags) > 0;

UPDATE checkout_sessions
   SET project_id = project_id
 WHERE project_id IS NOT NULL
   AND document_id IS NOT NULL;

-- ─── RLS ───────────────────────────────────────────────────────
ALTER TABLE document_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_assets_member_all" ON document_assets;
CREATE POLICY "document_assets_member_all" ON document_assets
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_assets.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_assets.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_documents_member_all" ON project_documents;
CREATE POLICY "project_documents_member_all" ON project_documents
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active'));
