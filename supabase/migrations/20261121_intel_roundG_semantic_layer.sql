-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-02) — the meaning index: a queue that is a claim,
-- coverage that counts what search can return, one model per library, and a
-- nearest-neighbour search that looks far enough.
--
-- What this file changes:
--   1. SEM-4 / SEM-7 — knowledge_chunks gains embed_attempts (NOT NULL
--      DEFAULT 0), embed_error, embed_claimed_until (a driver's lease) and
--      embed_retry_after (a passage the provider refused waits until then,
--      its lease given back — refused is not "being embedded"). The embed
--      queue stops
--      being a bare `embedding IS NULL` predicate that every driver reads at
--      once: embed_claim_batch() takes up to one batch FOR UPDATE SKIP LOCKED
--      and leases it (embed_claimed_until), so two drains, a drain and the
--      browser build, or ten page-load nudges take DISJOINT batches instead of
--      paying for the same passages. Rows come fewest-attempts first, then in
--      document / page order, a refused chunk is not offered again before
--      its embed_retry_after, and a chunk the provider refused
--      p_max_attempts times is skipped (it stays counted as `failed`, with its
--      error, until a controller retries or rebuilds) — one un-embeddable
--      passage no longer pins a library. The claim carries the model the
--      driver embeds with (p_model) and hands out NOTHING while the library
--      holds a vector under any other model (SEM-1), so a driver on another
--      connection cannot start a second vector space once a rebuild's first
--      vector has landed. Service role only: every driver is a server route.
--   2. SEM-5 — semantic_coverage (re-created from 20261014, lines added only)
--      counts the RETRIEVABLE population: chunks of documents whose status is
--      'ready' or 'indexing', the same predicate semantic_search applies. The
--      claim applies it too, so nobody pays to embed a passage search can
--      never return. The document filter reads document_id, which the
--      20261011 count indexes do not carry, so two covering indexes
--      ((org_id, library_id, document_id), and the same WHERE embedding IS
--      NOT NULL) keep both counts index-only — the property 20261011 / 20261014
--      added so the panel's poll does not time out during a rebuild. (The
--      20261011 pair is now redundant; it is left in place, not dropped here.)
--   3. SEM-1 / SEM-4 / SEM-13 — semantic_coverage_detail(org, library): the
--      build's own numbers in one read — retrievable total / embedded /
--      remaining / failed / leased (passages a driver holds right now) /
--      waiting (passages the provider refused, waiting to be offered again —
--      nobody is embedding them, so they are never reported as "busy"), the
--      character volume still to embed (the price estimate), and the vectors
--      per embedding model over the whole library (a library holding two
--      models says so).
--   4. SEM-9 (+ SEM-1) — semantic_search is re-created from 20261007 with
--      lines added only:
--        * SET hnsw.ef_search = 200 (the default 40 candidates are walked
--          BEFORE the org / library / status / model filters, so a small
--          library inside a large table got a handful of rows or none); and,
--          when the installed pgvector is 0.8 or later, SET
--          hnsw.iterative_scan = strict_order, which keeps scanning until the
--          filters are satisfied, in exact distance order. The choice is made
--          by the DO block below from pg_extension (a reserved-prefix setting
--          an older pgvector does not know would refuse the whole paste);
--        * a new result column `eligible` — how many vectors the org /
--          library / model filters admit (counted before the document-status
--          filter) — so a short result can be told from a thin corpus;
--        * a library holding vectors under any model other than p_model
--          returns NOTHING: one arbitrary stamp no longer decides, silently
--          and differently from day to day, which half of a mixed corpus a
--          question searches. The app refuses to create a mixed library (the
--          build checks the stamp) and the panel names a mixed one and offers
--          Rebuild. The return type changes, so the function is dropped and
--          re-created; grants are re-stated — to authenticated AND to
--          service_role, whose ask route is its production caller (a drop
--          takes the old grants with it, and default privileges differ by
--          the role that runs the paste).
--      Evaluated and NOT done: a per-model partial HNSW index (the planner
--      cannot match a partial predicate against p_model, a parameter of a
--      non-inlined function) and partitioning per org (out of scope — a
--      table rewrite for a recall gap the settings above address).
--   5. SEM-8 / SEM-11 — the build marker (knowledge_libraries.ai_features ->
--      'embedBuild': who pays, a standing "keep current" consent, the drain's
--      holds) shares its JSON column with the Library AI toggles. Until now
--      both sides rewrote the WHOLE column from a copy read moments earlier:
--      saving Library AI setup erased the marker (a standing consent with
--      it), and a drain run reverted a toggle saved while it worked.
--        * embed_build_marker_write(library, marker, patch, drop, expect…) —
--          sets, merges into or clears the embedBuild key ALONE, in one
--          statement, and only while the stored marker still names the member
--          (and instant) the writer read. Service role only.
--        * knowledge_library_save_ai_features(library, features) — replaces
--          every key EXCEPT embedBuild, in one statement, under the caller's
--          own RLS (controllers), and says whether a row was saved.
--
-- Nothing here widens anyone's access: new columns, service-role-only claim
-- and marker functions, a counts function and a toggles save under the
-- caller's RLS, and two re-created functions that return the same rows or
-- fewer (service_role's EXECUTE on them is re-stated, not new). Pre-apply inventory (DEC-30)
-- is captured into a TEMP TABLE before the transaction: aggregate counts
-- only. Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check text,
-- ok boolean, n text) — the editor shows only the last result. The last rows
-- run a recall check of the new search against an exact scan. Idempotent.
-- The new indexes are built inside the transaction (writes to knowledge_chunks
-- wait for them): paste while no library is indexing.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g21_before AS
SELECT 'knowledge_chunks rows' AS what, COUNT(*) AS n FROM knowledge_chunks
UNION ALL
SELECT 'knowledge_chunks carrying a vector', COUNT(*) FROM knowledge_chunks WHERE embedding IS NOT NULL
UNION ALL
SELECT 'libraries holding vectors under more than one embedding model (SEM-1: meaning search refuses them until rebuilt)', COUNT(*)
  FROM (SELECT library_id FROM knowledge_chunks WHERE embedding IS NOT NULL
         GROUP BY library_id HAVING COUNT(DISTINCT COALESCE(embedding_model, '')) > 1) x
