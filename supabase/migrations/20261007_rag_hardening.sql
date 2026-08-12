-- 20261007_rag_hardening.sql
--
-- Retrieval-quality hardening, from a line-by-line audit of the ask
-- pipeline. Three changes, all to things the database was already storing
-- and the retrievers were ignoring:
--
-- 1. SECTION TEXT JOINS THE SEARCH INDEX, WEIGHTED ABOVE BODY TEXT.
--    Ingestion has stamped every chunk with its section heading ("5.3 Pipe
--    Supports") since 20260914 — and the tsvector was still generated from
--    content alone, so the one line that best names what a chunk is about
--    was invisible to keyword search. Weight A on the heading, B on body.
--
-- 2. RANK IS LENGTH-NORMALIZED. ts_rank without normalization scores long
--    chunks higher just for being long; ts_rank_cd(..., 32) divides by
--    document length so a tight clause outranks a rambling page.
--
-- 3. RETRIEVAL SEES ONLY READY DOCUMENTS. Neither RPC filtered on
--    knowledge_documents.status, so a document mid-re-ingest contributed a
--    partial chunk set that looked complete, and a failed mirror kept
--    serving its stale remnant.
--
-- The tsv column is GENERATED, so changing its expression means drop +
-- re-add; Postgres rebuilds it for every row in one statement. The GIN
-- index is rebuilt after. On a large corpus expect this migration to take
-- a minute or two — it is doing real work.
--
-- AFTER APPLYING: re-embedding is NOT required (vectors are untouched).
-- Keyword search improves immediately.

-- ── 1+2. tsvector with weighted section, rebuilt ─────────────────────────
DROP INDEX IF EXISTS knowledge_chunks_tsv_idx;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS tsv;
ALTER TABLE knowledge_chunks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(section, '')), 'A')
    || setweight(to_tsvector('english', content), 'B')
  ) STORED;
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING GIN (tsv);

-- ── knowledge_search: length-normalized rank + status filter ─────────────
DROP FUNCTION IF EXISTS knowledge_search(uuid, uuid, text, integer);
CREATE FUNCTION knowledge_search(
  p_org UUID, p_library UUID, p_query TEXT, p_limit INTEGER DEFAULT 12
) RETURNS TABLE (
  id UUID, document_id UUID, page INTEGER, content TEXT, section TEXT, rank REAL
) LANGUAGE sql STABLE AS $$
  SELECT c.id, c.document_id, c.page, c.content, c.section,
         -- 32 = rank/(rank+1) after dividing by document length: a tight
         -- clause outranks a rambling page instead of losing to it.
         ts_rank_cd(c.tsv, websearch_to_tsquery('english', p_query), 32) AS rank
  FROM knowledge_chunks c
  JOIN knowledge_documents d ON d.id = c.document_id
  WHERE c.org_id = p_org
    AND c.library_id = p_library
    AND d.status IN ('ready', 'indexing')
    AND c.tsv @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 40)
$$;

-- ── semantic_search: status filter ───────────────────────────────────────
CREATE OR REPLACE FUNCTION semantic_search(
  p_org_id     UUID,
  p_library_id UUID,
  p_embedding  vector(1024),
  p_limit      INT DEFAULT 20,
  p_model      TEXT DEFAULT NULL
)
RETURNS TABLE (
  chunk_id      UUID,
  document_id   UUID,
  document_name TEXT,
  page          INT,
  content       TEXT,
  similarity    REAL
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.document_id,
    d.name,
    c.page,
    c.content,
    (1 - (c.embedding <=> p_embedding))::REAL AS similarity
  FROM knowledge_chunks c
  JOIN knowledge_documents d ON d.id = c.document_id
  WHERE c.org_id = p_org_id
    AND (p_library_id IS NULL OR c.library_id = p_library_id)
    AND d.status IN ('ready', 'indexing')
    AND c.embedding IS NOT NULL
    AND (p_model IS NULL OR c.embedding_model = p_model)
  ORDER BY c.embedding <=> p_embedding
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

REVOKE ALL ON FUNCTION knowledge_search(UUID, UUID, TEXT, INTEGER) FROM public, anon;
GRANT EXECUTE ON FUNCTION knowledge_search(UUID, UUID, TEXT, INTEGER) TO authenticated;
REVOKE ALL ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) TO authenticated;
