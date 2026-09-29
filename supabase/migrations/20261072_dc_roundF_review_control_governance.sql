-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F (P4 REVIEW) — RG-5: the gate's own policy record
-- is governed at the database, on every level, with an audit row.
--
-- review_control rides on libraries, collections and documents. Two levels
-- were already guarded — libraries by trg_library_sensitive_columns
-- (20261036: controller / owner / manage-grant), collections by the
-- RESTRICTIVE controllers-only UPDATE policy (20261011) — but a DOCUMENT's
-- review_control was still member-writable: any active member could PATCH
-- {"mode":"none"} onto one controlled drawing and, because the most specific
-- DEFINED level wins, permanently exempt it from the library's gate, with no
-- audit row (the app's REVIEW_CONTROL_SET row is written only by the app).
--
--   1. trg_document_review_control_guard (BEFORE UPDATE ON documents): a
--      change to review_control takes a document controller or the
--      document's EFFECTIVE owner (user_is_effective_owner — the folder /
--      library / team cascade). Service-role writes (restores) pass.
--   2. trg_*_review_control_audit (AFTER UPDATE on all three tables): every
--      review_control change writes a REVIEW_CONTROL_CHANGED audit row from
--      the database — before / after / level / who — so a direct PATCH is
--      recorded exactly like a change made through the policy editor. The
--      app keeps writing its own REVIEW_CONTROL_SET / _CLEARED row (the
--      actor-attributed one); a change made in the UI therefore carries both.
--
-- NARROWING at the document level (members lose a write they should never
-- have had). DEC-30 inventory: how many document-level overrides exist and
-- how many of them switch an inherited gate OFF. Single paste: temp-table
-- inventory → BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean,
-- n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _dc_f72_before AS
SELECT 'documents carrying their own review_control (document-level overrides)' AS what, COUNT(*) AS n
  FROM documents WHERE jsonb_typeof(review_control) = 'object'
UNION ALL
SELECT 'of which mode none under a library or folder that requires review (an override switching the gate OFF)', COUNT(*)
  FROM documents d
 WHERE jsonb_typeof(d.review_control) = 'object' AND COALESCE(d.review_control->>'mode', 'none') = 'none'
   AND review_control_mode_for(NULL, d.collection_id, d.library_id) = 'require'
UNION ALL
SELECT 'collections carrying a review_control', COUNT(*)
  FROM collections WHERE jsonb_typeof(review_control) = 'object'
UNION ALL
SELECT 'libraries carrying a review_control', COUNT(*)
  FROM libraries WHERE jsonb_typeof(review_control) = 'object';

BEGIN;

-- ── 1. document-level review_control takes a controller or the effective owner
CREATE OR REPLACE FUNCTION enforce_document_review_control_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service-role / restore writes carry no JWT and are trusted.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF NEW.review_control IS DISTINCT FROM OLD.review_control THEN
    IF NOT is_org_controller(OLD.org_id)
       AND NOT user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid()) THEN
      RAISE EXCEPTION 'Not permitted to change this document''s pre-publish review policy — only a document controller or the document''s effective owner can.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_review_control_guard ON documents;
CREATE TRIGGER trg_document_review_control_guard
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_document_review_control_change();

-- ── 2. every review_control change, on every level, leaves an audit row ─────
CREATE OR REPLACE FUNCTION audit_review_control_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text;
  v_role  text;
BEGIN
  IF NEW.review_control IS DISTINCT FROM OLD.review_control THEN
    -- The writer's ROLE COLLECTION (DEC-2 / ADD-1), never the headline alone.
    SELECT email, array_to_string(COALESCE(roles, ARRAY[role]), ',') INTO v_email, v_role FROM org_members
     WHERE org_id = NEW.org_id AND uid = auth.uid() AND status = 'active' LIMIT 1;
    -- Written in the same transaction as the change: if the write fails, so
    -- does the row. auth.uid() is NULL for a service-role write and the row
    -- says so.
    INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
    VALUES ('REVIEW_CONTROL_CHANGED',
            CASE TG_TABLE_NAME WHEN 'libraries' THEN 'library' WHEN 'collections' THEN 'collection' ELSE 'document' END,
            NEW.id::text, NEW.org_id, auth.uid(), v_email, v_role,
            jsonb_build_object('via', CASE WHEN auth.uid() IS NULL THEN 'service_role' ELSE 'database' END,
                               'before', OLD.review_control, 'after', NEW.review_control));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_libraries_review_control_audit ON libraries;
CREATE TRIGGER trg_libraries_review_control_audit
AFTER UPDATE ON libraries
FOR EACH ROW EXECUTE FUNCTION audit_review_control_change();

DROP TRIGGER IF EXISTS trg_collections_review_control_audit ON collections;
CREATE TRIGGER trg_collections_review_control_audit
AFTER UPDATE ON collections
FOR EACH ROW EXECUTE FUNCTION audit_review_control_change();

DROP TRIGGER IF EXISTS trg_documents_review_control_audit ON documents;
CREATE TRIGGER trg_documents_review_control_audit
AFTER UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION audit_review_control_change();

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 5. Inventory rows: n = the aggregate count.
SELECT 'document review_control guard installed (BEFORE UPDATE)' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_review_control_guard' AND NOT tgisinternal) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the guard admits a controller or the effective owner only',
       (SELECT prosrc LIKE '%is_org_controller(OLD.org_id)%'
           AND prosrc LIKE '%user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid())%'
          FROM pg_proc WHERE proname = 'enforce_document_review_control_change'),
       NULL::text
UNION ALL
SELECT 'audit triggers installed on libraries, collections and documents',
       (SELECT COUNT(*) = 3 FROM pg_trigger
         WHERE tgname IN ('trg_libraries_review_control_audit', 'trg_collections_review_control_audit', 'trg_documents_review_control_audit')
           AND NOT tgisinternal),
       NULL::text
UNION ALL
SELECT 'the audit row carries before / after and the level',
       (SELECT prosrc LIKE '%''REVIEW_CONTROL_CHANGED''%'
           AND prosrc LIKE '%''before'', OLD.review_control, ''after'', NEW.review_control%'
           AND prosrc LIKE '%CASE TG_TABLE_NAME WHEN ''libraries'' THEN ''library''%'
          FROM pg_proc WHERE proname = 'audit_review_control_change'),
       NULL::text
UNION ALL
SELECT 'both functions are SECURITY DEFINER with search_path pinned; the 20261036 library guard and the 20261011 collections policy survive',
       (SELECT bool_and(prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%')
          FROM pg_proc WHERE proname IN ('enforce_document_review_control_change', 'audit_review_control_change'))
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_library_sensitive_columns' AND NOT tgisinternal)
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'collections' AND policyname = 'collections_update_controllers'),
       NULL::text
UNION ALL
SELECT 'inventory (before apply): ' || what, NULL::boolean, n::text FROM _dc_f72_before;
