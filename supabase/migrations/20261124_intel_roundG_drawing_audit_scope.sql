-- ─────────────────────────────────────────────────────────────────────────────
-- 20261124_intel_roundG_drawing_audit_scope.sql
--
-- intelligence Round G (I-07) — drawing intelligence. What
-- app/api/knowledge/drawing/route.ts needs from the database; the route says
-- plainly what is missing on a database that has not applied this.
--
--   1. AUDIT VERDICTS KEYED BY THE SET THEY JUDGE (DWG-6).
--      drawing_audit_logs was unique on (org_id, sheet_number, revision_code)
--      while every verdict is computed over ONE library: the same controlled
--      sheet mirrored into a plant-wide library and a unit library was judged
--      against two different sets, and whichever was recorded last silently
--      replaced the other. New column library_id; the key becomes
--      UNIQUE (org_id, library_id, sheet_number, revision_code)
--      NULLS NOT DISTINCT. Existing rows take the library of the knowledge
--      document recorded in audit_details.knowledgeDocumentId where that still
--      resolves; the rest (the orchestrator's log_audit_completion rows, rows
--      whose mirror is gone) stay ORG-WIDE — library_id NULL, still unique
--      among themselves on (org, sheet, revision). No foreign key: a verdict
--      is a record that outlives its library, and deleting a library must
--      neither delete the history nor collide it into the org-wide key.
--      Every writer upserts on the new key: the drawing route with its library
--      (onConflict org_id,library_id,sheet_number,revision_code), and the
--      orchestrator's log_audit_completion with library_id NULL — I-04 moves
--      that upsert onto this key. APPLY ORDER: after the merge that ships I-04's
--      log_audit_completion on the new key; until then that one tool's upsert
--      names a key that no longer exists and is refused (42P10) — it reports
--      the error, it does not write elsewhere.
--   2. THE CENSUS COUNTED BY THE DATABASE (DWG-11). drawing_entity_rollup()
--      returns, per sheet, kind and tag, the occurrences, first page and
--      pages — instead of shipping every occurrence to the route under
--      PostgREST's max-rows, which cut whole sheets out of a census the
--      panel calls exact. It reads exactly the four tag kinds
--      (TAG_ENTITY_KINDS — lib/knowledgeEntityKinds.ts; pinned by test).
--      knowledge_doc_text_stats() returns characters, chunks and letter case
--      per document for the per-sheet readout and the drawing-or-prose call
--      (DWG-7). Both: SECURITY INVOKER, search_path pinned, EXECUTE for
--      service_role only (the route's client) — nobody else can call them.
--
-- WIDENS nothing (no policy or grant is opened; the two functions are
-- service_role-only). NARROWS nothing. Writes only drawing_audit_logs
-- .library_id (a backfill). The DEC-30 inventories are captured into a TEMP
-- TABLE before the transaction: aggregate counts only. Single paste:
-- inventory → BEGIN/DDL/COMMIT → ONE SELECT (check text, ok boolean, n text)
-- — the editor shows only the last result. Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE any change) ────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g24_before AS
SELECT 'drawing_audit_logs rows (all orgs)' AS what, COUNT(*) AS n
  FROM drawing_audit_logs
UNION ALL
SELECT 'verdict rows for a controlled sheet mirrored into more than one library (the stored verdict is whichever library recorded last; each library keeps its own from now on)', COUNT(*)
  FROM drawing_audit_logs a
 WHERE a.document_id IS NOT NULL
   AND (SELECT COUNT(DISTINCT kd.library_id) FROM knowledge_documents kd
         WHERE kd.org_id = a.org_id AND kd.source_document_id = a.document_id) > 1
UNION ALL
SELECT 'verdict rows whose recorded knowledge document still resolves (take its library in 1)', COUNT(*)
  FROM drawing_audit_logs a
  JOIN knowledge_documents kd
    ON (a.audit_details->>'knowledgeDocumentId') ~ '^[0-9a-fA-F-]{36}$'
   AND kd.id = (a.audit_details->>'knowledgeDocumentId')::uuid
   AND kd.org_id = a.org_id
UNION ALL
SELECT 'verdict rows kept org-wide (no resolvable knowledge document: orchestrator completions, mirrors since removed)', COUNT(*)
  FROM drawing_audit_logs a
 WHERE NOT EXISTS (
   SELECT 1 FROM knowledge_documents kd
    WHERE (a.audit_details->>'knowledgeDocumentId') ~ '^[0-9a-fA-F-]{36}$'
      AND kd.id = (a.audit_details->>'knowledgeDocumentId')::uuid
      AND kd.org_id = a.org_id)
UNION ALL
SELECT 'knowledge_page_entities rows with pos_source = vision (cached AI position estimates — drawn as approximate; cleared by a rev-up, a rebuild, or a viewer''s reject)', COUNT(*)
  FROM knowledge_page_entities
 WHERE pos_source = 'vision'
