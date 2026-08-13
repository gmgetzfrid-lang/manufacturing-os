-- 20261011_semantic_coverage_fast.sql
--
-- semantic_coverage was a bare COUNT(*) + COUNT(embedding) over
-- knowledge_chunks with no index that matches its WHERE clause. On a corpus
-- of any size — and especially DURING a rebuild, when three ingest workers
-- are hammering the same table and its GIN/HNSW indexes — that sequential
-- scan runs long enough to hit the API role's statement_timeout, and the
-- browser sees "rpc/semantic_coverage 500" every time the intelligence page
-- or the embed panel polls coverage.
--
-- Two additions make both counts index-only scans:
--   1. a btree on (org_id, library_id)             → the "total" count
--   2. the same, partial WHERE embedding IS NOT NULL → the "embedded" count
-- and the function is rewritten as two sub-counts so each can use its own
-- index instead of one scan checking embedding null-ness row by row.

CREATE INDEX IF NOT EXISTS knowledge_chunks_org_lib_idx
  ON knowledge_chunks (org_id, library_id);

CREATE INDEX IF NOT EXISTS knowledge_chunks_org_lib_embedded_idx
  ON knowledge_chunks (org_id, library_id)
  WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION semantic_coverage(p_org_id UUID, p_library_id UUID DEFAULT NULL)
RETURNS TABLE (total BIGINT, embedded BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (SELECT COUNT(*) FROM knowledge_chunks
      WHERE org_id = p_org_id
        AND (p_library_id IS NULL OR library_id = p_library_id))::BIGINT,
    (SELECT COUNT(*) FROM knowledge_chunks
      WHERE org_id = p_org_id
        AND (p_library_id IS NULL OR library_id = p_library_id)
        AND embedding IS NOT NULL)::BIGINT;
$$;

REVOKE ALL ON FUNCTION semantic_coverage(UUID, UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_coverage(UUID, UUID) TO authenticated;
