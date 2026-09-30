-- ─────────────────────────────────────────────────────────────────────────────
-- 20261122_intel_roundG_ingest_integrity.sql
--
-- intelligence Round G (I-06) — ingestion and rev-up integrity. The columns
-- and the one foreign key lib/knowledgeIngest.ts, lib/knowledgeSourceSync.ts
-- and app/api/knowledge/ingest/route.ts use; the code runs unchanged (the
-- legacy, unclaimed path) on a database that has not applied this yet.
--
--   1. THE INGEST CLAIM (ING-2 / ING-1). knowledge_documents.ingest_claimed_by
--      / ingest_claimed_at: every ingest batch, the rev-up refresh and the
--      drawing rebuild take the document with one conditional UPDATE first; a
--      claim older than five minutes is free again. Backfill: none — every
--      row starts unclaimed.
--   2. HONEST COUNTERS. empty_pages (pages with no extractable text, kept per
--      document — ING-11); vision_failed_pages (pages whose AI-vision read
--      failed, retried before the document may be 'ready' — ING-6),
--      vision_retry_after (when those pages are next tried: a back-off after
--      the provider refused a whole retry pass, so a failed retry never
--      errors the document) and vision_partial_accepted (a controller's
--      explicit "accept the partial index"). The shared reset zeroes all of
--      them with vision_pages (ING-12).
--   3. THE CHUNKER GENERATION (ING-4 / ING-7). knowledge_libraries.chunk_version
--      (1 = the current chunker, the default for every library; 2 = the
--      table-aware, page-bridging chunker, chosen per library by an explicit
--      re-index) and knowledge_documents.chunk_version (which chunker wrote a
--      document's chunks; NULL = before this column, i.e. 1). Nothing is
--      re-indexed by this file.
--   4. CHUNK PROVENANCE (GOV-9). knowledge_chunks.source ('text' = the PDF's
--      own text layer, 'vision' = an AI transcription of the page image) and
--      source_model (which model transcribed it). Existing chunks read 'text':
--      before this column nobody recorded otherwise (the inventory counts the
--      documents that had vision-read pages, whose chunks are the ambiguous
--      ones until their next re-index).
--   5. THE SYNC CURSOR (ILIFE-13). knowledge_sources.last_synced_at: the cron
--      reconciles libraries oldest-first instead of the same 25 forever.
--   6. THE MIRROR FOREIGN KEY (ILIFE-5 / IRLS-7). knowledge_documents
--      .source_document_id REFERENCES documents(id) ON DELETE CASCADE: deleting
--      a controlled document removes its AI shadow in the same statement —
--      mirror row, chunks and their embeddings, page entities, entity
--      mentions, cached line traces (each already cascades from
--      knowledge_documents). Mirrors that ALREADY name no document are
--      deleted first, in this paste (the decision's default; counted below).
--   7. REV-UP RESIDUE (ING-3). Page entities and chunks on pages past their
--      document's page count (left by a revision with fewer sheets) are
--      deleted; they describe sheets that no longer exist.
--
-- NARROWS nothing and WIDENS nothing (no policy or grant is touched). It
-- DELETES rows in 6 and 7 — derived rows only, never a controlled document —
-- so the pre-apply inventory (DEC-30) is captured into a TEMP TABLE before
-- the transaction: aggregate counts only. Single paste: inventory →
-- BEGIN/DDL/COMMIT → ONE SELECT (check text, ok boolean, n text) — the
-- editor shows only the last result. Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE any change) ────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g22_before AS
SELECT 'mirrors whose source_document_id names no document (deleted by 6, with everything derived from them)' AS what,
       COUNT(*) AS n
  FROM knowledge_documents kd
 WHERE kd.source_document_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = kd.source_document_id)
UNION ALL
SELECT 'documents whose mirror is stale (mirror source_version_id differs from the current version; the next sync refreshes them)', COUNT(DISTINCT d.id)
  FROM knowledge_documents kd JOIN documents d ON d.id = kd.source_document_id
 WHERE kd.source_version_id IS DISTINCT FROM d.current_version_id
UNION ALL
SELECT 'knowledge documents whose vision_pages exceeds page_count (inflated across rebuilds; left as is, zeroed by the next reset)', COUNT(*)
  FROM knowledge_documents WHERE page_count IS NOT NULL AND vision_pages > page_count
UNION ALL
SELECT 'knowledge documents with vision_pages > 0 (their chunks predate the source column and read ''text'')', COUNT(*)
  FROM knowledge_documents WHERE vision_pages > 0
UNION ALL
SELECT 'knowledge documents in ''indexing'' (the claim backfill population: all start unclaimed)', COUNT(*)
  FROM knowledge_documents WHERE status = 'indexing'
UNION ALL
SELECT 'page-entity rows past their document''s page count (deleted by 7)', COUNT(*)
  FROM knowledge_page_entities e JOIN knowledge_documents d ON d.id = e.document_id
 WHERE d.page_count IS NOT NULL AND e.page > d.page_count
UNION ALL
SELECT 'chunk rows past their document''s page count (deleted by 7)', COUNT(*)
  FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
 WHERE d.page_count IS NOT NULL AND c.page > d.page_count
UNION ALL
SELECT 'page-entity rows on mirrors reset by a rev-up and not yet re-read (status stale, 0 pages indexed; cleared as the re-read reaches them)', COUNT(*)
  FROM knowledge_page_entities e JOIN knowledge_documents d ON d.id = e.document_id
 WHERE d.status = 'stale' AND d.pages_indexed = 0
