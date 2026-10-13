-- ─────────────────────────────────────────────────────────────────────────────
-- 20261205_dc_roundF_direct_write_issue_record.sql
--
-- document-control Round F wave 3 — P23 DIRECT-WRITE ISSUE RECORD: the
-- database records every status-change issue, whichever door it came
-- through (REV-19 (a)); and a member's version insert is judged by the
-- version-integrity policy instead of failing with 42P17 (projects-tab
-- SEC-23, assigned to this package at the J16 merge).
--
-- §1  REV-19 (a)  A status change that makes a document a controlled issue
--     is a guarded write since 20261144 (REV-18) and 20261185 (REV-21), and
--     the app's doors record it (DOCUMENT_ISSUED — lib/revisions.ts
--     changeDocumentStatus for the metadata and bulk editors,
--     unarchiveDocument for the un-archive). A DIRECT write — the same
--     UPDATE sent to PostgREST by anyone holding a session, outside the
--     app — was admitted by the guard on the same rules and recorded
--     NOTHING. Now an AFTER UPDATE trigger on documents is the ONE writer of
--     DOCUMENT_ISSUED for a status-change issue (DEC-44 (P23), the double-
--     record design): it writes exactly one row for every admitted
--     status-only issue a signed-in caller makes — the guard's v_issuing
--     for a write that leaves the pointer where it is (out of Draft /
--     In Review / a retirement into an issue status, or into Issued /
--     Locked out of an issue status no gate reads as in force) — in the
--     same transaction as the write (if the record cannot be written, the
--     write does not land). The record keeps the app doors' shape:
--     `door` (the app's door, named by the request header the app sends —
--     x-mos-issue-door: metadata | bulk | unarchive, or a rollback's
--     put-back: supersede_rollback | lifecycle_rollback | reversal_rollback;
--     the legacy reversal's restore by its request path, reversal_restore;
--     'direct' otherwise), the statuses, the revision, `putBack`
--     (three-state, P14's rule), `entryIntoForce` (P25's), `compensation:
--     true` on a rollback door's row (the put-back undoes a failed saga, so
--     a count of issues can leave it out), the policy
--     decision (`reviewPolicyMode`, `rosterComplete`,
--     `issuedWithoutSignOff` — read here, the roster counted exactly as the
--     guard counts it), the actor's headline role (`user_role`, as the
--     doors wrote it) and role collection (`actorRoles`); plus
--     `recordedBy: 'database'` and the request path. The clock fields
--     (P23 fix pass) record what the issue OWES (`complianceClocksOwed`
--     and the sentence for its put-back state —
--     STATUS_ISSUE_CLOCKS_OWED_NOTE), never that a clock started: the row
--     is written with the status change, before any door could start one,
--     and the header (the caller's claim) decides none of them —
--     `complianceClocksStarted` / `reviewClockReset` /
--     `acknowledgmentRosterOpened` are NULL here. A put-back owes nothing
--     and is never told to restart a clock, whichever door made it. The
--     app (deployed first) asks document_status_issue_recorded_by_database()
--     before its write (and names its door only when it answers true) and
--     then writes no DOCUMENT_ISSUED of its own — it still starts the
--     compliance clocks, and records the outcome on a follow-up row:
--     COMPLIANCE_CLOCKS_STARTED, or COMPLIANCE_CLOCKS_NOT_STARTED with what
--     did not start (REV-15's precedent). With neither row, nothing was
--     started (a direct write, or a door that stopped after its write):
--     Document Control starts what is owed from the document. The service
--     role (auth.uid() NULL: the backend, a restore, the SQL console) is
--     not recorded, as the guard does not judge it.
--
-- §2  SEC-23  20261037's document_versions_insert_integrity (AS RESTRICTIVE
--     FOR INSERT) tests "the document's FIRST version" with a sublink on
--     document_versions itself; for any caller row-level security applies
--     to, the rewriter expands document_versions' own policies inside that
--     sublink (document_versions_org_access holds a sublink too) and stops
--     with 42P17 "infinite recursion detected in policy for relation
--     document_versions" — before any row is judged, for every member,
--     Document Control included (reproduced on a scratch PostgreSQL 16
--     carrying the whole sequence). The policy is re-created from its
--     NEWEST body (20261037, found by scanning; lineDiff-pinned) with one
--     change: the first-version test reads through document_has_versions
--     (new, SECURITY DEFINER, search_path pinned, EXECUTE for authenticated
--     and service_role only — DRLS-16), which counts EVERY version of the
--     document, not only the ones the caller may read (the sublink, had it
--     run, saw only those — so a caller who cannot read a document's
--     versions could have passed it off as a first version; the helper
--     closes that), and answers NULL — never true or false — for a document
--     the caller cannot see (no existence oracle). Every other limb is
--     byte for byte: the publisher tier, the author's own in-review draft,
--     doc_is_visible.
--
-- WIDENING? §1: no — it adds a record; it refuses nothing the guard admits.
-- §2: yes, in effect — an INSERT that failed for everyone with 42P17 is now
-- admitted where the policy's limbs admit it (the publisher tier; the
-- author's in-review draft; the author's first version of a visible
-- document). DEC-30 inventory (aggregate counts only, captured BEFORE the
-- transaction): whether the live policy still carries the recursive
-- first-version sublink (1 = the repository's text, the 42P17 world; 0 =
-- the live text differs — SEC-23's "verify live first"), the documents with
-- no version at all (the first-version limb's population), the version
-- rows; for §1, the DOCUMENT_ISSUED rows the app wrote before this paste,
-- and the documents with a current revision in each class a status-only
-- issue starts from (work in progress; retired).
--
-- HOW TO APPLY — DEPLOY ORDER: deploy the app carrying P23 FIRST, then
-- paste this file. That app asks document_status_issue_recorded_by_database()
-- and, while it is missing (PGRST202 / 42883) or answers false, writes
-- DOCUMENT_ISSUED itself and sends no custom header — exactly today's path,
-- so the app works before this paste. AFTER THE PASTE (a precondition for
-- keeping it): its doors' status writes carry the x-mos-issue-door request
-- header, which the hosted API must admit in its CORS preflight (it admits
-- supabase-js's own x-client-info the same way). Right after the paste,
-- issue one document from the metadata editor (Draft -> Issued) on staging
-- or in the workspace: it must save. If it fails with a network error
-- ("Failed to fetch") and nothing is written, the API refuses the header:
-- run the reversal (DROP TRIGGER trg_document_status_issue_record ON
-- documents;) — the probe then answers false, the doors send no header and
-- write their own record again, as before this paste. Pasted BEFORE that deploy, today's app and this trigger would
-- each write a row for an app door's issue (two rows, never none) until the
-- deploy lands. It re-creates no guard and no other function; it needs
-- 20261144 (is_controlled_issue_status and the retirement stamp, which §1
-- reads) — its first statement refuses to run, changing nothing, without
-- them — and is independent of 20261185 / 20261193 (it reads the same
-- predicates the guard reads, and records only what the guard admitted).
-- §2 needs 20261037 (the policy and doc_is_visible).
--
-- THE APP BEFORE AND AFTER THIS PASTE: before — the app's doors write
-- DOCUMENT_ISSUED (unchanged); a direct write records nothing (as today);
-- a member's version insert fails with 42P17 wherever the live policy
-- matches the repository. After — one DOCUMENT_ISSUED per status-change
-- issue, written here (an app door's record names its door and carries its
-- shape and what the issue owes; what the door started follows as
-- COMPLIANCE_CLOCKS_STARTED, what did not as COMPLIANCE_CLOCKS_NOT_STARTED;
-- a rollback's put-back names its rollback door and owes nothing);
-- a member's version insert is judged by the policy's own limbs.
--
-- Single paste: prerequisite check → temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the bases) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_controlled_issue_status' AND pronargs = 1)
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'retired_issue_version_id')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'doc_is_visible' AND pronargs = 1) THEN
    RAISE EXCEPTION '20261205 needs 20261144 (is_controlled_issue_status, the retirement stamp) and 20261037 (doc_is_visible) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_205_before;
CREATE TEMP TABLE dc_round_f_205_before AS
SELECT 'inventory (before apply): the live document_versions_insert_integrity still tests the first version with a sublink on document_versions (1 = the repository''s text: every member''s version insert failed with 42P17 until this paste; 0 = the live text differs — SEC-23''s live check)' AS inventory,
       COUNT(*)::text AS n
  FROM pg_policy p
 WHERE p.polrelid = 'public.document_versions'::regclass
   AND p.polname = 'document_versions_insert_integrity'
   AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%FROM document_versions v2%'
UNION ALL
SELECT 'inventory (before apply): documents with no version at all — the policy''s first-version limb (the author''s first version of a visible document) binds these; it now counts every version of the document, not only the ones the caller may read',
       COUNT(*)::text
  FROM documents d
 WHERE NOT EXISTS (SELECT 1 FROM document_versions v WHERE v.record_id = d.id)
UNION ALL
SELECT 'inventory (before apply): document_versions rows',
       COUNT(*)::text
  FROM document_versions
UNION ALL
SELECT 'inventory (before apply): DOCUMENT_ISSUED rows already written by the app''s doors (kept as they are; from this paste the database writes the record)',
       COUNT(*)::text
  FROM audit_logs a
 WHERE a.action = 'DOCUMENT_ISSUED'
UNION ALL
SELECT 'inventory (before apply): documents with a current revision in Draft / In Review — a status-only move of one into an issue status is recorded here from now on, whichever door it comes through',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL AND btrim(COALESCE(d.status, '')) IN ('Draft', 'In Review')
UNION ALL
SELECT 'inventory (before apply): retired documents (Superseded / Archived / Void) with a current revision — an exit of one into an issue status (an un-archive, a rollback''s put-back, a direct write) is recorded here from now on',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL AND btrim(COALESCE(d.status, '')) IN ('Superseded', 'Archived', 'Void');

BEGIN;

-- ── §1. REV-19 (a): the database's record of a status-change issue ─────────
-- One row per admitted status-only issue a signed-in caller makes, written in
-- the same transaction as the write. The predicates are the guard's
-- (is_controlled_issue_status; 20261185's REV-21 limb) and the app's
-- (lib/revisions.ts isEntryIntoForce, putBackFromRetirementStamp,
-- STATUS_ISSUE_CLOCKS_OWED_NOTE — pinned to this body by test).
CREATE OR REPLACE FUNCTION record_document_status_issue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor    uuid := auth.uid();   -- NULL for service-role / SQL console
  v_from     text;
  v_retired  boolean;
  v_entry    boolean;
  v_put_back boolean;
  v_header   text;
  v_path     text;
  v_door     text;
  v_app_door boolean;
  v_chain    text;
  v_mode     text;
  v_reqs     integer;
  v_signed   integer;
  v_roster   boolean;
  v_owes_review boolean;
  v_owes_roster boolean;
  v_note     text;
  v_email    text;
  v_role     text;
  v_roles    text[];
BEGIN
  -- The service role is trusted and not judged by the guard; it is not
  -- recorded here either (a restore replays documents as they were).
  IF v_actor IS NULL THEN
    RETURN NULL;
  END IF;
  -- A status-only write: the pointer stays where it is (a write that moves
  -- the pointer is a publish, recorded by its own door).
  IF NEW.current_version_id IS NULL
     OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    RETURN NULL;
  END IF;
  -- The guard's v_issuing for such a write (20261144 + 20261185's REV-21 limb).
  IF NOT (
       (NOT is_controlled_issue_status(OLD.status) AND is_controlled_issue_status(NEW.status))
       OR COALESCE(is_controlled_issue_status(OLD.status)
                   AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')
                   AND NEW.status IN ('Issued', 'Locked'), false)
     ) THEN
    RETURN NULL;
  END IF;

  -- The status before, trimmed exactly as is_controlled_issue_status trims.
  v_from := btrim(COALESCE(OLD.status, ''), E' \t\n\u000B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF');
  v_retired := v_from IN ('Superseded', 'Void', 'Archived');
  -- entryIntoForce (lib/revisions.ts isEntryIntoForce): the current revision
  -- put in force for the FIRST time — into Issued / Locked out of an issue
  -- status no gate reads as in force, or out of a retirement stamped with
  -- one at this revision.
  v_entry := COALESCE(NEW.status IN ('Issued', 'Locked'), false)
             AND (
               (is_controlled_issue_status(OLD.status) AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked'))
               OR (v_retired
                   AND OLD.retired_issue_version_id IS NOT NULL
                   AND OLD.retired_issue_version_id = OLD.current_version_id
                   AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked'))
             );
  -- putBack, three-state (lib/revisions.ts putBackFromRetirementStamp, P14):
  -- false on evidence of a new issue, true when the stamp names this
  -- revision, NULL (no evidence) otherwise.
  IF v_entry THEN
    v_put_back := false;
  ELSIF v_from IN ('Draft', 'In Review') THEN
    v_put_back := false;
  ELSIF NOT v_retired THEN
    v_put_back := NULL;
  ELSIF OLD.retired_issue_version_id IS NOT NULL AND OLD.retired_issue_version_id = OLD.current_version_id THEN
    v_put_back := true;
  ELSIF OLD.retired_issue_version_id IS NULL AND OLD.retired_issue_status = 'not-issued' THEN
    v_put_back := false;
  ELSE
    v_put_back := NULL;
  END IF;

  -- The app's door, named by the request header the app sends with its
  -- write (PostgREST's request.headers): a status editor, the un-archive
  -- (out of Archived), or a rollback's put-back (put_back_retired_issue's
  -- p_via, out of a retirement); the legacy reversal's restore is named by
  -- its request path (restore_reversed_source — PostgREST sets it from the
  -- function that ran). Any other write is 'direct'. The name is the
  -- caller's claim, as the app's own record always was — it labels the row
  -- and decides nothing else on it: the clock fields below never read it.
  -- The actor is the session's.
  BEGIN
    v_header := lower(btrim(NULLIF(current_setting('request.headers', true), '')::jsonb ->> 'x-mos-issue-door'));
  EXCEPTION WHEN others THEN
    v_header := NULL;
  END;
  v_path := NULLIF(current_setting('request.path', true), '');
  v_door := CASE WHEN v_header IN ('metadata', 'bulk') THEN v_header
                 WHEN v_header = 'unarchive' AND v_from = 'Archived' THEN v_header
                 WHEN v_header IN ('supersede_rollback', 'lifecycle_rollback', 'reversal_rollback') AND v_retired THEN v_header
                 WHEN v_path = '/rpc/restore_reversed_source' AND v_retired THEN 'reversal_restore'
                 ELSE 'direct' END;
  v_app_door := v_door IN ('metadata', 'bulk', 'unarchive');

  -- The policy decision (DEC-63 §2), read as the app reads it and the roster
  -- counted as the guard counts it.
  v_chain := review_control_mode_for(NULL, NEW.collection_id, NEW.library_id);
  v_mode := CASE WHEN v_chain = 'require'
                   OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require'
                 THEN 'require' ELSE v_chain END;
  SELECT COALESCE(sum(g.reqs), 0), COALESCE(sum(LEAST(g.reqs, g.filled)), 0)
    INTO v_reqs, v_signed
    FROM (
      SELECT COALESCE(s.slot_group, '') AS grp,
             count(*) FILTER (WHERE s.slot = 'primary') AS reqs,
             count(*) FILTER (WHERE (s.slot = 'primary' OR s.activated)
                                AND s.status = 'signed'
                                AND s.signature_id IS NOT NULL
                                AND EXISTS (
                                  SELECT 1 FROM e_signatures e
                                  WHERE e.id = s.signature_id
                                    AND e.signer_user_id = s.reviewer_user_id
                                    AND e.org_id = s.org_id
                                    AND (e.document_version_id = s.document_version_id
                                         OR e.document_version_id IS NULL)
                                )) AS filled
        FROM document_review_signoffs s
       WHERE s.document_version_id = NEW.current_version_id
       GROUP BY COALESCE(s.slot_group, '')
    ) g;
  v_roster := COALESCE(v_reqs, 0) > 0 AND COALESCE(v_signed, 0) >= v_reqs;

  -- The compliance clocks (P23 fix pass): this row is written in the status
  -- change's own transaction, before any door could start a clock, and
  -- whatever header the write carried — so it records what the issue OWES
  -- (lib/revisions.ts STATUS_ISSUE_CLOCKS_OWED_NOTE), never that a clock
  -- started; an app door that starts them records the outcome on the row
  -- that follows (COMPLIANCE_CLOCKS_STARTED / COMPLIANCE_CLOCKS_NOT_STARTED).
  -- A put-back owes nothing, whichever door (or none) made it.
  v_owes_review := v_put_back IS NOT DISTINCT FROM false AND NOT v_entry;
  v_owes_roster := v_put_back IS DISTINCT FROM true;
  v_note := CASE
    WHEN v_put_back IS NOT DISTINCT FROM true THEN 'the put-back of the issue its retirement took away (the retirement stamp names this revision): nothing is owed — the review clock and the acknowledgment roster it had keep running and are not to be restarted (a restart would mark the document reviewed today and could hide a review already due)'
    WHEN v_entry THEN 'a first entry into force out of a status no gate reads as in force (IFC, an empty status, a variant, a library''s own, or no status — directly, or out of a retirement stamped with it): it owes the acknowledgment roster for this revision only — the review clock is not to be reset (nothing records that this revision was reviewed now; a reset would mark the document reviewed today and could hide a review already due). This record was written with the status change, before any clock could start: an app door that starts them records the outcome on the row that follows (COMPLIANCE_CLOCKS_STARTED, or COMPLIANCE_CLOCKS_NOT_STARTED for what did not start); with neither row, nothing was started — Document Control then opens the roster from the document and leaves the review clock as it is'
    WHEN v_put_back IS NOT DISTINCT FROM false THEN 'a new issue: it owes the review clock and the acknowledgment roster for this revision. This record was written with the status change, before any clock could start: an app door that starts them records the outcome on the row that follows (COMPLIANCE_CLOCKS_STARTED, or COMPLIANCE_CLOCKS_NOT_STARTED for what did not start); with neither row, nothing was started — Document Control then starts both from the document'
    ELSE 'no evidence whether this puts back the issue its retirement took away (the retirement carries no stamp — retired before 20261144 or by the service role — or names another revision): it owes the acknowledgment roster for this revision only — the review clock is not to be reset (a reset would mark the document reviewed today and could hide a review already due). This record was written with the status change, before any clock could start: an app door that starts them records the outcome on the row that follows (COMPLIANCE_CLOCKS_STARTED, or COMPLIANCE_CLOCKS_NOT_STARTED for what did not start); with neither row, nothing was started — Document Control then opens the roster from the document and leaves the review clock as it is'
  END;

  -- The writer's headline role in user_role, as the app's doors wrote it
  -- (the audit viewer's role filter and the audit identity rail compare it
  -- with one held role); the ROLE COLLECTION (DEC-2 / ADD-1) beside it in
  -- details.actorRoles.
  SELECT m.email, m.role, COALESCE(NULLIF(m.roles, '{}'), ARRAY[m.role]) INTO v_email, v_role, v_roles
    FROM org_members m
   WHERE m.org_id = NEW.org_id AND m.uid = v_actor
   LIMIT 1;

  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details)
  VALUES ('DOCUMENT_ISSUED', NEW.id::text, 'document', NEW.org_id, v_actor, v_email, v_role,
          jsonb_build_object(
            'door', v_door,
            'fromStatus', OLD.status,
            'toStatus', NEW.status,
            'versionId', NEW.current_version_id,
            'rev', OLD.rev,
            'putBack', v_put_back
          )
          || CASE WHEN v_entry THEN jsonb_build_object('entryIntoForce', true) ELSE '{}'::jsonb END
          -- A rollback's put-back undoes a failed supersede / split / merge /
          -- reversal (a compensation): marked, so a history, a viewer or an
          -- export can leave it out of a count of issues.
          || CASE WHEN v_door IN ('supersede_rollback', 'lifecycle_rollback', 'reversal_rollback') THEN jsonb_build_object('compensation', true) ELSE '{}'::jsonb END
          || jsonb_build_object(
            'reviewPolicyMode', v_mode,
            'rosterComplete', v_roster,
            'issuedWithoutSignOff', (v_mode = 'require' AND NOT v_roster),
            -- Unknown when this row is written (NULL, never true): the
            -- outcome is the door's follow-up row.
            'complianceClocksStarted', NULL::boolean,
            'reviewClockReset', NULL::boolean,
            'acknowledgmentRosterOpened', NULL::boolean,
            'complianceClocksOwed', jsonb_build_object('reviewClock', v_owes_review, 'acknowledgmentRoster', v_owes_roster),
            'complianceClocksNote', v_note,
            'complianceClockErrors', NULL::jsonb,
            'complianceClocksBy', CASE
              WHEN NOT v_owes_roster THEN 'none owed (a put-back: the clocks it had keep running)'
              WHEN v_app_door THEN 'the ' || v_door || ' door named on this write, after it: its COMPLIANCE_CLOCKS_STARTED or COMPLIANCE_CLOCKS_NOT_STARTED row follows; with neither, nothing was started'
              ELSE 'no app door that starts clocks made this write: nothing was started — Document Control starts what is owed from the document' END,
            'actorRoles', to_jsonb(v_roles),
            'recordedBy', 'database',
            'requestPath', v_path
          ));
  RETURN NULL;
END;
$$;
-- A trigger function: no role calls it (EXECUTE is checked when the trigger
-- is created, never when it fires).
REVOKE ALL ON FUNCTION record_document_status_issue() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_document_status_issue_record ON documents;
CREATE TRIGGER trg_document_status_issue_record
AFTER UPDATE OF status ON documents
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION record_document_status_issue();

-- The app asks this after its write: true while the trigger above is bound
-- and enabled — then the database wrote the record and the app writes none.
-- Missing (before this paste) or false: the app writes it, as today.
CREATE OR REPLACE FUNCTION document_status_issue_recorded_by_database()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.documents'::regclass
       AND t.tgname = 'trg_document_status_issue_record'
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  );
$$;
REVOKE ALL ON FUNCTION document_status_issue_recorded_by_database() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION document_status_issue_recorded_by_database() TO authenticated, service_role;

-- ── §2. SEC-23: the first-version test without the recursive read ──────────
-- Every version of the document, read as the owner (no row-level security,
-- so no recursion); NULL for a document the caller cannot see — one outside
-- the caller's active workspaces (my_org_ids, as document_versions_org_access
-- reads it) or hidden from them (doc_is_visible): no existence oracle.
CREATE OR REPLACE FUNCTION document_has_versions(p_record uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM documents d
                            WHERE d.id = p_record AND d.org_id IN (SELECT my_org_ids()))
                   AND doc_is_visible(p_record)
              THEN EXISTS (SELECT 1 FROM document_versions v WHERE v.record_id = p_record)
         END;
