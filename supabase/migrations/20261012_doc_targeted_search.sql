-- 20261012_doc_targeted_search.sql
--
-- knowledge_search_document: full-text search scoped to ONE document.
--
-- Why this exists: the ask pipeline's refine round names documents by
-- designation ("per EP 5-1-1") — but every retriever searched page CONTENT,
-- so a document whose pages don't repeat its own designation was unfindable
-- even though it sat in the library. Production symptom: the model answered
-- "EP 5-1-1 is not in the loaded passages at all" while the document was
-- right there in the Documents list. The ask route now matches designations
-- against knowledge_documents.name and pulls passages from the matched
-- document directly through this function.
--
-- Behavior: rank the document's chunks against the topic query; when the
-- query matches nothing inside the document (or is empty), fall back to the
-- document's FIRST pages in reading order — the scope/definitions sections
-- of a standard, which beat returning nothing.

CREATE OR REPLACE FUNCTION knowledge_search_document(
  p_org UUID, p_document UUID, p_query TEXT, p_limit INTEGER DEFAULT 5
) RETURNS TABLE (
  id UUID, document_id UUID, page INTEGER, content TEXT, section TEXT, rank REAL
) LANGUAGE sql STABLE AS $$
  WITH matched AS (
    SELECT c.id, c.document_id, c.page, c.content, c.section,
           ts_rank_cd(c.tsv, websearch_to_tsquery('english', p_query), 32) AS rank
    FROM knowledge_chunks c
    WHERE c.org_id = p_org
      AND c.document_id = p_document
      AND coalesce(p_query, '') <> ''
      AND c.tsv @@ websearch_to_tsquery('english', p_query)
    ORDER BY rank DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 12)
  ),
  front AS (
    SELECT c.id, c.document_id, c.page, c.content, c.section, 0::REAL AS rank
    FROM knowledge_chunks c
    WHERE c.org_id = p_org
      AND c.document_id = p_document
    ORDER BY c.page ASC, c.seq ASC
    LIMIT LEAST(GREATEST(p_limit, 1), 12)
  )
  SELECT * FROM matched
  UNION ALL
  SELECT * FROM front WHERE NOT EXISTS (SELECT 1 FROM matched);
$$;

REVOKE ALL ON FUNCTION knowledge_search_document(UUID, UUID, TEXT, INTEGER) FROM public, anon;
GRANT EXECUTE ON FUNCTION knowledge_search_document(UUID, UUID, TEXT, INTEGER) TO authenticated;
