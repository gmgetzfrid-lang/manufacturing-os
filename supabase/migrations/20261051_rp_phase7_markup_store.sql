-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 7 build 1 / Round C4: markup as a durable,
-- addressable artifact (GAP-7 / DEC-24; LIFE-3, drafting-flow LEAK-5).
--
--   Viewer markup lived in React state and one browser-local blob: a page
--   refresh destroyed the redline that justified a change. Per DEC-24 it now
--   lives SERVER-SIDE as the normalized per-page fabric JSON the viewer already
--   produces (scale 1.0, keyed by 1-based page number), one row per
--   (document, version, user) — last write wins per user per version, the
--   checkout session recorded as provenance. The baked PDF is a derivative.
--
--   Authority: a markup is as visible as its document — the SELECT policy's
--   subquery on `documents` runs under the caller's own RLS (node_visible), so
--   a member who cannot open the document cannot read its markups; writes are
--   the author's own; controllers may delete. Not a widening (new table).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS document_markups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  -- Provenance: the checkout session the markup was drawn under, when any.
  checkout_session_id UUID,
  -- Normalized fabric JSON per 1-based page, at scale 1.0 (lib/markupExport).
  page_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  page_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS document_markups_one_per_user_version
  ON document_markups (document_id, version_id, user_id);
CREATE INDEX IF NOT EXISTS document_markups_document_idx
  ON document_markups (document_id, updated_at DESC);
COMMENT ON TABLE document_markups IS
  'GAP-7 / DEC-24: viewer markup as a durable artifact — normalized per-page fabric JSON, one row per (document, version, user). The baked PDF is a derivative of this row, never the only copy.';

ALTER TABLE document_markups ENABLE ROW LEVEL SECURITY;

-- Read: as visible as the document (the documents subquery runs under the
-- caller's own RLS), and only for active members of the org.
DROP POLICY IF EXISTS document_markups_select ON document_markups;
CREATE POLICY document_markups_select ON document_markups FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = document_markups.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_markups.document_id
              AND d.org_id = document_markups.org_id)
);
-- Write: the author's own row, on a document they can see.
DROP POLICY IF EXISTS document_markups_insert ON document_markups;
CREATE POLICY document_markups_insert ON document_markups FOR INSERT WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = document_markups.org_id
              AND m.uid = auth.uid() AND m.status = 'active')
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_markups.document_id
              AND d.org_id = document_markups.org_id)
);
DROP POLICY IF EXISTS document_markups_update ON document_markups;
CREATE POLICY document_markups_update ON document_markups FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- Delete: the author, or a controller (by the collection).
DROP POLICY IF EXISTS document_markups_delete ON document_markups;
CREATE POLICY document_markups_delete ON document_markups FOR DELETE USING (
  user_id = auth.uid() OR is_org_controller(org_id)
);

COMMIT;

-- ── Verification (read-only) — expect true × 5 ──────────────────────────────
SELECT 'document_markups exists with the DEC-24 key columns' AS check,
       (SELECT COUNT(*) = 6 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_markups'
          AND column_name IN ('document_id','version_id','user_id','checkout_session_id','page_states','page_count')) AS ok
UNION ALL
SELECT 'one row per (document, version, user)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'document_markups' AND indexname = 'document_markups_one_per_user_version' AND indexdef LIKE '%UNIQUE%')
UNION ALL
SELECT 'row-level security enabled, four policies (SELECT / INSERT / UPDATE / DELETE)',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'document_markups'::regclass)
       AND (SELECT COUNT(*) = 4 AND COUNT(DISTINCT cmd) = 4 FROM pg_policies WHERE tablename = 'document_markups')
UNION ALL
SELECT 'reads are as visible as the document; writes are the author''s own',
       (SELECT qual LIKE '%FROM documents d%' FROM pg_policies WHERE tablename = 'document_markups' AND policyname = 'document_markups_select')
       AND (SELECT with_check LIKE '%user_id = auth.uid()%' FROM pg_policies WHERE tablename = 'document_markups' AND policyname = 'document_markups_insert')
       AND (SELECT qual LIKE '%user_id = auth.uid()%' AND with_check LIKE '%user_id = auth.uid()%' FROM pg_policies WHERE tablename = 'document_markups' AND policyname = 'document_markups_update')
UNION ALL
SELECT 'controllers or the author may delete',
       (SELECT qual LIKE '%is_org_controller(org_id)%' FROM pg_policies WHERE tablename = 'document_markups' AND policyname = 'document_markups_delete');