$$;
REVOKE ALL ON FUNCTION document_has_versions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION document_has_versions(uuid) TO authenticated, service_role;

-- INSERT: publisher-grade for anything, OR the author's own row when it is
-- either an unreleased in-review draft (submit-for-review) or the document's
-- FIRST version (the creation flows: upload-and-link, bulk upload,
-- split/merge targets). A released-looking row against a document with
-- history requires publish authority — the exact EGRESS-6 hole.
DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;
CREATE POLICY document_versions_insert_integrity ON document_versions
AS RESTRICTIVE FOR INSERT WITH CHECK (
  user_can_publish_doc(record_id, org_id)
  OR (
    created_by = auth.uid()
    AND doc_is_visible(record_id)
    AND (
      (review_state = 'in_review' AND released_at IS NULL)
      OR NOT document_has_versions(document_versions.record_id)
    )
  )
);

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 7. Inventory rows: n = the aggregate count.
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here); pg_policy expressions are deparsed (pg_get_expr).
SELECT 'REV-19 (a): an AFTER UPDATE OF status trigger on documents records every status-only issue a signed-in caller makes (the guard''s v_issuing, the pointer unmoved), skipping the service role' AS check,
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = 'public.documents'::regclass AND t.tgname = 'trg_document_status_issue_record'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D')
       AND (SELECT prosrc LIKE '%IF v_actor IS NULL THEN%RETURN NULL;%IF NEW.current_version_id IS NULL%OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN%(NOT is_controlled_issue_status(OLD.status) AND is_controlled_issue_status(NEW.status))%AND COALESCE(OLD.status, '''') NOT IN (''Issued'', ''Locked'')%AND NEW.status IN (''Issued'', ''Locked''), false)%'
              FROM pg_proc WHERE proname = 'record_document_status_issue') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'REV-19 (a): the record is DOCUMENT_ISSUED in the app doors'' shape — door (the x-mos-issue-door header, a rollback''s door included, else direct), statuses, revision, putBack, entryIntoForce, the policy decision, what the clocks are owed (never that they started) — recordedBy database',
       (SELECT prosrc LIKE '%''x-mos-issue-door''%''supersede_rollback'', ''lifecycle_rollback'', ''reversal_rollback''%INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details)%VALUES (''DOCUMENT_ISSUED''%''door'', v_door%''putBack'', v_put_back%''entryIntoForce'', true%''compensation'', true%''reviewPolicyMode'', v_mode%''rosterComplete'', v_roster%''issuedWithoutSignOff''%''complianceClocksStarted'', NULL::boolean%''complianceClocksOwed''%''complianceClocksNote'', v_note%''actorRoles''%''recordedBy'', ''database''%'
          FROM pg_proc WHERE proname = 'record_document_status_issue'),
       NULL
UNION ALL
SELECT 'DRLS-16: record_document_status_issue is SECURITY DEFINER with search_path pinned; PUBLIC, anon and authenticated may not execute it',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'record_document_status_issue' AND p.prosecdef
                AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'record_document_status_issue()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'record_document_status_issue()', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                        WHERE p.proname = 'record_document_status_issue' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'REV-19 (a): document_status_issue_recorded_by_database() answers true (the app now writes no DOCUMENT_ISSUED of its own); authenticated may execute it, anon may not',
       COALESCE(document_status_issue_recorded_by_database(), false)
       AND has_function_privilege('authenticated', 'document_status_issue_recorded_by_database()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'document_status_issue_recorded_by_database()', 'EXECUTE')
       AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'document_status_issue_recorded_by_database'
                    AND p.proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 'SEC-23: document_versions_insert_integrity no longer reads document_versions in a sublink — its first-version test is document_has_versions(record_id); every other limb as 20261037 wrote it',
       (SELECT pg_get_expr(p.polwithcheck, p.polrelid) NOT LIKE '%FROM document_versions%'
           AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%user_can_publish_doc(record_id, org_id)%'
           AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%doc_is_visible(record_id)%'
           AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%in_review%'
           AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%NOT document_has_versions(record_id)%'
           AND NOT p.polpermissive AND p.polcmd = 'a'
          FROM pg_policy p
         WHERE p.polrelid = 'public.document_versions'::regclass AND p.polname = 'document_versions_insert_integrity'),
       NULL
UNION ALL
SELECT 'SEC-23 / DRLS-16: document_has_versions is SECURITY DEFINER with search_path pinned, NULL outside the caller''s workspaces and for a hidden document; authenticated and service_role may execute it, PUBLIC and anon may not',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'document_has_versions' AND p.pronargs = 1 AND p.prosecdef
                AND p.proconfig @> ARRAY['search_path=public']
                AND p.prosrc LIKE '%CASE WHEN EXISTS (SELECT 1 FROM documents d%d.org_id IN (SELECT my_org_ids())%AND doc_is_visible(p_record)%THEN EXISTS (SELECT 1 FROM document_versions v WHERE v.record_id = p_record)%')
       AND has_function_privilege('authenticated', 'document_has_versions(uuid)', 'EXECUTE')
       AND has_function_privilege('service_role', 'document_has_versions(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'document_has_versions(uuid)', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                        WHERE p.proname = 'document_has_versions' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'the publish guard is untouched by this file (still bound BEFORE UPDATE on documents)',
       EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.documents'::regclass
                AND t.tgname = 'trg_document_publish_guard' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_205_before;