UNION ALL
SELECT 'vectors whose model differs from the model saved on the connection of the member whose build marker the library carries', COUNT(*)
  FROM knowledge_chunks c
  JOIN knowledge_libraries l ON l.id = c.library_id
  JOIN ai_connections a ON a.org_id = l.org_id AND a.user_id::text = l.ai_features->'embedBuild'->>'userId'
 WHERE c.embedding IS NOT NULL AND a.embedding_model IS NOT NULL
   AND c.embedding_model IS DISTINCT FROM a.embedding_model
UNION ALL
-- The same, one row per library that has any (DEC-30: the rebuilds needed).
SELECT '  of those, in library ' || c.library_id::text, COUNT(*)
  FROM knowledge_chunks c
  JOIN knowledge_libraries l ON l.id = c.library_id
  JOIN ai_connections a ON a.org_id = l.org_id AND a.user_id::text = l.ai_features->'embedBuild'->>'userId'
 WHERE c.embedding IS NOT NULL AND a.embedding_model IS NOT NULL
   AND c.embedding_model IS DISTINCT FROM a.embedding_model
 GROUP BY c.library_id
UNION ALL
SELECT 'libraries carrying a background-build marker (ai_features.embedBuild)', COUNT(*)
  FROM knowledge_libraries WHERE ai_features ? 'embedBuild'
UNION ALL
SELECT 'build markers older than 7 days (SEM-11: now backed off or released instead of holding a drain slot)', COUNT(*)
  FROM knowledge_libraries
 WHERE ai_features ? 'embedBuild'
   AND COALESCE(ai_features->'embedBuild'->>'at', '') ~ '^\d{4}-\d{2}-\d{2}'
   AND left(ai_features->'embedBuild'->>'at', 10)::date < current_date - 7
UNION ALL
SELECT 'build markers naming no active member of the library''s org (the drain now releases them)', COUNT(*)
  FROM knowledge_libraries l
 WHERE l.ai_features ? 'embedBuild'
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = l.org_id AND m.status = 'active'
                      AND m.uid::text = l.ai_features->'embedBuild'->>'userId')
UNION ALL
SELECT 'chunks of documents not ready / indexing (SEM-5: out of coverage and the embed queue from now on)', COUNT(*)
  FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
 WHERE d.status NOT IN ('ready', 'indexing')
UNION ALL
SELECT 'vectors on chunks of documents not ready / indexing (paid for, never returned by search)', COUNT(*)
  FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
 WHERE d.status NOT IN ('ready', 'indexing') AND c.embedding IS NOT NULL;

