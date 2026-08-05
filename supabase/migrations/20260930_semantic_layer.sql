-- 20260930_semantic_layer.sql
--
-- MEANING, alongside words.
--
-- Retrieval here has always been Postgres full-text search, and FTS is
-- genuinely good at the thing this domain needs most: an engineer types
-- "PSV-2001" and gets the page with PSV-2001 on it, exactly, every time. No
-- embedding model beats a keyword index at that, and anyone who replaces one
-- with the other has made the product worse.
--
-- What FTS cannot do is answer "what holds the pump down" when the standard
-- says "anchor bolt design", or "do we have anything about pipe supports"
-- when the document says "hanger and support details". Those are questions
-- about MEANING, and they're the ones people actually ask out loud.
--
-- So: both. This adds the vector half. Fusion happens in the app
-- (lib/hybridRank.ts) using reciprocal rank fusion, because a ts_rank of 0.06
-- and a cosine similarity of 0.83 do not measure the same thing and any
-- arithmetic mixing them is superstition.
--
-- EMBEDDINGS ARE THEIR OWN KEY. Anthropic has no embeddings API, so an
-- earlier cut of this gated semantic search on the member's CHAT provider
-- being OpenAI — which locked out every Claude user for no reason. The chat
-- model and the embedding model are unrelated services; a member can hold a
-- Claude key for answers and a separate key for embeddings. Anthropic's own
-- recommendation for Claude users is Voyage AI, so that is the default here.
--
-- Idempotent. Apply after 20260929.

-- ── 1. The extension ──────────────────────────────────────────────────────
-- Supabase ships pgvector; this enables it in the public schema.
CREATE EXTENSION IF NOT EXISTS vector;

-- ── 2. Embeddings on chunks ───────────────────────────────────────────────
-- 1024 dimensions, chosen because BOTH supported providers emit exactly that
-- natively: it is the default for every Voyage text model, and OpenAI's
-- text-embedding-3 models accept a `dimensions` parameter. One column, either
-- provider, no per-provider table.
--
-- The dimension is baked into the column, so switching to a model that can't
-- emit 1024 means a new column and a re-embed — deliberately visible, rather
-- than a silent mismatch that returns confident nonsense.
--
-- Vectors from DIFFERENT providers are not comparable, which is why
-- embedding_model is recorded per row and the search function filters on it:
-- mixing a Voyage vector and an OpenAI vector in one index returns neighbours
-- that are meaningless rather than merely wrong.
ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Which model produced it. Without this, a re-embed can't tell what's stale,
-- and mixed-model vectors in one index return quietly wrong neighbours.
ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

COMMENT ON COLUMN knowledge_chunks.embedding IS
  '1024-dim vector from the model named in embedding_model. NULL = not '
  'embedded yet (or nobody has saved an embedding key). Retrieval degrades to '
  'keyword search alone, never to no results.';

-- HNSW over cosine distance. Chosen over IVFFlat because it needs no training
-- step and no rebuild as rows arrive — a knowledge library grows one document
-- at a time, and an index that silently degrades until someone remembers to
-- REINDEX is an index nobody maintains.
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

-- Finding what still needs embedding, cheaply, on every backfill pass.
CREATE INDEX IF NOT EXISTS knowledge_chunks_unembedded_idx
  ON knowledge_chunks (library_id) WHERE embedding IS NULL;

-- ── 3. Nearest-neighbour search ───────────────────────────────────────────
--
-- SECURITY INVOKER: the caller's RLS decides which chunks they can see, same
-- as every other read. A search function that runs as its owner is a search
-- function that leaks the whole workspace.
CREATE OR REPLACE FUNCTION semantic_search(
  p_org_id     UUID,
  p_library_id UUID,
  p_embedding  vector(1024),
  p_limit      INT DEFAULT 20,
  -- Compare only against vectors from the SAME model. A query embedded by one
  -- provider and a corpus embedded by another live in different spaces, and
  -- the nearest neighbour across that boundary is noise wearing a score.
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
    -- Cosine DISTANCE is 0 for identical; report similarity so bigger is
    -- better, matching every other score the app hands a human.
    (1 - (c.embedding <=> p_embedding))::REAL AS similarity
  FROM knowledge_chunks c
  JOIN knowledge_documents d ON d.id = c.document_id
  WHERE c.org_id = p_org_id
    AND (p_library_id IS NULL OR c.library_id = p_library_id)
    AND c.embedding IS NOT NULL
    AND (p_model IS NULL OR c.embedding_model = p_model)
  ORDER BY c.embedding <=> p_embedding
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

REVOKE ALL ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) TO authenticated;

-- ── 4. Coverage, so the UI can be honest ──────────────────────────────────
-- "Semantic search is on for 340 of 1,200 passages" is a true and useful
-- thing to show. "Semantic search enabled" over a half-embedded corpus is a
-- lie that produces mysteriously bad answers.
CREATE OR REPLACE FUNCTION semantic_coverage(p_org_id UUID, p_library_id UUID DEFAULT NULL)
RETURNS TABLE (total BIGINT, embedded BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COUNT(*)::BIGINT, COUNT(embedding)::BIGINT
  FROM knowledge_chunks
  WHERE org_id = p_org_id
    AND (p_library_id IS NULL OR library_id = p_library_id);
$$;

REVOKE ALL ON FUNCTION semantic_coverage(UUID, UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_coverage(UUID, UUID) TO authenticated;

-- ── 5. The embedding key — separate from the chat key ─────────────────────
--
-- A member's chat provider says nothing about who can embed for them. Claude
-- answers questions; Voyage (or OpenAI) turns passages into vectors. Storing
-- one field for both is what produced the "you need an OpenAI key" dead end
-- for every Claude user.
--
-- Same custody rules as api_key: service-role only, never readable by a
-- browser, only ever surfaced as the last four characters.
ALTER TABLE ai_connections
  ADD COLUMN IF NOT EXISTS embedding_provider TEXT
    CHECK (embedding_provider IS NULL OR embedding_provider IN ('voyage', 'openai'));
ALTER TABLE ai_connections
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;
ALTER TABLE ai_connections
  ADD COLUMN IF NOT EXISTS embedding_api_key TEXT;
ALTER TABLE ai_connections
  ADD COLUMN IF NOT EXISTS embedding_key_last4 TEXT;

COMMENT ON COLUMN ai_connections.embedding_api_key IS
  'BYO embeddings key, independent of api_key. NULL = this member has not '
  'enabled meaning-based search; keyword search still works for them.';
