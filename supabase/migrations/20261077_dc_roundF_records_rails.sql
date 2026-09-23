-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F (P9 RECORDS) — the records-management rails:
-- HLD-1 (dispose gate, DB limb), RET-4 (recert attestation columns), RET-6
-- (revision storage key is write-once), DRLS-4 (the review-certification
-- trail is append-only and org-bound; the disposition trail is undeletable
-- by every non-service role), RET-13 (the catalog remembers a delete
-- shortfall).
--
--   1. enforce_document_retention_guard — body from 20261043 (the live
--      definition), extended: an OPEN operational hold (document_holds,
--      released_at IS NULL) refuses disposition and the archive verb for a
--      non-controller — the two UPDATE-shaped destructions HLD-1 names that
--      slip the publish guard's "advance" test. The early return is widened
--      so a plain status → 'Archived' reaches the check. Line-diff pinned in
--      lib/__tests__/dcRoundFMigration.test.ts. The app refuses for everyone
--      (lib/retention.ts disposeDocument); wave 2 unifies on lib/holdGate.ts.
--   2. enforce_library_sensitive_columns — body from 20261036 (the live
--      definition), extended: last_recertified_at / last_recertified_by /
--      next_recertification_date — the attestation record itself, which any
--      member could PATCH years out — change only for a controller or the
--      library owner (DEL-6 / DEC-20: owners recertify). recert_policy was
--      already guarded there. Line-diff pinned.
--   3. document_versions.file_url is write-once for every authenticated
--      caller (BEFORE UPDATE): the shed deletes what this column names, and
--      no app path ever repoints an existing row (the intake route runs as
--      the service role, which passes). A member could PATCH a decade-old
--      superseded row at the current revision's key.
--   4. document_review_events: org_id backfilled from the parent document
--      (the query 20260812 drafted), the FOR ALL member policy replaced by
--      SELECT (member) + INSERT (member, row bound to a document of that org)
--      + RESTRICTIVE no-UPDATE / no-DELETE (USING false — a later permissive
--      FOR ALL cannot re-open them, the DRLS-1 lesson); org_id NOT NULL + FK
--      to orgs when no NULL rows remain, otherwise a NOT VALID CHECK + FK so
--      every NEW row is bound while the unbackfillable residue is kept for
--      the record (never deleted). The inventory below says which world you
--      are in.
--   5. doc_disposition_events_no_delete tightened from controller-only to
--      USING (false): the trail of a hold's placement is what a spoliation
--      claim turns on, and the person under investigation may hold DocCtrl.
--      Service role (cron, admin routes) bypasses RLS as before.
--   6. archives.reclaim_shortfall — the count of stamped keys the last
--      commit could not delete; both commit routes write it, the catalog
--      offers "Retry reclaim" while it is non-zero (RET-13).
--
-- NARROWS everywhere (nobody gains; §6 is additive). Pre-apply inventory
-- (DEC-30) is captured into a TEMP TABLE before the transaction: aggregate
-- counts only. Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT
-- (check text, ok boolean, n text) — the editor shows only the last result.
-- Every function pins SET search_path = public. Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _dc_f77_before AS
SELECT 'document_review_events rows with NULL org_id (before backfill)' AS what, COUNT(*) AS n
  FROM document_review_events WHERE org_id IS NULL
UNION ALL
SELECT 'of those, rows whose document no longer exists (cannot be backfilled; kept for the record)', COUNT(*)
  FROM document_review_events e
 WHERE e.org_id IS NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = e.document_id)
UNION ALL
SELECT 'live document_versions rows sharing a storage key with another live row (RET-8: never shed until both qualify)', COUNT(*)
  FROM document_versions v
 WHERE v.archived_at IS NULL AND v.file_url IS NOT NULL
   AND EXISTS (SELECT 1 FROM document_versions o
                WHERE o.file_url = v.file_url AND o.id <> v.id AND o.archived_at IS NULL)
