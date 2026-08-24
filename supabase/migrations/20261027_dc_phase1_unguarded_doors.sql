-- Document-control Phase 1 — close the unguarded database doors.
--
-- Two CRITICALs from the document-control audit whose fix is at the database:
--   · DRLS-2 — revup_rollback_orphan is a PUBLIC, unauthenticated,
--     SECURITY DEFINER RPC that DELETEs any document_versions row by id, past
--     the controller-only delete policy. It authorizes nothing.
--   · EGR-1 (durable rail) — a transmittal's `items` JSONB is browser-written
--     and can name a document version in ANY org; the portal signs its bytes.
--     The app route now org-scopes the read, but the row must not be
--     persistable naming out-of-org documents in the first place. This also
--     moves portal_token generation server-side (EGR-1 done-when 4) so the
--     token is not a client-minted secret the creator knows in advance.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

-- ── DRLS-2: authorize the rollback RPC, and take it off PUBLIC ──────────────
-- The only legitimate caller (lib/revisions.ts, the legacy rev-up path) passes
-- the version IT JUST INSERTED as the drafter, plus that version's previous
-- sibling. So the safe contract is: the caller may only roll back an orphan
-- THEY created, in an org they are an active member of, and p_prev — if given
-- — must be a sibling revision of the same document. Anything else raises.
-- search_path is pinned (this function is in the DB-6 pin set; CREATE OR
-- REPLACE would otherwise drop the pin).
CREATE OR REPLACE FUNCTION revup_rollback_orphan(p_version uuid, p_prev uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_record uuid;
  v_created_by uuid;
BEGIN
  SELECT org_id, record_id, created_by
    INTO v_org, v_record, v_created_by
  FROM document_versions WHERE id = p_version;

  -- Unknown id → nothing to roll back. Silent success keeps the caller's
  -- error-path catch (it fires only when the promotion already failed).
  IF v_org IS NULL THEN RETURN; END IF;

  -- The caller must have created this orphan.
  IF v_created_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'revup_rollback_orphan: not your version to roll back';
  END IF;

  -- …and be an active member of its org.
  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_org AND uid = auth.uid() AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'revup_rollback_orphan: not an active member of this org';
  END IF;

  -- p_prev, when supplied, must be a sibling revision of the same document —
  -- never an unrelated version in another document or org.
  IF p_prev IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_versions
    WHERE id = p_prev AND record_id = v_record AND org_id = v_org
  ) THEN
    RAISE EXCEPTION 'revup_rollback_orphan: p_prev is not a sibling of p_version';
  END IF;

  DELETE FROM document_versions WHERE id = p_version;
  IF p_prev IS NOT NULL THEN
    UPDATE document_versions SET superseded_at = NULL WHERE id = p_prev;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION revup_rollback_orphan(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION revup_rollback_orphan(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION revup_rollback_orphan(uuid, uuid) TO authenticated;

-- bump_share_access has the same shape (definer + default PUBLIC execute).
-- Its blast radius is only an access counter, but the same lockdown applies —
-- no reason for anon to reach it. (Left functionally unchanged; only the
-- grants and the search_path pin are corrected.)
DO $$
BEGIN
  IF to_regprocedure('bump_share_access(uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION bump_share_access(uuid) FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON FUNCTION bump_share_access(uuid) FROM anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION bump_share_access(uuid) TO authenticated';
  END IF;
END $$;

-- ── EGR-1 durable rail: a transmittal cannot name out-of-org documents, and
--    its portal token is minted server-side ──────────────────────────────────
CREATE OR REPLACE FUNCTION transmittals_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  it JSONB;
  v_doc uuid;
  v_ver uuid;
BEGIN
  -- Every item that names a document or a version must name one in THIS
  -- transmittal's org. `items` is browser-written JSONB, so this is the rail
  -- behind the portal's read-time org scope: a forged cross-org id can never
  -- be persisted, in draft or issued state.
  IF NEW.items IS NOT NULL AND jsonb_typeof(NEW.items) = 'array' THEN
    FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
      v_doc := NULLIF(it->>'documentId', '')::uuid;
      v_ver := NULLIF(it->>'versionId', '')::uuid;
      IF v_doc IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.id = v_doc AND d.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'transmittal item names a document outside this workspace';
      END IF;
      IF v_ver IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM document_versions v WHERE v.id = v_ver AND v.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'transmittal item names a version outside this workspace';
      END IF;
    END LOOP;
  END IF;

  -- Server-mint the portal token on the ISSUE TRANSITION, overriding whatever
  -- the client sent — so the creator cannot pre-choose (or pre-know via a
  -- predictable value) a token for a row they were not permitted to issue
  -- (EGR-1 done-when 4). Only on the transition: an already-issued transmittal
  -- keeps its live token so re-saves never invalidate the recipient's link.
  IF NEW.status = 'issued'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'issued') THEN
    NEW.portal_token := replace(gen_random_uuid()::text, '-', '')
                        || replace(gen_random_uuid()::text, '-', '');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transmittals_guard ON transmittals;
CREATE TRIGGER trg_transmittals_guard
BEFORE INSERT OR UPDATE ON transmittals
FOR EACH ROW EXECUTE FUNCTION transmittals_guard();

COMMIT;

-- Verification (read-only; expect true / true / true):
SELECT 'rollback RPC no longer PUBLIC' AS check,
       NOT has_function_privilege('public', 'revup_rollback_orphan(uuid,uuid)', 'EXECUTE') AS ok
UNION ALL
SELECT 'rollback RPC executable by authenticated',
       has_function_privilege('authenticated', 'revup_rollback_orphan(uuid,uuid)', 'EXECUTE')
UNION ALL
SELECT 'transmittal guard trigger installed',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_transmittals_guard' AND NOT tgisinternal);
