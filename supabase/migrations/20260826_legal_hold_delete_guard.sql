-- 20260826_legal_hold_delete_guard.sql
--
-- Hardening for legal holds (20260820): enforce the deletion freeze at the
-- DATABASE, not just in the app. The app's delete paths check legal_hold before
-- deleting, but a direct PostgREST call, a future code path that forgets the
-- check, or a race (hold placed between the check and the delete) could still
-- destroy a held record. These BEFORE DELETE triggers close every path at once
-- — spoliation prevention is exactly the invariant that must not depend on the
-- client behaving.
--
-- Applies to EVERYONE (including service-role scripts): release the hold first,
-- then delete. Note this also blocks cascading deletes that would remove a held
-- document (e.g. deleting its org) — intentionally.
--
-- Idempotent. Dated after 20260825.

CREATE OR REPLACE FUNCTION enforce_legal_hold_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF OLD.legal_hold THEN
    RAISE EXCEPTION
      'This record is under a legal hold and cannot be deleted. Release the hold first.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_legal_hold_delete ON documents;
CREATE TRIGGER trg_documents_legal_hold_delete
  BEFORE DELETE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_legal_hold_delete_guard();

-- Versions are the evidentiary content — deleting them out from under a held
-- document must be blocked too (the app deletes versions before the document).
CREATE OR REPLACE FUNCTION enforce_legal_hold_version_delete_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_hold boolean;
BEGIN
  SELECT legal_hold INTO v_hold FROM documents WHERE id = OLD.record_id;
  IF COALESCE(v_hold, false) THEN
    RAISE EXCEPTION
      'This revision belongs to a record under a legal hold and cannot be deleted.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_versions_legal_hold_delete ON document_versions;
CREATE TRIGGER trg_document_versions_legal_hold_delete
  BEFORE DELETE ON document_versions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_legal_hold_version_delete_guard();
