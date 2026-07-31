-- 20260917_knowledge_sources.sql
--
-- KNOWLEDGE SOURCES — knowledge libraries stop owning file uploads and
-- become named ask-surfaces over DOCUMENT CONTROL content:
--
--   1. knowledge_sources: which doc-control containers (whole libraries or
--      folders) feed a knowledge library. A source is a LIVE subscription —
--      the sync (API + maintenance cron) adds newly filed documents,
--      re-indexes on rev-up, and drops archived/superseded ones.
--   2. knowledge_documents grows source columns: which source produced the
--      row, which controlled document + version it mirrors, and the rev
--      label answers cite. source_id CASCADE means removing a source
--      removes its mirrored docs (and their chunks, transitively).
--   3. status gains 'stale' — the sync marks a linked doc stale when its
--      controlled document publishes a new revision; the indexer re-ingests.
--   4. LOCKDOWN: chunks of SOURCE-LINKED documents are no longer readable
--      by org members directly. Controlled documents carry per-node ACLs;
--      the ask API is the only door to linked content and filters
--      retrieval per asker through the real ACL engine. Upload-origin
--      chunks keep the old org-member read (same content as the PDF the
--      member could already open).
--
-- Idempotent. Apply after 20260916.

-- ── 1. Sources: doc-control containers feeding a knowledge library ───────
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('library', 'folder')),
  source_id UUID NOT NULL,                 -- libraries.id or collections.id
  source_name TEXT NOT NULL,               -- denormalized display name/path
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (library_id, source_id)
);
CREATE INDEX IF NOT EXISTS knowledge_sources_library_idx
  ON knowledge_sources (library_id);

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
-- Members can SEE what feeds a library; writes go through the API (service
-- role) where the adder's ACL on the container is verified server-side.
DROP POLICY IF EXISTS knowledge_sources_select ON knowledge_sources;
CREATE POLICY knowledge_sources_select ON knowledge_sources FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_sources.org_id
          AND uid = auth.uid() AND status = 'active')
);

-- ── 2. Source columns on knowledge_documents ─────────────────────────────
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES knowledge_sources(id) ON DELETE CASCADE;
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS source_document_id UUID;
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS source_version_id UUID;
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS source_rev TEXT;
CREATE INDEX IF NOT EXISTS knowledge_documents_source_doc_idx
  ON knowledge_documents (source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_documents_source_idx
  ON knowledge_documents (source_id) WHERE source_id IS NOT NULL;

-- ── 3. status gains 'stale' (rev published; re-index queued) ─────────────
ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_status_check;
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_status_check
  CHECK (status IN ('pending', 'indexing', 'ready', 'stale', 'error'));

-- ── 4. Chunk lockdown for source-linked documents ────────────────────────
-- Upload-origin chunks stay member-readable (unchanged behavior). Linked
-- chunks mirror ACL-protected controlled documents, so direct reads are
-- closed; the ask API (service role) filters them per asker.
DROP POLICY IF EXISTS knowledge_chunks_select ON knowledge_chunks;
CREATE POLICY knowledge_chunks_select ON knowledge_chunks FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_chunks.org_id
          AND uid = auth.uid() AND status = 'active')
  AND NOT EXISTS (
    SELECT 1 FROM knowledge_documents d
    WHERE d.id = knowledge_chunks.document_id
      AND d.source_document_id IS NOT NULL
  )
);
