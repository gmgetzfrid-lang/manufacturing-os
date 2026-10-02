-- ─────────────────────────────────────────────────────────────────────────────
-- 20261162_intel_roundG_ingest_owed_vision.sql
--
-- intelligence Round G (I-06b) — a regenerated document never loses, to a
-- keyless batch, the pages AI vision read in it (ING-13).
--
-- knowledge_documents.vision_owed_pages INTEGER[] NOT NULL DEFAULT '{}' —
-- written by the one reset of a document's derived index
-- (resetKnowledgeIndex in lib/knowledgeIngest.ts: the rev-up refresh, the
-- table-aware re-index and the drawing rebuild) with the pages the index it
-- resets owes AI vision: every page that index read with AI vision (its
-- chunks say so — knowledge_chunks.source = 'vision', 20261122), every page
-- still waiting on AI vision (vision_failed_pages) and the pages an earlier
-- reset owed that were not reached yet. A document whose chunks predate
-- their provenance — every chunk 20261122 found reads 'text', so every
-- document indexed before it — counts AI-vision pages (vision_pages > 0)
-- that no chunk names: its reset writes 0 (no page is page 0), which owes
-- AI vision every page that needs it. An ingest batch with NO vision
-- context (a keyless controller's tab, the nightly drain with no sponsored
-- key, a member at their cap) then HOLDS such a page wherever a batch with a
-- key would read it with AI vision now (the page needs it, or the library
-- reads every page) — listed on vision_failed_pages, the document 'indexing'
-- and searchable, never 'ready' — until a batch with a usable key reads it
-- or a controller accepts the partial index. Before this column the batch
-- committed the page with its text layer only (for a scan or an SHX
-- drawing, nothing), the document reached 'ready', and nothing read the page
-- again. A batch WITH a key never reads the column: it reads exactly the
-- pages it always did.
--
-- Apply AFTER 20261122_intel_roundG_ingest_integrity.sql (the reset reads
-- the owed pages only under the ingest claim, and holds them on
-- vision_failed_pages; the probe below says whether it is there). Until this
-- file is pasted the code runs exactly as before: the reset writes no owed
-- pages and a keyless batch consumes the page text-only. Documents reset
-- before the paste owe nothing (counted below): their last generation's
-- chunks are already gone.
--
-- NARROWS nothing and WIDENS nothing (no policy, grant, function or trigger
-- is touched); it adds one column and changes no row, so the inventory is
-- informational — aggregate counts only, captured before the transaction.
-- Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check text,
-- ok boolean, n text) — the editor shows only the last result. Idempotent;
-- safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE any change) ────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g62_before AS
SELECT 'knowledge documents holding AI-vision pages (vision_pages > 0; their next reset records them as owed — for one indexed before 20261122, every page that needs AI vision)' AS what,
       COUNT(*) AS n
  FROM knowledge_documents WHERE vision_pages > 0
UNION ALL
SELECT 'knowledge documents reset and not yet re-read (status stale, 0 pages indexed; reset before this file, they owe nothing)', COUNT(*)
  FROM knowledge_documents WHERE status = 'stale' AND pages_indexed = 0;

BEGIN;

ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vision_owed_pages INTEGER[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN knowledge_documents.vision_owed_pages IS
  'Pages the last index generation read with AI vision, recorded by the reset (intelligence Round G I-06b, ING-13); 0 = its chunks do not say which, so every page that needs AI vision. A batch with no vision context holds them for a key instead of indexing them text-only.';

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'knowledge_documents.vision_owed_pages exists as integer[], NOT NULL, default empty' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'knowledge_documents'
                  AND column_name = 'vision_owed_pages' AND data_type = 'ARRAY' AND udt_name = '_int4'
                  AND is_nullable = 'NO' AND column_default LIKE '%{}%') AS ok,
       NULL::text AS n
UNION ALL
SELECT '20261122 is applied (knowledge_documents.vision_failed_pages and knowledge_chunks.source exist) — the reset and the hold need it',
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND ((table_name = 'knowledge_documents' AND column_name = 'vision_failed_pages')
             OR (table_name = 'knowledge_chunks' AND column_name = 'source'))),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g62_before;
