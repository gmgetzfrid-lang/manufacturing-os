-- ─────────────────────────────────────────────────────────────────────────────
-- 20261186_intel_roundG_keyless_text_only.sql
--
-- intelligence Round G (I-22) — a page a batch with no AI key commits from
-- its text layer, where a driver with a key would read it with AI vision, is
-- counted on the row (ING-13 done-when 2; ING-6's keyless first-index limb).
-- DEC-58 as ruled under DEC-90 A18: keyless completion is text-only WITH a
-- marker. A keyless org's page is never held for a key; the row, the
-- library page and the ask route's DRAWING FACTS say how many pages were
-- indexed without AI vision.
--
-- knowledge_documents.vision_keyless_pages INTEGER NOT NULL DEFAULT 0 —
-- written by the ingest engine (ingestKnowledgeDocBatch in
-- lib/knowledgeIngest.ts), under the ingest claim, in the batch's own
-- commit: every page a batch with NO vision context (a keyless controller's
-- tab, the nightly drain with no sponsored key) commits from its text layer
-- where a batch with a key would read it with AI vision (the page needs it —
-- pageNeedsVision — or the library reads every page). A page held for AI
-- vision (vision_failed_pages: a reason someone can fix, or a page the
-- document owes AI vision — 20261162) is not counted: it is listed there.
-- The count is per index generation: the one reset (RESET_ROW) and a
-- generation's first batch start it at 0, so a keyed regeneration ends at 0.
-- A batch with a key never adds to it.
--
-- Why NOT NULL DEFAULT 0 and not nullable: it is a running counter like
-- every other one on the row (vision_pages, empty_pages, ingest_failures),
-- and no reader says anything for 0. A document indexed before this file
-- reads 0 and says nothing — exactly what every surface says today; it never
-- claims a page was read by AI vision. A generation already under way at the
-- paste counts the pages it commits from then on: a floor, never more than
-- the engine saw. A nullable column would add a third state that no surface
-- would say differently from 0. A constant default is a catalogue-only
-- change on PostgreSQL 11+ (no table rewrite).
--
-- Apply AFTER 20261122_intel_roundG_ingest_integrity.sql: the engine keeps
-- the count only under the ingest claim that file adds (the probe below says
-- whether it is there). Independent of 20261162. Until this file is pasted
-- the code runs exactly as before: the engine writes the column only where
-- the row it claimed carries it, the reset strips it on an older database,
-- and every reader takes a missing column (42703 / PGRST204) as no count.
-- The app may be deployed before or after the paste.
--
-- NARROWS nothing and WIDENS nothing (no policy, grant, function or trigger
-- is touched); it adds one column and changes no row, so the inventory is
-- informational — aggregate counts only, captured before the transaction.
-- Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check text,
-- ok boolean, n text) — the editor shows only the last result. Idempotent;
-- safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE any change) ────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g86_before AS
SELECT 'knowledge documents with pages indexed (their count starts at 0: pages committed without an AI key before this file are not counted until the next index generation)' AS what,
       COUNT(*) AS n
  FROM knowledge_documents WHERE pages_indexed > 0
UNION ALL
SELECT 'of those, with no page read by AI vision (vision_pages = 0: indexed without an AI key, or nothing in them needed AI vision — told apart once re-indexed)', COUNT(*)
  FROM knowledge_documents WHERE pages_indexed > 0 AND vision_pages = 0;

BEGIN;

ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS vision_keyless_pages INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN knowledge_documents.vision_keyless_pages IS
  'Pages this index generation committed from their text layer only because no AI key was available, where a batch with a key would read them with AI vision (intelligence Round G I-22, ING-13 / DEC-58). Restarts at 0 with every index generation; a batch with a key never adds to it.';

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'knowledge_documents.vision_keyless_pages exists as integer, NOT NULL, default 0' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'knowledge_documents'
                  AND column_name = 'vision_keyless_pages' AND data_type = 'integer'
                  AND is_nullable = 'NO' AND column_default = '0') AS ok,
       NULL::text AS n
UNION ALL
SELECT '20261122 is applied (knowledge_documents.ingest_claimed_by exists) — the engine keeps the count only under the ingest claim',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'knowledge_documents'
                  AND column_name = 'ingest_claimed_by'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g86_before;