BEGIN;

-- ── 1. SEM-4 / SEM-7: failure tracking and a lease on every claimed chunk ───
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_error TEXT;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_claimed_until TIMESTAMPTZ;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embed_retry_after TIMESTAMPTZ;

COMMENT ON COLUMN knowledge_chunks.embed_attempts IS
  'How many times the embeddings provider refused THIS passage (not the key, not the model — '
  'the passage). At the build''s limit the queue skips it and the panel lists it as failed.';
COMMENT ON COLUMN knowledge_chunks.embed_claimed_until IS
  'Lease: a driver claimed this passage (embed_claim_batch) and is embedding it until then. '
  'Other drivers skip it; an abandoned lease simply expires.';
COMMENT ON COLUMN knowledge_chunks.embed_retry_after IS
  'The provider refused this passage: no driver is offered it again before then (its lease is '
  'given back, so it is waiting, not being embedded). Attempts accrue across runs, never in a loop.';

-- Vectors per model per library, for coverage by model and the mixed-library
-- check inside semantic_search (both read it index-only).
CREATE INDEX IF NOT EXISTS knowledge_chunks_library_model_idx
  ON knowledge_chunks (library_id, embedding_model)
  WHERE embedding IS NOT NULL;

-- ── 2. SEM-5: coverage counts what search can return ────────────────────────
-- The document filter below reads document_id: carried by these two, both
-- counts stay index-only scans (20261011 / 20261014's reason for existing).
CREATE INDEX IF NOT EXISTS knowledge_chunks_org_lib_doc_idx
  ON knowledge_chunks (org_id, library_id, document_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_org_lib_doc_embedded_idx
  ON knowledge_chunks (org_id, library_id, document_id)
  WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION semantic_coverage(p_org_id UUID, p_library_id UUID DEFAULT NULL)
RETURNS TABLE (total BIGINT, embedded BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
SET statement_timeout = '25s'
AS $$
SELECT
(SELECT COUNT(*) FROM knowledge_chunks WHERE org_id = p_org_id
AND (p_library_id IS NULL OR library_id = p_library_id)
AND document_id IN (SELECT d.id FROM knowledge_documents d WHERE d.org_id = p_org_id AND d.status IN ('ready', 'indexing')))::BIGINT,
(SELECT COUNT(*) FROM knowledge_chunks WHERE org_id = p_org_id
AND (p_library_id IS NULL OR library_id = p_library_id)
AND document_id IN (SELECT d.id FROM knowledge_documents d WHERE d.org_id = p_org_id AND d.status IN ('ready', 'indexing'))
AND embedding IS NOT NULL)::BIGINT;
$$;

REVOKE ALL ON FUNCTION semantic_coverage(UUID, UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_coverage(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION semantic_coverage(UUID, UUID) TO service_role;

-- ── 3. SEM-1 / SEM-4 / SEM-13: the build's own numbers, in one read ─────────
-- An earlier draft of this file returned no `waiting` column; a changed
-- return type needs the old one dropped first.
DROP FUNCTION IF EXISTS semantic_coverage_detail(UUID, UUID, INTEGER);
CREATE OR REPLACE FUNCTION semantic_coverage_detail(p_org_id UUID, p_library_id UUID, p_max_attempts INTEGER DEFAULT 3)
RETURNS TABLE (
  total           BIGINT,   -- retrievable passages (document ready / indexing)
  embedded        BIGINT,   -- of those, carrying a vector
  remaining       BIGINT,   -- still to embed (attempts under the limit)
  failed          BIGINT,   -- refused by the provider p_max_attempts times
  leased          BIGINT,   -- claimed by a driver right now
  waiting         BIGINT,   -- refused, waiting to be offered again (nobody holds them)
  remaining_chars BIGINT,   -- text still to embed (the price estimate)
  total_chars     BIGINT,   -- text of the whole retrievable library (a rebuild)
  models          JSONB     -- vectors per embedding model, whole library
)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
SET statement_timeout = '25s'
AS $$
  WITH pop AS (
    SELECT c.embedding IS NOT NULL AS has_vec, c.embed_attempts, c.embed_claimed_until,
           c.embed_retry_after, octet_length(c.content) AS chars
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
     WHERE c.org_id = p_org_id AND c.library_id = p_library_id
       AND d.status IN ('ready', 'indexing')
  )
  SELECT
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE has_vec)::BIGINT,
    COUNT(*) FILTER (WHERE NOT has_vec AND embed_attempts < p_max_attempts)::BIGINT,
    COUNT(*) FILTER (WHERE NOT has_vec AND embed_attempts >= p_max_attempts)::BIGINT,
    COUNT(*) FILTER (WHERE NOT has_vec AND embed_attempts < p_max_attempts AND embed_claimed_until > now())::BIGINT,
    COUNT(*) FILTER (WHERE NOT has_vec AND embed_attempts < p_max_attempts AND embed_retry_after > now())::BIGINT,
    COALESCE(SUM(chars) FILTER (WHERE NOT has_vec AND embed_attempts < p_max_attempts), 0)::BIGINT,
    COALESCE(SUM(chars), 0)::BIGINT,
    COALESCE((SELECT jsonb_object_agg(m.model, m.n)
                FROM (SELECT COALESCE(k.embedding_model, '(unrecorded)') AS model, COUNT(*) AS n
                        FROM knowledge_chunks k
                       WHERE k.org_id = p_org_id AND k.library_id = p_library_id AND k.embedding IS NOT NULL
                       GROUP BY 1) m), '{}'::jsonb)
  FROM pop;
$$;

REVOKE ALL ON FUNCTION semantic_coverage_detail(UUID, UUID, INTEGER) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_coverage_detail(UUID, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION semantic_coverage_detail(UUID, UUID, INTEGER) TO service_role;

-- ── 4. SEM-4 / SEM-5 / SEM-7 (+ SEM-1): the queue is a claim ────────────────
-- An earlier draft of this file had no p_model; drop that signature so a
-- re-paste never leaves two overloads for PostgREST to choose between.
DROP FUNCTION IF EXISTS embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER);
CREATE OR REPLACE FUNCTION embed_claim_batch(
  p_org_id        UUID,
  p_library_id    UUID,
  p_limit         INTEGER,
  p_lease_seconds INTEGER DEFAULT 120,
  p_max_attempts  INTEGER DEFAULT 3,
  p_model         TEXT DEFAULT NULL
)
RETURNS TABLE (
  id             UUID,
  content        TEXT,
  section        TEXT,
  page           INTEGER,
  document_id    UUID,
  document_name  TEXT,
  embed_attempts INTEGER
)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = public
AS $$
  WITH picked AS (
    SELECT c.id
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
     WHERE c.org_id = p_org_id AND c.library_id = p_library_id
       AND c.embedding IS NULL
       AND d.status IN ('ready', 'indexing')
       AND c.embed_attempts < p_max_attempts
       AND (c.embed_claimed_until IS NULL OR c.embed_claimed_until < now())
       AND (c.embed_retry_after IS NULL OR c.embed_retry_after < now())
       AND (p_model IS NULL OR NOT EXISTS (
         SELECT 1 FROM knowledge_chunks o
          WHERE o.library_id = p_library_id AND o.embedding IS NOT NULL
            AND o.embedding_model IS DISTINCT FROM p_model))
     ORDER BY c.embed_attempts, c.document_id, c.page, c.seq, c.id
     LIMIT GREATEST(1, LEAST(p_limit, 96))
       FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE knowledge_chunks k
     SET embed_claimed_until = now() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 600)))
    FROM picked
   WHERE k.id = picked.id
  RETURNING k.id, k.content, k.section, k.page, k.document_id,
            (SELECT d.name FROM knowledge_documents d WHERE d.id = k.document_id),
            k.embed_attempts;
$$;

REVOKE ALL ON FUNCTION embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION embed_claim_batch(UUID, UUID, INTEGER, INTEGER, INTEGER, TEXT) TO service_role;

-- ── 5. SEM-9 (+ SEM-1): search that looks far enough, and refuses a mix ─────
DROP FUNCTION IF EXISTS semantic_search(UUID, UUID, vector, INT, TEXT);

DO $do$
DECLARE
  -- pgvector 0.8 added iterative index scans; an older version reserves the
  -- "hnsw." prefix without that setting, so naming it would refuse the paste.
  v_iterative boolean := COALESCE((
    SELECT (m[1]::int, m[2]::int) >= (0, 8)
      FROM (SELECT regexp_match(extversion, '^(\d+)\.(\d+)') AS m
              FROM pg_extension WHERE extname = 'vector') v), false);
BEGIN
  EXECUTE format($fn$
CREATE FUNCTION semantic_search(
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
  similarity    REAL,
  eligible      BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
SET hnsw.ef_search = 200%s
AS $body$
  SELECT
    c.id,
    c.document_id,
    d.name,
    c.page,
    c.content,
    (1 - (c.embedding <=> p_embedding))::REAL AS similarity,
    (SELECT COUNT(*) FROM knowledge_chunks e
      WHERE e.org_id = p_org_id
        AND (p_library_id IS NULL OR e.library_id = p_library_id)
        AND e.embedding IS NOT NULL
        AND (p_model IS NULL OR e.embedding_model = p_model))::BIGINT AS eligible
  FROM knowledge_chunks c
  JOIN knowledge_documents d ON d.id = c.document_id
  WHERE c.org_id = p_org_id
    AND (p_library_id IS NULL OR c.library_id = p_library_id)
    AND d.status IN ('ready', 'indexing')
    AND c.embedding IS NOT NULL
    AND (p_model IS NULL OR c.embedding_model = p_model)
    AND NOT (p_library_id IS NOT NULL AND p_model IS NOT NULL AND EXISTS (
      SELECT 1 FROM knowledge_chunks o
       WHERE o.library_id = p_library_id AND o.embedding IS NOT NULL
         AND o.embedding_model IS DISTINCT FROM p_model))
  ORDER BY c.embedding <=> p_embedding
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$body$
$fn$, CASE WHEN v_iterative THEN E'\nSET hnsw.iterative_scan = strict_order' ELSE '' END);
END
$do$;

REVOKE ALL ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION semantic_search(UUID, UUID, vector, INT, TEXT) TO service_role;

-- ── 6. SEM-8 / SEM-11: the build marker is written alone, never the blob ────
-- p_marker: the new marker (NULL clears it) or, with p_patch, the fields to
-- merge into the existing one (never creates one); p_drop: fields to remove
-- on a patch. p_expect_user / p_expect_at: apply only while the stored marker
-- still names that member / was recorded at that instant (NULL = no check).
-- Returns whether a row changed. Service role only (the embed route, the
-- drain).
CREATE OR REPLACE FUNCTION embed_build_marker_write(
  p_library_id  UUID,
  p_marker      JSONB,
  p_patch       BOOLEAN DEFAULT false,
  p_drop        TEXT[]  DEFAULT '{}',
  p_expect_user TEXT    DEFAULT NULL,
  p_expect_at   TEXT    DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = public
AS $$
  WITH u AS (
    UPDATE knowledge_libraries l
       SET ai_features = CASE
             WHEN p_patch THEN jsonb_set(l.ai_features, '{embedBuild}',
                                         ((l.ai_features -> 'embedBuild') - p_drop) || COALESCE(p_marker, '{}'::jsonb))
             WHEN p_marker IS NULL THEN COALESCE(l.ai_features, '{}'::jsonb) - 'embedBuild'
             ELSE COALESCE(l.ai_features, '{}'::jsonb) || jsonb_build_object('embedBuild', p_marker)
           END
     WHERE l.id = p_library_id
       AND (NOT p_patch OR jsonb_typeof(l.ai_features -> 'embedBuild') = 'object')
       AND (p_expect_user IS NULL OR l.ai_features -> 'embedBuild' ->> 'userId' = p_expect_user)
       AND (p_expect_at IS NULL OR l.ai_features -> 'embedBuild' ->> 'at' = p_expect_at)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

REVOKE ALL ON FUNCTION embed_build_marker_write(UUID, JSONB, BOOLEAN, TEXT[], TEXT, TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION embed_build_marker_write(UUID, JSONB, BOOLEAN, TEXT[], TEXT, TEXT) TO service_role;

-- Library AI setup: every toggle replaced as a set, the marker kept. Runs
-- under the caller's RLS (knowledge_libraries_write: controllers), so a
-- member who may not change the library changes nothing — and is told.
CREATE OR REPLACE FUNCTION knowledge_library_save_ai_features(p_library_id UUID, p_features JSONB)
RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = public
AS $$
  WITH u AS (
    UPDATE knowledge_libraries l
       SET ai_features = (COALESCE(p_features, '{}'::jsonb) - 'embedBuild')
                         || CASE WHEN l.ai_features ? 'embedBuild'
                                 THEN jsonb_build_object('embedBuild', l.ai_features -> 'embedBuild')
                                 ELSE '{}'::jsonb END
     WHERE l.id = p_library_id
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

REVOKE ALL ON FUNCTION knowledge_library_save_ai_features(UUID, JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION knowledge_library_save_ai_features(UUID, JSONB) TO authenticated;

COMMIT;

-- ── Verification (read-only) — every probe true; inventory rows carry n ─────
SELECT 'knowledge_chunks carries embed_attempts (NOT NULL DEFAULT 0), embed_error, embed_claimed_until and embed_retry_after' AS "check",
       (SELECT COUNT(*) = 4 FROM information_schema.columns
         WHERE table_name = 'knowledge_chunks'
           AND column_name IN ('embed_attempts', 'embed_error', 'embed_claimed_until', 'embed_retry_after'))
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'knowledge_chunks' AND column_name = 'embed_attempts'
                      AND is_nullable = 'NO' AND column_default = '0') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'knowledge_chunks_library_model_idx (vectors per model per library) and the two coverage indexes carrying document_id (both counts stay index-only) exist',
       to_regclass('public.knowledge_chunks_library_model_idx') IS NOT NULL
       AND to_regclass('public.knowledge_chunks_org_lib_doc_idx') IS NOT NULL
       AND to_regclass('public.knowledge_chunks_org_lib_doc_embedded_idx') IS NOT NULL,
       NULL
UNION ALL
SELECT 'semantic_coverage counts only documents that are ready or indexing, keeps its 25s headroom and pinned search_path',
       (SELECT prosrc LIKE '%d.status IN (''ready'', ''indexing'')%'
               AND array_to_string(proconfig, ',') LIKE '%statement_timeout=25s%'
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND NOT prosecdef
          FROM pg_proc WHERE proname = 'semantic_coverage'),
       NULL
UNION ALL
SELECT 'semantic_coverage_detail: invoker, search_path pinned, reports failed / leased / waiting (refused, nobody holds them) / per-model vectors; service_role may run it and semantic_coverage',
       (SELECT NOT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%embed_attempts >= p_max_attempts%'
               AND prosrc LIKE '%embed_attempts < p_max_attempts AND embed_claimed_until > now()%'
               AND prosrc LIKE '%embed_attempts < p_max_attempts AND embed_retry_after > now()%'
               AND pg_get_function_result(oid) LIKE '%waiting bigint%'
               AND prosrc LIKE '%jsonb_object_agg(m.model, m.n)%'
          FROM pg_proc WHERE proname = 'semantic_coverage_detail')
       AND has_function_privilege('service_role', 'semantic_coverage_detail(uuid, uuid, integer)', 'EXECUTE')
       AND has_function_privilege('service_role', 'semantic_coverage(uuid, uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'embed_claim_batch: one definition — FOR UPDATE SKIP LOCKED + lease, retrievable documents only, a refused passage not before its retry time, failed passages skipped, fewest attempts first, nothing while another model is in the library',
       (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'embed_claim_batch')
       AND (SELECT prosrc LIKE '%FOR UPDATE OF c SKIP LOCKED%'
               AND prosrc LIKE '%SET embed_claimed_until = now() + make_interval%'
               AND prosrc LIKE '%d.status IN (''ready'', ''indexing'')%'
               AND prosrc LIKE '%c.embed_attempts < p_max_attempts%'
               AND prosrc LIKE '%c.embed_retry_after IS NULL OR c.embed_retry_after < now()%'
               AND prosrc LIKE '%o.embedding_model IS DISTINCT FROM p_model%'
               AND prosrc LIKE '%ORDER BY c.embed_attempts, c.document_id, c.page, c.seq, c.id%'
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'embed_claim_batch'),
       NULL
UNION ALL
SELECT 'embed_claim_batch is service-role only (no browser can claim or lease passages)',
       NOT has_function_privilege('authenticated', 'embed_claim_batch(uuid, uuid, integer, integer, integer, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'embed_claim_batch(uuid, uuid, integer, integer, integer, text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'embed_claim_batch(uuid, uuid, integer, integer, integer, text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'semantic_search: ef_search 200, reports eligible, refuses a library holding another model, invoker; authenticated and service_role (the ask route) may run it, anon may not',
       (SELECT array_to_string(proconfig, ',') LIKE '%hnsw.ef_search=200%'
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND NOT prosecdef
               AND pg_get_function_result(oid) LIKE '%eligible bigint%'
               AND prosrc LIKE '%o.embedding_model IS DISTINCT FROM p_model%'
               AND prosrc LIKE '%d.status IN (''ready'', ''indexing'')%'
          FROM pg_proc WHERE proname = 'semantic_search')
       AND has_function_privilege('authenticated', 'semantic_search(uuid, uuid, vector, integer, text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'semantic_search(uuid, uuid, vector, integer, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'semantic_search(uuid, uuid, vector, integer, text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'embed_build_marker_write: writes the embedBuild key alone, conditional on the marker read; invoker, search_path pinned, service role only',
       (SELECT NOT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%jsonb_set(l.ai_features, ''{embedBuild}''%'
               AND prosrc LIKE '%- ''embedBuild''%'
               AND prosrc LIKE '%p_expect_user IS NULL OR%'
               AND prosrc LIKE '%p_expect_at IS NULL OR%'
          FROM pg_proc WHERE proname = 'embed_build_marker_write')
       AND has_function_privilege('service_role', 'embed_build_marker_write(uuid, jsonb, boolean, text[], text, text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'embed_build_marker_write(uuid, jsonb, boolean, text[], text, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'embed_build_marker_write(uuid, jsonb, boolean, text[], text, text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'knowledge_library_save_ai_features: replaces the toggles and keeps embedBuild; invoker (the caller''s RLS decides), search_path pinned, authenticated only',
       (SELECT NOT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%(COALESCE(p_features, ''{}''%'
               AND prosrc LIKE '%- ''embedBuild'')%'
               AND prosrc LIKE '%jsonb_build_object(''embedBuild'', l.ai_features -> ''embedBuild'')%'
          FROM pg_proc WHERE proname = 'knowledge_library_save_ai_features')
       AND has_function_privilege('authenticated', 'knowledge_library_save_ai_features(uuid, jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'knowledge_library_save_ai_features(uuid, jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'inventory (after): pgvector version / iterative scan enabled on semantic_search',
       NULL,
       COALESCE((SELECT extversion FROM pg_extension WHERE extname = 'vector'), 'not installed') || ' / '
       || COALESCE((SELECT (array_to_string(proconfig, ',') LIKE '%hnsw.iterative_scan=strict_order%')::text
                      FROM pg_proc WHERE proname = 'semantic_search'), 'n/a')
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g21_before
UNION ALL
-- SEM-9 recall: the largest single-model library, one of its own vectors as
-- the query, top 12 from the new search against an exact scan of the same
-- filtered population (the "+ 0" keeps the planner off the index).
SELECT 'SEM-9 recall@12 of semantic_search against an exact scan (largest single-model library; n/a = no vectors yet)',
       NULL,
       COALESCE((
         WITH lib AS (
           SELECT c.org_id, c.library_id, min(c.embedding_model) AS model
             FROM knowledge_chunks c
            WHERE c.embedding IS NOT NULL
            GROUP BY c.org_id, c.library_id
           HAVING COUNT(DISTINCT COALESCE(c.embedding_model, '')) = 1
            ORDER BY COUNT(*) DESC
            LIMIT 1
         ), q AS (
           SELECT c.embedding AS v FROM knowledge_chunks c JOIN lib ON c.library_id = lib.library_id
            WHERE c.embedding IS NOT NULL ORDER BY c.id LIMIT 1
         ), ann AS (
           SELECT s.chunk_id FROM lib, q, semantic_search(lib.org_id, lib.library_id, q.v, 12, lib.model) s
         ), exact AS (
           SELECT c.id FROM knowledge_chunks c
             JOIN knowledge_documents d ON d.id = c.document_id
             JOIN lib ON c.library_id = lib.library_id
             CROSS JOIN q
            WHERE c.embedding IS NOT NULL AND c.embedding_model = lib.model
              AND d.status IN ('ready', 'indexing')
            ORDER BY (c.embedding <=> q.v) + 0, c.id
            LIMIT 12
         )
         SELECT CASE WHEN (SELECT COUNT(*) FROM exact) = 0 THEN NULL
                     ELSE round((SELECT COUNT(*) FROM ann WHERE chunk_id IN (SELECT id FROM exact))::numeric
                                / (SELECT COUNT(*) FROM exact), 2)::text END
       ), 'n/a');
