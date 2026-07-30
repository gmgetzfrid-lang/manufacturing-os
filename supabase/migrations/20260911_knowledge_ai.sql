-- 20260911_knowledge_ai.sql
--
-- AI KNOWLEDGE LIBRARIES — ask questions against shelves of PDFs
-- (engineering standards, practices, vendor manuals) and get cited answers.
--
--   1. ai_connections: bring-your-own AI provider keys. One org-default row
--      (user_id NULL, managed by controllers) plus optional per-user
--      overrides. The api_key column NEVER reaches a browser: RLS is enabled
--      with NO policies, so anon/authenticated get nothing — every read and
--      write goes through /api/ai/connection using the service role, which
--      returns only provider/model/last4.
--   2. knowledge_libraries / knowledge_documents: the shelves and the PDFs
--      on them. Documents track ingestion progress page-by-page so a
--      900-page standard can index in resumable batches.
--   3. knowledge_chunks: the searchable text — one row per ~paragraph, with
--      a generated tsvector + GIN index. Retrieval is Postgres full-text
--      (provider-neutral by design: no embeddings, so the answering model
--      is freely swappable and indexing costs nothing).
--   4. knowledge_questions: every Q&A kept — who asked, what was answered,
--      which passages were cited. The library's own audit trail.
--   5. knowledge_search(): ranked FTS over one library via websearch syntax.
--
-- Additive + idempotent. Apply after 20260910.

-- ── 1. BYO provider connections (SECRETS — service-role only) ────────────
CREATE TABLE IF NOT EXISTS ai_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID,                            -- NULL = the org-wide default
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'gemini')),
  model TEXT NOT NULL,
  api_key TEXT NOT NULL,
  key_last4 TEXT,
  created_by UUID,
  created_by_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_connections_org_default_idx
  ON ai_connections (org_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_connections_user_idx
  ON ai_connections (org_id, user_id) WHERE user_id IS NOT NULL;

ALTER TABLE ai_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_connections FROM public, anon, authenticated;

-- ── 2. Libraries + documents ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_libraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_key TEXT NOT NULL,                  -- R2 object key
  file_size BIGINT,
  page_count INTEGER,                      -- known after the first ingest batch
  pages_indexed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'indexing', 'ready', 'error')),
  error TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_documents_library_idx
  ON knowledge_documents (library_id);

-- ── 3. Chunks: the full-text index ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_doc_idx ON knowledge_chunks (document_id);

-- ── 4. The question log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  user_id UUID,
  user_name TEXT,
  question TEXT NOT NULL,
  answer TEXT,
  citations JSONB,                         -- [{n, documentId, documentName, page}] or [{n, url, title}]
  provider TEXT,
  model TEXT,
  mode TEXT,                               -- 'library' (grounded) or 'internet'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_questions_library_idx
  ON knowledge_questions (library_id, created_at DESC);

-- ── RLS: members read + ask; controllers manage shelves ──────────────────
ALTER TABLE knowledge_libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_libraries_select ON knowledge_libraries;
CREATE POLICY knowledge_libraries_select ON knowledge_libraries FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_libraries.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS knowledge_libraries_write ON knowledge_libraries;
CREATE POLICY knowledge_libraries_write ON knowledge_libraries FOR ALL USING (
  is_org_controller(org_id)
) WITH CHECK (is_org_controller(org_id));

DROP POLICY IF EXISTS knowledge_documents_select ON knowledge_documents;
CREATE POLICY knowledge_documents_select ON knowledge_documents FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_documents.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS knowledge_documents_write ON knowledge_documents;
CREATE POLICY knowledge_documents_write ON knowledge_documents FOR ALL USING (
  is_org_controller(org_id)
) WITH CHECK (is_org_controller(org_id));

-- Chunks are read via the search RPC and written via the service role during
-- ingest; direct member SELECT is allowed (it's the same content as the PDF).
DROP POLICY IF EXISTS knowledge_chunks_select ON knowledge_chunks;
CREATE POLICY knowledge_chunks_select ON knowledge_chunks FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_chunks.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS knowledge_chunks_write ON knowledge_chunks;
CREATE POLICY knowledge_chunks_write ON knowledge_chunks FOR ALL USING (
  is_org_controller(org_id)
) WITH CHECK (is_org_controller(org_id));

DROP POLICY IF EXISTS knowledge_questions_select ON knowledge_questions;
CREATE POLICY knowledge_questions_select ON knowledge_questions FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_questions.org_id
          AND uid = auth.uid() AND status = 'active')
);
-- Inserts happen server-side (service role) from /api/knowledge/ask.

-- ── 5. Ranked full-text search over one library ──────────────────────────
CREATE OR REPLACE FUNCTION knowledge_search(
  p_org UUID, p_library UUID, p_query TEXT, p_limit INTEGER DEFAULT 12
) RETURNS TABLE (
  id UUID, document_id UUID, page INTEGER, content TEXT, rank REAL
-- SECURITY INVOKER on purpose: RLS on knowledge_chunks scopes results to the
-- caller's orgs; the service role (ask route) bypasses RLS as usual.
) LANGUAGE sql STABLE AS $$
  SELECT c.id, c.document_id, c.page, c.content,
         ts_rank(c.tsv, websearch_to_tsquery('english', p_query)) AS rank
  FROM knowledge_chunks c
  WHERE c.org_id = p_org
    AND c.library_id = p_library
    AND c.tsv @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 40)
$$;
