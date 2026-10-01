-- ─────────────────────────────────────────────────────────────────────────────
-- 20261149_dc_roundF_document_evidence_delete_guard.sql
--
-- document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS:
-- DRLS-14's document-delete half. DEC-44 (P14) — provisional number, the
-- integrator renumbers — AWAITING THE USER'S RATIFICATION.
--
--   DRLS-14  20261131 made acknowledgment and sign-off evidence survive a
--            REVISION delete (NO ACTION on the version references). A
--            DOCUMENT delete still cascaded all three evidence tables away
--            through document_id (distribution_acks, document_acknowledgments,
--            document_review_signoffs — each `REFERENCES documents(id) ON
--            DELETE CASCADE` since 20260817 / 20260818 / 20260825): one
--            delete of the document row, or of its library, erased the
--            record of who confirmed, acknowledged or approved the drawing.
--
--   WHAT (one new trigger; no function, policy or trigger of another
--   migration is re-created):
--     trg_documents_evidence_delete — BEFORE DELETE ON documents, FOR EACH
--     ROW → enforce_document_evidence_delete_guard(). A document that carries
--     EVIDENCE OF A PERSON'S ACT is not deleted, by anyone (the service role
--     included — the legal-hold delete guard's posture, 20260826):
--       · a distribution_acks row the recipient confirmed (acknowledged_at);
--       · a document_acknowledgments row acknowledged or waived (status,
--         acknowledged_at, or a bound signature_id) — a waiver is an
--         explicit, logged act of the owner / a controller;
--       · a document_review_signoffs row signed (status 'signed', signed_at,
--         or a bound signature_id — an invalidated row that WAS signed
--         included: it is the record that someone signed those bytes).
--     The refusal is one plain sentence naming the document and the three
--     counts, and says what to do instead (archive: it keeps the record),
--     SQLSTATE restrict_violation. Unanswered asks (pending rows) and void
--     rows are NOT evidence of anything a person did: they still cascade
--     with the document exactly as before, so deleting a mistaken upload
--     whose roster merely opened keeps working.
--   The three document_id references are NOT changed (CASCADE stays): the
--   guard decides before the cascade runs. Reversal = drop the trigger
--   (DEC-44 (P14) §Reversal); the FKs never moved.
--
--   Doors that meet the refusal (one is NOT truthful about it — the bulk
--   delete, a DEPLOY PREREQUISITE of this paste, below):
--     · the library page's single delete — one checked statement since
--       DRLS-17 (P12); it shows the database's sentence verbatim ("Delete
--       failed: …");
--     · a library delete (cascades its documents): /documents and
--       /admin/libraries show the sentence ("Delete failed: …" — the
--       latter since P14's final review, which also reads a zero-row
--       delete as a refusal);
--     · the library page's BULK delete (handleBulkDelete) awaits each
--       delete without reading its error and then drops EVERY selected row
--       from the screen — a refused row reads as deleted (a false success)
--       and reappears on reload, with nothing saying why. Fixing it is a
--       DEPLOY PREREQUISITE (HOW TO APPLY);
--     · the intake upload's discard (service role) deletes only a document
--       the same request created — it cannot carry a person's act yet.
--   /api/collections/delete and /api/collections/trash never delete a
--   document (a folder's contents step UP before its shell is soft-deleted;
--   the cron purges only shells; documents.collection_id is ON DELETE SET
--   NULL), so they cannot meet it.
--
-- NOT a widening: it refuses a delete that was allowed. DEC-30 inventory
-- (aggregate counts only, captured BEFORE the transaction): the documents
-- (and libraries) whose delete is refused from this paste on, the evidence
-- rows per table, and the documents that carry only unanswered asks (still
-- deletable).
-- HOW TO APPLY: independent of every pending document-control paste —
-- 20261131 (its version references are not touched; with it pasted, a
-- document carrying only unanswered asks still deletes, its rows going in
-- the same statement), 20261139, 20261143, 20261144 (none defines anything
-- this file touches). Paste ONLY once the user ratifies DEC-44 (P14).
-- DEPLOY PREREQUISITE (DRLS-14, as 20261131 waits on DRLS-15 / DRLS-17):
-- not pasteable until the app deployed carries a library-page bulk delete
-- (app/(protected)/documents/[libraryId]/page.tsx handleBulkDelete — the
-- page's owner, identity IS-P1 / intelligence I-12; coordinate) that CHECKS
-- each delete (.select("id") plus its error) and keeps every refused row on
-- screen with the database's sentence — or one that pre-checks the
-- selection's evidence counts and refuses before deleting anything.
-- (/admin/libraries, once only "Failed to delete library.", shows the
-- database's sentence since P14's final review.)
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_149_before;
CREATE TEMP TABLE dc_round_f_149_before AS
WITH acted AS (
  SELECT a.document_id FROM distribution_acks a
   WHERE a.acknowledged_at IS NOT NULL
  UNION
  SELECT k.document_id FROM document_acknowledgments k
   WHERE k.acknowledged_at IS NOT NULL OR k.signature_id IS NOT NULL
      OR k.status IN ('acknowledged', 'waived')
  UNION
  SELECT s.document_id FROM document_review_signoffs s
   WHERE s.signed_at IS NOT NULL OR s.signature_id IS NOT NULL
      OR s.status = 'signed'
), asked AS (
  SELECT document_id FROM distribution_acks
  UNION SELECT document_id FROM document_acknowledgments
  UNION SELECT document_id FROM document_review_signoffs
)
SELECT 'inventory (before apply): documents carrying acknowledgment or sign-off evidence — deleting any of them is refused from this paste on (archive instead)' AS inventory,
       COUNT(*)::text AS n
  FROM acted
UNION ALL
SELECT 'inventory (before apply): libraries holding at least one such document — deleting the library is refused while it does',
       COUNT(DISTINCT d.library_id)::text
  FROM documents d JOIN acted a ON a.document_id = d.id
UNION ALL
SELECT 'inventory (before apply): documents carrying only unanswered asks or void rows — still deletable; those rows cascade with the document, as before',
       COUNT(*)::text
  FROM asked x
 WHERE NOT EXISTS (SELECT 1 FROM acted a WHERE a.document_id = x.document_id)
UNION ALL
SELECT 'inventory (before apply): distribution_acks rows confirmed by their recipient (acknowledged_at set)',
       COUNT(*)::text
  FROM distribution_acks WHERE acknowledged_at IS NOT NULL
UNION ALL
SELECT 'inventory (before apply): document_acknowledgments rows acknowledged or waived',
       COUNT(*)::text
  FROM document_acknowledgments
 WHERE acknowledged_at IS NOT NULL OR signature_id IS NOT NULL OR status IN ('acknowledged', 'waived')
UNION ALL
SELECT 'inventory (before apply): document_review_signoffs rows signed (an invalidated row that was signed included)',
       COUNT(*)::text
  FROM document_review_signoffs
 WHERE signed_at IS NOT NULL OR signature_id IS NOT NULL OR status = 'signed';

BEGIN;

-- ── DRLS-14: a document carrying evidence of a person's act is not deleted ──
CREATE OR REPLACE FUNCTION enforce_document_evidence_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_dist  integer;
  v_ack   integer;
  v_sign  integer;
  v_label text;
BEGIN
  -- Read as the function's owner: a caller's row-level view of the evidence
  -- tables (an own-row policy) must not hide a row from this count.
  SELECT count(*) INTO v_dist
    FROM distribution_acks a
   WHERE a.document_id = OLD.id
     AND a.acknowledged_at IS NOT NULL;
  SELECT count(*) INTO v_ack
    FROM document_acknowledgments k
   WHERE k.document_id = OLD.id
     AND (k.acknowledged_at IS NOT NULL OR k.signature_id IS NOT NULL
          OR k.status IN ('acknowledged', 'waived'));
  SELECT count(*) INTO v_sign
    FROM document_review_signoffs s
   WHERE s.document_id = OLD.id
     AND (s.signed_at IS NOT NULL OR s.signature_id IS NOT NULL
          OR s.status = 'signed');
  IF v_dist + v_ack + v_sign > 0 THEN
    v_label := COALESCE(NULLIF(btrim(OLD.document_number), ''),
                        NULLIF(btrim(OLD.title), ''),
                        NULLIF(btrim(OLD.name), ''),
                        'This document');
    RAISE EXCEPTION
      '% carries the record of who confirmed, acknowledged or approved it (% distribution confirmation(s), % read-and-understood acknowledgment(s) or waiver(s), % review sign-off(s)), so it cannot be deleted. Archive it instead: archiving keeps the record.',
      v_label, v_dist, v_ack, v_sign
      USING ERRCODE = 'restrict_violation',
            HINT = 'Acknowledgment and sign-off evidence is kept, never deleted with its document (DRLS-14).';
  END IF;
  RETURN OLD;
END;
$$;
-- A trigger function is never called by a client (it RETURNS trigger); its
-- EXECUTE is checked when a trigger is created, not when it fires, so no
-- client role needs it (DRLS-16: grant only to the roles that call it).
REVOKE ALL ON FUNCTION enforce_document_evidence_delete_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_documents_evidence_delete ON documents;
CREATE TRIGGER trg_documents_evidence_delete
  BEFORE DELETE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_document_evidence_delete_guard();

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 5. Inventory rows: n = the aggregate count.
SELECT 'DRLS-14: a BEFORE DELETE trigger on documents refuses the delete of a document carrying evidence (trg_documents_evidence_delete)' AS check,
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'trg_documents_evidence_delete'
                  AND tgrelid = 'documents'::regclass AND NOT tgisinternal
                  AND pg_get_triggerdef(oid) LIKE '%BEFORE DELETE ON public.documents FOR EACH ROW EXECUTE FUNCTION enforce_document_evidence_delete_guard()%') AS ok,
       NULL::text AS n