UNION ALL
SELECT 'knowledge sources (all start never-synced; the cron reaches them oldest-first)', COUNT(*)
  FROM knowledge_sources;

BEGIN;

-- ── 1. the ingest claim ─────────────────────────────────────────────────────
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS ingest_claimed_by TEXT;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS ingest_claimed_at TIMESTAMPTZ;

-- ── 2. honest counters ──────────────────────────────────────────────────────
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS empty_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vision_failed_pages INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vision_retry_after TIMESTAMPTZ;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vision_partial_accepted BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 3. the chunker generation ───────────────────────────────────────────────
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS chunk_version SMALLINT;
ALTER TABLE knowledge_libraries ADD COLUMN IF NOT EXISTS chunk_version SMALLINT NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_libraries_chunk_version_check') THEN
    ALTER TABLE knowledge_libraries ADD CONSTRAINT knowledge_libraries_chunk_version_check
      CHECK (chunk_version IN (1, 2));
  END IF;
END $$;

-- ── 4. chunk provenance ─────────────────────────────────────────────────────
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'text';
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS source_model TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_chunks_source_check') THEN
    -- Binds every new row at once. The VALIDATE below confirms the existing
    -- rows (all 'text', from the default) with one read-only scan, run under
    -- this transaction's lock on knowledge_chunks: on a very large corpus,
    -- paste at a quiet moment. On a re-run both are no-ops.
    ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_source_check
      CHECK (source IN ('text', 'vision')) NOT VALID;
  END IF;
END $$;
ALTER TABLE knowledge_chunks VALIDATE CONSTRAINT knowledge_chunks_source_check;

-- ── 5. the sync cursor ──────────────────────────────────────────────────────
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

-- ── 6. the mirror foreign key: dangling mirrors first, then the FK ──────────
DELETE FROM knowledge_documents kd
 WHERE kd.source_document_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = kd.source_document_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_documents_source_document_fk') THEN
    ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_source_document_fk
      FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ── 7. rev-up residue: nothing past a document's last page ──────────────────
DELETE FROM knowledge_page_entities e
 USING knowledge_documents d
 WHERE e.document_id = d.id AND d.page_count IS NOT NULL AND e.page > d.page_count;
DELETE FROM knowledge_chunks c
 USING knowledge_documents d
 WHERE c.document_id = d.id AND d.page_count IS NOT NULL AND c.page > d.page_count;

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'knowledge_documents carries the ingest claim (ingest_claimed_by, ingest_claimed_at)' AS check,
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'knowledge_documents'
           AND column_name IN ('ingest_claimed_by', 'ingest_claimed_at')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'knowledge_documents carries the counters (empty_pages, vision_failed_pages, vision_retry_after, vision_partial_accepted, chunk_version)',
       (SELECT COUNT(*) = 5 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'knowledge_documents'
           AND column_name IN ('empty_pages', 'vision_failed_pages', 'vision_retry_after', 'vision_partial_accepted', 'chunk_version')),
       NULL
UNION ALL
SELECT 'knowledge_libraries.chunk_version defaults to 1 and admits only 1 or 2',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'knowledge_libraries'
                  AND column_name = 'chunk_version' AND column_default = '1')
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'knowledge_libraries_chunk_version_check'
                      AND conrelid = 'public.knowledge_libraries'::regclass),
       NULL
UNION ALL
SELECT 'knowledge_chunks.source (text | vision, validated) and source_model exist',
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'knowledge_chunks'
           AND column_name IN ('source', 'source_model'))
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'knowledge_chunks_source_check' AND convalidated
                      AND pg_get_constraintdef(oid) LIKE '%text%' AND pg_get_constraintdef(oid) LIKE '%vision%'),
       NULL
UNION ALL
SELECT 'knowledge_sources.last_synced_at exists',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'knowledge_sources' AND column_name = 'last_synced_at'),
       NULL
UNION ALL
SELECT 'knowledge_documents.source_document_id REFERENCES documents(id) ON DELETE CASCADE',
       EXISTS (SELECT 1 FROM pg_constraint k
                WHERE k.conname = 'knowledge_documents_source_document_fk' AND k.contype = 'f'
                  AND k.conrelid = 'public.knowledge_documents'::regclass
                  AND k.confrelid = 'public.documents'::regclass
                  AND k.confdeltype = 'c'),
       NULL
UNION ALL
SELECT 'every table derived from a knowledge document cascades from it (chunks, page entities, mentions, line traces where present)',
       (SELECT COUNT(DISTINCT c.relname) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
         WHERE k.contype = 'f' AND k.confdeltype = 'c'
           AND k.confrelid = 'public.knowledge_documents'::regclass
           AND c.relname IN ('knowledge_chunks', 'knowledge_page_entities', 'entity_mentions', 'knowledge_line_traces'))
       = 3 + (CASE WHEN to_regclass('public.knowledge_line_traces') IS NULL THEN 0 ELSE 1 END),
       NULL
UNION ALL
SELECT 'no mirror names a missing document',
       NOT EXISTS (SELECT 1 FROM knowledge_documents kd
                    WHERE kd.source_document_id IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = kd.source_document_id)),
       NULL
UNION ALL
SELECT 'no page entity or chunk sits past its document''s page count',
       NOT EXISTS (SELECT 1 FROM knowledge_page_entities e JOIN knowledge_documents d ON d.id = e.document_id
                    WHERE d.page_count IS NOT NULL AND e.page > d.page_count)
       AND NOT EXISTS (SELECT 1 FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
                        WHERE d.page_count IS NOT NULL AND c.page > d.page_count),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g22_before;