UNION ALL
SELECT 'documents disposed or Archived while an operational hold is still open (HLD-1 residue, pre-guard)', COUNT(*)
  FROM documents d
 WHERE (d.disposition_state = 'disposed' OR d.status = 'Archived')
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
UNION ALL
SELECT 'space archives in the catalog (gain reclaim_shortfall = 0)', COUNT(*)
  FROM archives WHERE kind = 'space';

BEGIN;

-- ── 1. documents retention / legal-hold guard (body from 20261043) + HLD-1 ──
CREATE OR REPLACE FUNCTION enforce_document_retention_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hold_change boolean;
  v_ret_change  boolean;
  v_controller  boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  v_hold_change :=
       NEW.legal_hold        IS DISTINCT FROM OLD.legal_hold
    OR NEW.legal_hold_matter IS DISTINCT FROM OLD.legal_hold_matter
    OR NEW.legal_hold_reason IS DISTINCT FROM OLD.legal_hold_reason
    OR NEW.legal_hold_by     IS DISTINCT FROM OLD.legal_hold_by
    OR NEW.legal_hold_at     IS DISTINCT FROM OLD.legal_hold_at;
  v_ret_change :=
       NEW.retention_policy  IS DISTINCT FROM OLD.retention_policy
    OR NEW.retention_until   IS DISTINCT FROM OLD.retention_until
    OR NEW.disposition_state IS DISTINCT FROM OLD.disposition_state
    OR NEW.disposed_at       IS DISTINCT FROM OLD.disposed_at;

  -- HLD-1: a plain status → 'Archived' must reach the hold check below.
  IF NOT v_hold_change AND NOT v_ret_change
     AND NOT (OLD.legal_hold AND NEW.status IS DISTINCT FROM OLD.status)
     AND NOT (NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived') THEN
    RETURN NEW;
  END IF;

  v_controller := is_org_controller(OLD.org_id);

  IF v_hold_change AND NOT v_controller THEN
    RAISE EXCEPTION 'Legal hold can only be placed or released by an Admin or Document Controller.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_ret_change AND NOT v_controller
     AND NOT user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid())
     AND NOT user_can_publish_on_library(OLD.library_id, auth.uid()::text, OLD.org_id) THEN
    RAISE EXCEPTION 'Retention settings can only be changed by a controller, the document''s owner, or a publisher of its library.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Under a legal hold nothing is destroyed by any verb: no disposition, no
  -- archive. Release the hold first (a controller action, audited).
  IF OLD.legal_hold AND NOT (NEW.legal_hold IS DISTINCT FROM OLD.legal_hold AND NOT NEW.legal_hold) THEN
    IF NEW.disposition_state = 'disposed' AND OLD.disposition_state IS DISTINCT FROM 'disposed' THEN
      RAISE EXCEPTION 'This document is under legal hold and cannot be disposed.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived' THEN
      RAISE EXCEPTION 'This document is under legal hold and cannot be archived.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- HLD-1 (dispose gate): an OPEN operational hold is a stop-work signal, and
  -- disposition / the archive verb are the most final advances there are.
  -- Refused for a non-controller; a controller may still act (they can
  -- release the hold first — the hold queue names it). The app refuses for
  -- everyone (lib/retention.ts disposeDocument).
  IF ((NEW.disposition_state = 'disposed' AND OLD.disposition_state IS DISTINCT FROM 'disposed')
      OR (NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived'))
     AND NOT v_controller
     AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = OLD.id AND h.released_at IS NULL) THEN
    RAISE EXCEPTION 'This document has an open hold and cannot be disposed or archived until it is released.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_retention_guard ON documents;
CREATE TRIGGER trg_document_retention_guard
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION enforce_document_retention_guard();

-- ── 2. library sensitive-column guard (body from 20261036) + RET-4 ──────────
CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF (NEW.owner_user_id   IS DISTINCT FROM OLD.owner_user_id
      OR NEW.owner_name   IS DISTINCT FROM OLD.owner_name
      OR NEW.owner_team_id IS DISTINCT FROM OLD.owner_team_id
      OR NEW.acl          IS DISTINCT FROM OLD.acl
      OR NEW.acl_index    IS DISTINCT FROM OLD.acl_index
      OR NEW.write_access  IS DISTINCT FROM OLD.write_access
      OR NEW.admin_access  IS DISTINCT FROM OLD.admin_access
      OR NEW.read_access   IS DISTINCT FROM OLD.read_access
      OR NEW.visible_to    IS DISTINCT FROM OLD.visible_to
      OR NEW.folder_security IS DISTINCT FROM OLD.folder_security
      OR NEW.default_new_acl IS DISTINCT FROM OLD.default_new_acl
      OR NEW.default_new_visibility IS DISTINCT FROM OLD.default_new_visibility
      OR NEW.review_control  IS DISTINCT FROM OLD.review_control
      OR NEW.review_policy   IS DISTINCT FROM OLD.review_policy
      OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy
      OR NEW.ack_policy      IS DISTINCT FROM OLD.ack_policy
      OR NEW.recert_policy   IS DISTINCT FROM OLD.recert_policy) THEN
    IF NOT is_org_controller(OLD.org_id)
       AND OLD.owner_user_id::text IS DISTINCT FROM auth.uid()::text
       AND NOT can_manage_node(OLD.acl_index, OLD.org_id) THEN
      RAISE EXCEPTION 'Not permitted to change this library''s ownership, access control, or compliance policy.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- RET-4: the recertification ATTESTATION — who attested, when, and when it
  -- is next due — is the compliance record itself. A controller or the
  -- library owner only (DEL-6 / DEC-20: owners recertify); the scan's
  -- recert_notified_at watermark stays unguarded (it is not authority).
  IF (NEW.last_recertified_at IS DISTINCT FROM OLD.last_recertified_at
      OR NEW.last_recertified_by IS DISTINCT FROM OLD.last_recertified_by
      OR NEW.next_recertification_date IS DISTINCT FROM OLD.next_recertification_date) THEN
    IF NOT is_org_controller(OLD.org_id)
       AND OLD.owner_user_id::text IS DISTINCT FROM auth.uid()::text THEN
      RAISE EXCEPTION 'Only an Admin, Document Controller or the library owner can record an access recertification.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_library_sensitive_columns ON libraries;
CREATE TRIGGER trg_library_sensitive_columns
BEFORE UPDATE ON libraries
FOR EACH ROW EXECUTE FUNCTION enforce_library_sensitive_columns();

-- ── 3. a revision's storage key is write-once (RET-6) ───────────────────────
CREATE OR REPLACE FUNCTION enforce_document_version_key_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF NEW.file_url IS DISTINCT FROM OLD.file_url THEN
    RAISE EXCEPTION 'A revision''s storage key cannot be changed once written. Upload a new revision instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_version_key_guard ON document_versions;
CREATE TRIGGER trg_document_version_key_guard
  BEFORE UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_document_version_key_guard();

-- ── 4. document_review_events: org-bound, append-only (DRLS-4) ──────────────
UPDATE document_review_events e
   SET org_id = d.org_id
  FROM documents d
 WHERE d.id = e.document_id AND e.org_id IS NULL;

DROP POLICY IF EXISTS "document_review_events_member_all" ON document_review_events;
DROP POLICY IF EXISTS document_review_events_select ON document_review_events;
CREATE POLICY document_review_events_select ON document_review_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = document_review_events.org_id AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS document_review_events_insert ON document_review_events;
CREATE POLICY document_review_events_insert ON document_review_events
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
             WHERE m.org_id = document_review_events.org_id AND m.uid = auth.uid() AND m.status = 'active')
    AND EXISTS (SELECT 1 FROM documents d
                 WHERE d.id = document_review_events.document_id AND d.org_id = document_review_events.org_id)
  );