UNION ALL
SELECT 'equipment rows whose evidence line reads as a pipe line number — a size glued to the tag by a dash, or a size, the tag and a line spec (DWG-2 phantoms; gone at each document''s next re-index)', COUNT(*)
  FROM knowledge_page_entities e
 WHERE e.kind = 'equipment' AND e.raw IS NOT NULL
   AND upper(e.raw) ~ ('[0-9]\s*("|''''|IN)(-\s*' || e.tag || '([^0-9]|$)|\s*' || e.tag || '-[A-Z0-9]{2,6}([^A-Z0-9]|$))');

BEGIN;

-- ── 1. the verdict's scope, and the key that carries it ─────────────────────
ALTER TABLE drawing_audit_logs ADD COLUMN IF NOT EXISTS library_id UUID;

UPDATE drawing_audit_logs a
   SET library_id = kd.library_id
  FROM knowledge_documents kd
 WHERE a.library_id IS NULL
   AND (a.audit_details->>'knowledgeDocumentId') ~ '^[0-9a-fA-F-]{36}$'
   AND kd.id = (a.audit_details->>'knowledgeDocumentId')::uuid
   AND kd.org_id = a.org_id;

DROP INDEX IF EXISTS drawing_audit_logs_sheet_rev_idx;
CREATE UNIQUE INDEX IF NOT EXISTS drawing_audit_logs_scope_sheet_rev_idx
  ON drawing_audit_logs (org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT;

COMMENT ON COLUMN drawing_audit_logs.library_id IS
  'DWG-6: the knowledge library whose set the verdict was computed over. NULL = org-wide (written before 20261124, or by the orchestrator). No FK: the record outlives its library.';

-- ── 2. the census, counted by the database ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.drawing_entity_rollup(p_document_ids uuid[])
RETURNS TABLE (document_id uuid, kind text, tag text, occurrences integer, first_page integer, pages integer[])
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.document_id, e.kind, e.tag,
         COUNT(*)::integer AS occurrences,
         MIN(e.page)::integer AS first_page,
         ARRAY_AGG(DISTINCT e.page ORDER BY e.page) AS pages
    FROM knowledge_page_entities e
   WHERE e.document_id = ANY (p_document_ids)
     AND e.kind IN ('equipment', 'ref', 'opc', 'self')
   GROUP BY e.document_id, e.kind, e.tag
   ORDER BY e.document_id, e.kind, e.tag
$$;
REVOKE ALL ON FUNCTION public.drawing_entity_rollup(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drawing_entity_rollup(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.knowledge_doc_text_stats(p_document_ids uuid[])
RETURNS TABLE (document_id uuid, chunks integer, chars bigint, lower_letters bigint, upper_letters bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.document_id,
         COUNT(*)::integer AS chunks,
         COALESCE(SUM(length(c.content)), 0)::bigint AS chars,
         COALESCE(SUM(length(regexp_replace(c.content, '[^a-z]', '', 'g'))), 0)::bigint AS lower_letters,
         COALESCE(SUM(length(regexp_replace(c.content, '[^A-Z]', '', 'g'))), 0)::bigint AS upper_letters
    FROM knowledge_chunks c
   WHERE c.document_id = ANY (p_document_ids)
   GROUP BY c.document_id
   ORDER BY c.document_id
$$;
REVOKE ALL ON FUNCTION public.knowledge_doc_text_stats(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_doc_text_stats(uuid[]) TO service_role;

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'drawing_audit_logs.library_id exists (uuid)' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'drawing_audit_logs'
                  AND column_name = 'library_id' AND data_type = 'uuid') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the verdict key is UNIQUE (org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'drawing_audit_logs'
                  AND indexname = 'drawing_audit_logs_scope_sheet_rev_idx'
                  AND indexdef LIKE 'CREATE UNIQUE INDEX%'
                  AND indexdef LIKE '%(org_id, library_id, sheet_number, revision_code) NULLS NOT DISTINCT%'),
       NULL
UNION ALL
SELECT 'the org-wide key (org_id, sheet_number, revision_code) is gone',
       NOT EXISTS (SELECT 1 FROM pg_indexes
                    WHERE schemaname = 'public' AND tablename = 'drawing_audit_logs'
                      AND indexname = 'drawing_audit_logs_sheet_rev_idx'),
       NULL
UNION ALL
SELECT 'every verdict whose recorded knowledge document resolves carries that document''s library',
       NOT EXISTS (SELECT 1 FROM drawing_audit_logs a JOIN knowledge_documents kd
                     ON (a.audit_details->>'knowledgeDocumentId') ~ '^[0-9a-fA-F-]{36}$'
                    AND kd.id = (a.audit_details->>'knowledgeDocumentId')::uuid
                    AND kd.org_id = a.org_id
                  WHERE a.library_id IS DISTINCT FROM kd.library_id),
       NULL
UNION ALL
SELECT 'drawing_entity_rollup(uuid[]): invoker, search_path pinned, reads the four tag kinds',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'drawing_entity_rollup'
                  AND pg_get_function_identity_arguments(p.oid) = 'p_document_ids uuid[]'
                  AND NOT p.prosecdef
                  AND 'search_path=public' = ANY (p.proconfig)
                  AND p.prosrc LIKE '%e.kind IN (''equipment'', ''ref'', ''opc'', ''self'')%'),
       NULL
UNION ALL
SELECT 'knowledge_doc_text_stats(uuid[]): invoker, search_path pinned',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'knowledge_doc_text_stats'
                  AND pg_get_function_identity_arguments(p.oid) = 'p_document_ids uuid[]'
                  AND NOT p.prosecdef
                  AND 'search_path=public' = ANY (p.proconfig)),
       NULL
UNION ALL
SELECT 'both functions: EXECUTE for service_role, and for no anon or authenticated caller',
       has_function_privilege('service_role', 'public.drawing_entity_rollup(uuid[])', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.knowledge_doc_text_stats(uuid[])', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.drawing_entity_rollup(uuid[])', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.knowledge_doc_text_stats(uuid[])', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.drawing_entity_rollup(uuid[])', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.knowledge_doc_text_stats(uuid[])', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'drawing_audit_logs keeps exactly its three policies (member SELECT, controller INSERT/UPDATE; no DELETE)',
       (SELECT COUNT(*) = 3 AND COUNT(*) FILTER (WHERE cmd = 'DELETE') = 0
          FROM pg_policies WHERE tablename = 'drawing_audit_logs'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g24_before;
