-- Pending database steps for the database-load fixes of Nov 25, 2026.
-- Run once, top to bottom, in the Supabase SQL editor. Safe to run more than once.
--
-- The app works BEFORE this is run: every function and column below is
-- called with a fallback to the old behaviour while it is missing
-- (PGRST202 / 42883 / 42703, "could not find the function").
-- No CREATE INDEX CONCURRENTLY: the SQL editor runs a script as one
-- transaction, where CONCURRENTLY is refused. knowledge_documents is small,
-- so the plain index build below takes well under a second.

-- ════════ 1. One worker per knowledge document ════════

-- What: a lease time on each knowledge document.
-- Why: two people's browsers (or a tab and the cron) indexed the same
-- document at once: double AI spend, a "duplicate key" error that marked the
-- file errored, and pages_indexed moving backwards. The worker holding a
-- lease until this time is the only one that reads the document.
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

-- What: take a document's lease for p_seconds, only if nobody holds it now;
-- true = taken. One UPDATE, so two callers can never both get it.
-- Why: used by /api/knowledge/ingest (each batch) and the server drain
-- (lib/knowledgeIngest.ts). Server-only: called with the service role.
CREATE OR REPLACE FUNCTION claim_knowledge_document(p_id UUID, p_seconds INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE knowledge_documents
     SET lease_until = now() + make_interval(secs => p_seconds)
   WHERE id = p_id
     AND (lease_until IS NULL OR lease_until < now());
  RETURN FOUND;
END;
$$;

-- What: only the server may call it.
-- Why: a signed-in browser must not be able to hold documents away from the indexer.
REVOKE ALL ON FUNCTION claim_knowledge_document(UUID, INT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_knowledge_document(UUID, INT) TO service_role;

-- ════════ 2. One meaning-index build per library ════════

-- What: a lease time on each knowledge library for its embedding build.
-- Why: a tab and the background drain (or two tabs) built the same library
-- at once, fetched the same passages, paid for them twice and wrote the same
-- rows; the old guard (ai_features.embedBuild.drainUntil) was read-then-write
-- and the tab's stamp wiped it.
ALTER TABLE knowledge_libraries ADD COLUMN IF NOT EXISTS embed_lease_until TIMESTAMPTZ;

-- What: take a library's build lease for p_seconds, only if nobody holds it;
-- true = taken. One UPDATE, so it is atomic.
-- Why: used by /api/knowledge/embed (the tab) and lib/knowledgeEmbedDrain.ts
-- (the background drain). Not taken = another build is running: the tab
-- waits and says so, the drain skips the library.
CREATE OR REPLACE FUNCTION claim_embed_build(p_library UUID, p_seconds INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE knowledge_libraries
     SET embed_lease_until = now() + make_interval(secs => p_seconds)
   WHERE id = p_library
     AND (embed_lease_until IS NULL OR embed_lease_until < now());
  RETURN FOUND;
END;
$$;

-- What: only the server may call it.
-- Why: same as above, for builds.
REVOKE ALL ON FUNCTION claim_embed_build(UUID, INT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_embed_build(UUID, INT) TO service_role;

-- ════════ 3. The indexing queue ════════

-- What: an index over the documents still waiting to be read, by workspace
-- and age. Partial, so it holds only the (few) queued rows.
-- Why: every open app tab of a controller asks "what is queued in my
-- workspace, oldest first" every 2 minutes (KnowledgeIndexIndicator), and the
-- server drains ask the same; with no index each read walked the table.
CREATE INDEX IF NOT EXISTS knowledge_documents_queue_idx
  ON knowledge_documents (org_id, created_at)
  WHERE status IN ('pending', 'stale', 'indexing');

-- ════════ 4. Home: documents per library in one read ════════

-- What: documents and checked-out documents per library for one workspace,
-- in one grouped read. SECURITY INVOKER: it counts only the rows the caller
-- can already see, exactly like the per-library counts it replaces.
-- Why: Home asked two counts per library (up to 12 libraries) plus 24 more
-- for the Document Control widget on every load: about 50 requests at once.
-- lib/dashboard/widgetLoads.ts uses this and falls back to those counts
-- while it is missing.
CREATE OR REPLACE FUNCTION library_document_counts(p_org_id UUID)
RETURNS TABLE (library_id UUID, docs BIGINT, checked_out BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT d.library_id,
         COUNT(*)::BIGINT,
         COUNT(*) FILTER (WHERE d.checked_out_by IS NOT NULL)::BIGINT
    FROM documents d
   WHERE d.org_id = p_org_id
   GROUP BY d.library_id;
$$;

-- What: signed-in members may call it (RLS still applies inside).
-- Why: Home calls it from the browser.
REVOKE ALL ON FUNCTION library_document_counts(UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION library_document_counts(UUID) TO authenticated;

-- ════════ 5. Let the API see the new functions and columns now ════════

-- What: reload the API's schema cache.
-- Why: without it the new functions answer "could not find the function"
-- (and the app keeps the old behaviour) until the cache refreshes by itself.
NOTIFY pgrst, 'reload schema';