DROP POLICY IF EXISTS document_review_events_no_update ON document_review_events;
CREATE POLICY document_review_events_no_update ON document_review_events
  AS RESTRICTIVE FOR UPDATE USING (false);
DROP POLICY IF EXISTS document_review_events_no_delete ON document_review_events;
CREATE POLICY document_review_events_no_delete ON document_review_events
  AS RESTRICTIVE FOR DELETE USING (false);

DO $$
DECLARE
  v_null bigint;
BEGIN
  SELECT COUNT(*) INTO v_null FROM document_review_events WHERE org_id IS NULL;
  IF v_null = 0 THEN
    ALTER TABLE document_review_events ALTER COLUMN org_id SET NOT NULL;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_review_events_org_id_present') THEN
    -- Unbackfillable residue (document gone): bind every NEW row now, keep
    -- the old rows for the record. Validate later once the residue is
    -- resolved: ALTER TABLE document_review_events VALIDATE CONSTRAINT
    -- document_review_events_org_id_present; then SET NOT NULL.
    ALTER TABLE document_review_events
      ADD CONSTRAINT document_review_events_org_id_present CHECK (org_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_review_events_org_id_fkey') THEN
    ALTER TABLE document_review_events
      ADD CONSTRAINT document_review_events_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE NOT VALID;
  END IF;
  BEGIN
    ALTER TABLE document_review_events VALIDATE CONSTRAINT document_review_events_org_id_fkey;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'document_review_events_org_id_fkey left NOT VALID: some rows name an org that no longer exists';
  END;
END $$;

-- ── 5. the disposition trail is undeletable by every non-service role ───────
DROP POLICY IF EXISTS doc_disposition_events_no_delete ON document_disposition_events;
CREATE POLICY doc_disposition_events_no_delete ON document_disposition_events
  AS RESTRICTIVE FOR DELETE USING (false);

-- ── 6. the catalog remembers a delete shortfall (RET-13) ────────────────────
ALTER TABLE archives ADD COLUMN IF NOT EXISTS reclaim_shortfall integer NOT NULL DEFAULT 0;

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 12 (n NULL). Inventory rows: ok NULL, n = the count.
SELECT 'documents retention/legal-hold guard installed (BEFORE UPDATE, FOR EACH ROW)' AS check,
       (SELECT EXISTS (SELECT 1 FROM pg_trigger t
                        WHERE t.tgname = 'trg_document_retention_guard' AND NOT t.tgisinternal
                          AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE ON public.documents FOR EACH ROW%')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'retention guard: open-hold dispose gate present; the legal-hold arms survive',
       (SELECT prosrc LIKE '%FROM document_holds h WHERE h.document_id = OLD.id AND h.released_at IS NULL%'
              AND prosrc LIKE '%cannot be disposed or archived until it is released%'
              AND prosrc LIKE '%This document is under legal hold and cannot be disposed.%'
              AND prosrc LIKE '%This document is under legal hold and cannot be archived.%'
              AND prosrc LIKE '%NEW.disposed_at       IS DISTINCT FROM OLD.disposed_at%'
          FROM pg_proc WHERE proname = 'enforce_document_retention_guard'),
       NULL
UNION ALL
SELECT 'retention guard: a plain status -> Archived reaches the hold check (early return widened)',
       (SELECT prosrc LIKE '%AND NOT (NEW.status = ''Archived'' AND OLD.status IS DISTINCT FROM ''Archived'') THEN%'
          FROM pg_proc WHERE proname = 'enforce_document_retention_guard'),
       NULL
UNION ALL
SELECT 'library guard installed (BEFORE UPDATE) and carries the recert attestation arm',
       (SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_library_sensitive_columns' AND NOT tgisinternal)
              AND (SELECT prosrc LIKE '%NEW.next_recertification_date IS DISTINCT FROM OLD.next_recertification_date%'
                          AND prosrc LIKE '%Only an Admin, Document Controller or the library owner can record an access recertification.%'
                          AND prosrc LIKE '%NEW.recert_policy   IS DISTINCT FROM OLD.recert_policy%'
                     FROM pg_proc WHERE proname = 'enforce_library_sensitive_columns')),
       NULL
UNION ALL
SELECT 'every attestation column the library guard names exists (late-bound plpgsql safety)',
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'libraries'
           AND column_name IN ('last_recertified_at', 'last_recertified_by', 'next_recertification_date')),
       NULL
UNION ALL
SELECT 'document_versions storage-key guard installed (BEFORE UPDATE) and refuses a file_url change',
       (SELECT EXISTS (SELECT 1 FROM pg_trigger t
                        WHERE t.tgname = 'trg_document_version_key_guard' AND NOT t.tgisinternal
                          AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE ON public.document_versions FOR EACH ROW%')
              AND (SELECT prosrc LIKE '%NEW.file_url IS DISTINCT FROM OLD.file_url%'
                          AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW%'
                     FROM pg_proc WHERE proname = 'enforce_document_version_key_guard')),
       NULL
UNION ALL
SELECT 'document_review_events: SELECT + INSERT for members, no permissive UPDATE/DELETE/ALL, RESTRICTIVE false on both',
       (SELECT COUNT(*) = 0 FROM pg_policies
         WHERE tablename = 'document_review_events' AND permissive = 'PERMISSIVE' AND cmd IN ('ALL', 'UPDATE', 'DELETE'))
       AND (SELECT COUNT(*) = 2 FROM pg_policies
             WHERE tablename = 'document_review_events' AND permissive = 'PERMISSIVE'
               AND policyname IN ('document_review_events_select', 'document_review_events_insert'))
       AND (SELECT COUNT(*) = 2 FROM pg_policies
             WHERE tablename = 'document_review_events' AND permissive = 'RESTRICTIVE' AND qual = 'false'
               AND policyname IN ('document_review_events_no_update', 'document_review_events_no_delete')),
       NULL
UNION ALL
SELECT 'document_review_events INSERT binds the row to a document of its org',
       (SELECT with_check LIKE '%d.org_id = document_review_events.org_id%'
          FROM pg_policies WHERE tablename = 'document_review_events' AND policyname = 'document_review_events_insert'),
       NULL
UNION ALL
SELECT 'document_review_events.org_id is bound (NOT NULL, or the NOT VALID CHECK for new rows) and has the FK to orgs',
       ((SELECT is_nullable = 'NO' FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'document_review_events' AND column_name = 'org_id')
        OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_review_events_org_id_present'))
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_review_events_org_id_fkey'),
       NULL
UNION ALL
SELECT 'disposition trail: DELETE refused for every non-service role (USING false); UPDATE still refused',
       (SELECT qual = 'false' FROM pg_policies
         WHERE tablename = 'document_disposition_events' AND policyname = 'doc_disposition_events_no_delete')
       AND (SELECT qual = 'false' FROM pg_policies
             WHERE tablename = 'document_disposition_events' AND policyname = 'doc_disposition_events_no_update'),
       NULL
UNION ALL
SELECT 'archives.reclaim_shortfall exists, NOT NULL, default 0',
       (SELECT is_nullable = 'NO' AND column_default LIKE '0%' FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'archives' AND column_name = 'reclaim_shortfall'),
       NULL
UNION ALL
SELECT 'search_path pinned on all three guard functions',
       (SELECT COUNT(*) = 3 FROM pg_proc
         WHERE proname IN ('enforce_document_retention_guard', 'enforce_library_sensitive_columns', 'enforce_document_version_key_guard')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _dc_f77_before
UNION ALL
SELECT 'inventory (after): document_review_events rows still with NULL org_id (expect 0; otherwise the NOT VALID world)', NULL,
       (SELECT COUNT(*) FROM document_review_events WHERE org_id IS NULL)::text
UNION ALL
SELECT 'inventory (after): document_review_events_org_id_fkey validated', NULL,
       (SELECT COALESCE(convalidated::text, 'missing') FROM pg_constraint WHERE conname = 'document_review_events_org_id_fkey');
