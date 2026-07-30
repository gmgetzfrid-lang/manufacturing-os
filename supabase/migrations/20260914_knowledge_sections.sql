-- 20260914_knowledge_sections.sql
--
-- Section-aware knowledge chunks: ingestion now detects section headings
-- ("5.3 Pipe Supports", "SECTION 7 — TESTING") while extracting pages and
-- stamps each chunk with the section in force — so answers can cite
-- §5.3 instead of just "page 47", and the AI sees the document's
-- structure instead of undifferentiated text.
--
-- knowledge_documents.last_section persists the heading across ingest
-- batches (sections span pages, and pages are processed 50 at a time).
--
-- Idempotent. Apply after 20260911. Re-index existing documents (remove +
-- re-add the PDF) to backfill sections; old chunks keep working without.

ALTER TABLE knowledge_chunks    ADD COLUMN IF NOT EXISTS section TEXT;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS last_section TEXT;

-- Return type changes (adds section), so drop-and-recreate.
DROP FUNCTION IF EXISTS knowledge_search(uuid, uuid, text, integer);
CREATE FUNCTION knowledge_search(
  p_org UUID, p_library UUID, p_query TEXT, p_limit INTEGER DEFAULT 12
) RETURNS TABLE (
  id UUID, document_id UUID, page INTEGER, content TEXT, section TEXT, rank REAL
) LANGUAGE sql STABLE AS $$
  SELECT c.id, c.document_id, c.page, c.content, c.section,
         ts_rank(c.tsv, websearch_to_tsquery('english', p_query)) AS rank
  FROM knowledge_chunks c
  WHERE c.org_id = p_org
    AND c.library_id = p_library
    AND c.tsv @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 40)
$$;