UNION ALL SELECT 'DRLS-14: the guard counts a confirmed distribution ack, an acknowledged or waived read-and-understood row and a signed review sign-off, and refuses in plain words',
       (SELECT prosrc LIKE '%FROM distribution_acks a%'
               AND prosrc LIKE '%a.acknowledged_at IS NOT NULL%'
               AND prosrc LIKE '%FROM document_acknowledgments k%'
               AND prosrc LIKE '%k.status IN (''acknowledged'', ''waived'')%'
               AND prosrc LIKE '%FROM document_review_signoffs s%'
               AND prosrc LIKE '%s.status = ''signed''%'
               AND prosrc LIKE '%so it cannot be deleted. Archive it instead%'
               AND prosrc LIKE '%ERRCODE = ''restrict_violation''%'
          FROM pg_proc WHERE proname = 'enforce_document_evidence_delete_guard'), NULL
UNION ALL SELECT 'DRLS-14: the guard is SECURITY DEFINER with search_path pinned, and no client role may execute it',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'enforce_document_evidence_delete_guard')
       AND NOT has_function_privilege('public', 'enforce_document_evidence_delete_guard()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'enforce_document_evidence_delete_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_document_evidence_delete_guard()', 'EXECUTE'), NULL
UNION ALL SELECT 'DRLS-14: the three document_id references are unchanged (ON DELETE CASCADE) — unanswered asks still go with a deletable document',
       (SELECT COUNT(*) = 3 FROM pg_constraint c
         WHERE c.contype = 'f' AND c.confrelid = 'documents'::regclass AND c.confdeltype = 'c'
           AND c.conrelid IN ('distribution_acks'::regclass, 'document_acknowledgments'::regclass, 'document_review_signoffs'::regclass)
           AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                  WHERE a.attrelid = c.conrelid AND a.attname = 'document_id')]::smallint[]), NULL
UNION ALL SELECT 'DRLS-14: the legal-hold delete guard is still in place beside it (20260826)',
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'trg_documents_legal_hold_delete'
                  AND tgrelid = 'documents'::regclass AND NOT tgisinternal), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM dc_round_f_149_before;
