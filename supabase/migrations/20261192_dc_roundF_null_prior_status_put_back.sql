-- ─────────────────────────────────────────────────────────────────────────────
-- 20261192_dc_roundF_null_prior_status_put_back.sql
--
-- document-control Round F wave 3 — P25 STATUS-SURFACE FOLLOW-UPS: a
-- rollback or a reversal puts a NULL-status (or empty-status) document back
-- as what it was, never as 'Issued' (REV-29, the database half).
--
--   REV-29  A rollback is meant to put back the status a document held before
--           the operation (REV-12, REV-14). For a NULL status it did not: the
--           app turned a NULL prior status into 'Issued' (`?? "Issued"` in
--           lib/revisions.ts undoFailedSupersede, lib/documentLifecycle/
--           common.ts markSupersededAndLink and merge.ts), the split / merge
--           events recorded that 'Issued', and the two put-back doors could
--           not carry a NULL anyway: put_back_retired_issue (20261165) and
--           restore_reversed_source (20261164) each refuse a blank status
--           ("…name the status…"). So the rollback of a NULL-status document
--           — not in force at the print gate or on /verify — put it in force
--           as 'Issued', unreviewed, wherever the guard admitted a put-back;
--           and since 20261185 that write is judged as a first entry into
--           force (refused under a require policy short of Document Control
--           or a complete roster, and over an active hold for everyone, the
--           forced rollback included), leaving the document Superseded.
--           The app carrying P25 keeps a NULL (or blank) prior status as
--           what it was — the rollbacks put it back so, the events record
--           it so, a reversal restores it so. This file lets the two doors
--           take it:
--           (1) put_back_retired_issue: its blank-status refusal now binds
--               the un-archive door only (the un-archive dialog restores a
--               status it names); the three rollback doors take a NULL or
--               blank status. And its recorded door — Document Control's
--               forced put-back of a held, stamped retirement — opens for a
--               NULL status as for any other (its issue test,
--               btrim(p_status) NOT IN (…), is NULL for a NULL, so it never
--               opened; a NULL is an issue status to the guard).
--           (2) restore_reversed_source: its blank-status refusal now binds
--               only a call that names no reversed event; the reversal's
--               door — every call the app makes — takes a NULL or blank
--               status. Its recorded door reads no status and is unchanged.
--           The guard decides each write exactly as a bare UPDATE (both stay
--           SECURITY INVOKER): putting the stamped revision back to a NULL
--           status is its v_restoring (a NULL is not Issued / Locked, so
--           20261185's narrowing never touches it), so it lands wherever the
--           put-back of the stamped status lands (the owner under require;
--           Document Control's forced rollback over a hold, recorded).
--
--   RE-CREATED FROM THE NEWEST BODIES (found by scanning; lineDiff-pinned —
--   every line of each base is kept, the lines added are exactly the P25
--   ones): put_back_retired_issue from 20261165 (P19), restore_reversed_source
--   from 20261164 (P18). Nothing else is created or re-created; the guard is
--   untouched. Grants (DRLS-16), as before: each executable by authenticated
--   only (PUBLIC, anon and service_role revoked), each refusing a call with
--   no session.
--
-- A NARROW WIDENING (DEC-30: inventory before apply): each door now admits a
-- call it refused — a rollback (or a reversal naming its event) with a NULL
-- or blank status — and the recorded door opens for a NULL status. Nothing a
-- bare UPDATE refuses is admitted: the write is the caller's, under the
-- guard; the flag is set only on exactly the conditions it already had.
-- DEC-30 inventory (aggregate counts only, captured BEFORE the transaction):
-- the documents with a current revision whose status is NULL, and blank —
-- a failed supersede / split / merge of one is put back as that from now on;
-- the retirements whose stamp names the current revision with a NULL or
-- blank status — their rollback or reversal puts back that; the recorded
-- split / merge events whose prior status is NULL (the app carrying P25
-- records them); whether each door already took a blank status (a re-paste).
--
-- HOW TO APPLY: the app carrying P25 is deployed FIRST (it puts back what a
-- document was and falls back to today's write while this file is missing —
-- below). Then paste THIS file, BEFORE 20261185 (integrator at the P16 merge,
-- 2026-10-07: 20261185 is held until P25's app is deployed and this file is
-- pasted — this is the "P25's own migration" 20261185's header names). It
-- needs 20261165 and 20261164 (the two functions it re-creates): its first
-- statement refuses to run, changing nothing, without them. Those wait
-- behind 20261159 (paste guide row 119), so this file waits with them. It
-- re-creates neither the guard nor any other function, so it is independent
-- of 20261174, 20261182 and 20261185 otherwise (pasted after 20261185 it
-- works the same). ⚠ Never re-paste 20261165 or 20261164 after this file:
-- each would bring back the blank-status refusal on every door (and the app
-- would then put a NULL-status document back as 'Issued' again, its
-- fallback — which 20261185 refuses where the rule binds).
--
-- THE APP BEFORE AND AFTER THIS PASTE (each fails closed; nothing the guard
-- refuses is admitted):
--   - Before (20261165 / 20261164 bodies): the app carrying P25 asks for a
--     NULL put-back, meets the old blank-status refusal (raised before any
--     write) and takes today's path — it puts the document back as 'Issued',
--     exactly as before P25 (lib/revisions.ts putBackRetiredIssue's
--     olderBodyStatus; reverse.ts restoreStatus). A reversal of an empty-
--     status source (recorded '' by the split) is refused with a sentence
--     naming this update, nothing changed (before P25 the reversal asked
--     Document Control to name a status; vanishingly rare: no editor or
--     import writes an empty status).
--   - With no function at all (a database before 20261165 / 20261164): the
--     app's direct write puts back the NULL; the guard there judges it as it
--     judged 'Issued'.
--   - After: a NULL-status document's rollback and reversal put it back as
--     NULL — what it was, not in force — wherever the put-back of the
--     stamped status lands.
-- Single paste: prerequisite check → temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the bases) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'put_back_retired_issue' AND pronargs = 9
                  AND prosrc LIKE '%put_back_retired_issue: name the status to put the document back to.%'
                  AND prosrc LIKE '%IF COALESCE(p_force_hold, false)%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'restore_reversed_source' AND pronargs = 4
                     AND prosrc LIKE '%restore_reversed_source: name the status to restore the document to.%') THEN
    RAISE EXCEPTION '20261192 needs 20261165 (put_back_retired_issue) and 20261164 (restore_reversed_source) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_192_before;
CREATE TEMP TABLE dc_round_f_192_before AS
SELECT 'inventory (before apply): documents with a current revision whose status is NULL — a failed supersede / split / merge of one is put back as NULL (what it was, not in force) from now on, never as ''Issued'' (REV-29)' AS inventory,
       COUNT(*)::text AS n
  FROM documents d
 WHERE d.current_version_id IS NOT NULL AND d.status IS NULL
UNION ALL
SELECT 'inventory (before apply): documents with a current revision whose status is blank (empty or spaces) — put back as that from now on; their rollback was refused before (REV-29)',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL AND d.status IS NOT NULL AND btrim(d.status) = ''
UNION ALL
SELECT 'inventory (before apply): retired documents (Superseded / Archived / Void) whose retirement stamp names their current revision with a NULL or blank status — a rollback or reversal of one puts back that status from now on (the un-archive door still restores a named status)',
       COUNT(*)::text
  FROM documents d
 WHERE d.status IN ('Superseded', 'Archived', 'Void')
   AND d.retired_issue_version_id IS NOT NULL
   AND d.retired_issue_version_id = d.current_version_id
   AND btrim(COALESCE(d.retired_issue_status, '')) = ''
UNION ALL
SELECT 'inventory (before apply): recorded split / merge events whose source''s prior status is recorded NULL or blank (the app carrying P25 records a NULL as NULL; before P25 it recorded ''Issued'') — their reversal restores that status from now on',
       COUNT(*)::text
  FROM audit_logs a
 WHERE a.action IN ('DOC_SPLIT', 'DOC_MERGED')
   AND ((a.details ? 'priorStatus' AND (jsonb_typeof(a.details->'priorStatus') = 'null' OR btrim(COALESCE(a.details->>'priorStatus', 'x')) = ''))
        OR (jsonb_typeof(a.details->'priorStatuses') = 'object'
            AND EXISTS (SELECT 1 FROM jsonb_each(a.details->'priorStatuses') e
                         WHERE jsonb_typeof(e.value) = 'null' OR btrim(COALESCE(e.value #>> '{}', 'x')) = '')))
UNION ALL
SELECT 'inventory (before apply): the doors already take a blank status for a rollback / a reversal naming its event (2 = this file was pasted before; 0 = this paste opens them)',
       ((SELECT COUNT(*) FROM pg_proc WHERE proname = 'put_back_retired_issue' AND prosrc LIKE '%IF p_via = ''unarchive'' THEN%IF btrim(COALESCE(p_status, '''')) = '''' THEN%')
        + (SELECT COUNT(*) FROM pg_proc WHERE proname = 'restore_reversed_source' AND prosrc LIKE '%IF p_reversal_of IS NULL THEN%IF btrim(COALESCE(p_status, '''')) = '''' THEN%'))::text;

BEGIN;

-- ── 1. REV-29: put_back_retired_issue — 20261165 body + the P25 lines ──────
-- SECURITY INVOKER, as before: every read and the write run as the caller,
-- under their row-level policies and trg_document_publish_guard.
CREATE OR REPLACE FUNCTION put_back_retired_issue(
  p_document_id uuid,
  p_status text,
  p_via text,
  p_reason text DEFAULT NULL,
  p_force_hold boolean DEFAULT false,
  p_superseded_at timestamptz DEFAULT NULL,
  p_superseded_by_user uuid DEFAULT NULL,
  p_supersession_reason text DEFAULT NULL,
  p_supersession_moc text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_found   boolean;
  v_org     uuid;
  v_status  text;
  v_stamp   text;
  v_stamped uuid;
  v_version uuid;
  v_rev     text;
  v_retired_by uuid;
  v_forced  boolean := false;
  v_n       integer;
BEGIN
  -- DRLS-16: a signed-in act only. A call with no session (anon, or the
  -- service role, whose writes this guard never judges) never sets the flag.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'put_back_retired_issue: a put-back is a signed-in act, and this call has no session.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('unarchive', 'supersede_rollback', 'lifecycle_rollback', 'reversal_rollback') THEN
    RAISE EXCEPTION 'put_back_retired_issue: name the put-back (unarchive, supersede_rollback, lifecycle_rollback or reversal_rollback).'
      USING ERRCODE = 'check_violation';
  END IF;
  -- REV-29 (document-control Round F wave 3, P25): a rollback puts back what
  -- the document WAS, and a document can have had no status (NULL) or an
  -- empty one. The failed supersede / split / merge / reversal of such a
  -- document is put back as that — never as 'Issued', which put it in force
  -- unreviewed and, since 20261185, is judged as a first entry into force.
  -- So the blank-status refusal just below (20261165's, unchanged) binds the
  -- un-archive door only — the un-archive dialog restores a status it names;
  -- the three rollback doors take a NULL or blank status. The guard decides
  -- that write exactly as any other: a NULL status is an issue status to it
  -- (is_controlled_issue_status), and putting the stamped revision back is
  -- its v_restoring.
  IF p_via = 'unarchive' THEN
  IF btrim(COALESCE(p_status, '')) = '' THEN
    RAISE EXCEPTION 'put_back_retired_issue: name the status to put the document back to.'
      USING ERRCODE = 'check_violation';
  END IF;
  END IF;

  -- The document, as the caller sees it.
  SELECT true, d.org_id, d.status, d.retired_issue_status, d.retired_issue_version_id, d.current_version_id, d.rev, d.superseded_by_user
    INTO v_found, v_org, v_status, v_stamp, v_stamped, v_version, v_rev, v_retired_by
    FROM documents d WHERE d.id = p_document_id;
  IF v_found IS NULL THEN
    RETURN 'no_match';
  END IF;

  -- The recorded door: exactly the write the guard refuses bare since this
  -- migration — Document Control (the session's tier, as the guard reads
  -- it) putting back, into an issue status, the revision a stamped
  -- retirement took away (the stamp names the current revision, and this
  -- write moves no pointer: v_restoring), out of the retirement this door
  -- leaves (Archived for the un-archive, Superseded for the rollbacks),
  -- while a hold stands — and only when the caller asks for the force
  -- (p_force_hold: an override over a hold is chosen, never implied — the
  -- un-archive dialog sends it only after Document Control confirmed
  -- restoring over the holds it showed; the rollbacks send it) and, for a
  -- rollback, only for a retirement the caller made (superseded_by_user =
  -- the session: the supersede, the split / merge saga and the reversal's
  -- park all write their actor there, so a 'rollback' in the record is one
  -- the caller's own retirement can be). The issue test is a superset of
  -- is_controlled_issue_status (whose EXECUTE no client role holds — this
  -- function runs as the caller): it trims spaces only, so a status the
  -- predicate calls an issue is always one here; a status padded with other
  -- whitespace could only record a pass the guard did not need. Anything
  -- else is the bare write below, judged by the guard as before.
  IF COALESCE(p_force_hold, false)
     AND v_status = (CASE WHEN p_via = 'unarchive' THEN 'Archived' ELSE 'Superseded' END)
     AND (p_via = 'unarchive' OR v_retired_by = v_uid)
     AND v_stamped IS NOT NULL
     AND v_stamped = v_version
     AND btrim(p_status) NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')
     AND is_org_controller(v_org)
     AND EXISTS (SELECT 1 FROM document_holds h
                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN
    v_forced := true;
  END IF;

  -- REV-29 (P25): the recorded door for a NULL status. A NULL is an issue
  -- status to the guard, but btrim(p_status) NOT IN (...) just above is
  -- NULL for it, so the door never opened: Document Control's forced
  -- rollback of a held NULL-status document — the put-back of what it was —
  -- was the bare write, refused over the hold (REV-23's limb). It opens for
  -- a NULL exactly as for any other status a rollback puts the stamped
  -- revision back to: the same conditions, on a rollback door only.
  IF NOT v_forced
     AND p_status IS NULL
     AND p_via <> 'unarchive'
     AND COALESCE(p_force_hold, false)
     AND v_status = 'Superseded'
     AND v_retired_by = v_uid
     AND v_stamped IS NOT NULL
     AND v_stamped = v_version
     AND is_org_controller(v_org)
     AND EXISTS (SELECT 1 FROM document_holds h
                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN
    v_forced := true;
  END IF;

  -- The put-back: the app's own write for this door, as the caller. The
  -- flag names this document for this one statement only.
  IF v_forced THEN
    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);
  END IF;
  IF p_via = 'unarchive' THEN
    UPDATE documents
       SET status = p_status,
           archived_at = NULL,
           archived_by = NULL,
           archive_reason = NULL,
           updated_at = now(),
           updated_by = v_uid
     WHERE id = p_document_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    UPDATE documents
       SET status = p_status,
           superseded_at = p_superseded_at,
           superseded_by_user = p_superseded_by_user,
           supersession_reason = p_supersession_reason,
           supersession_moc = p_supersession_moc,
           updated_at = now(),
           updated_by = v_uid
     WHERE id = p_document_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  IF v_forced THEN
    PERFORM set_config('app.publish_hold_override', '', true);
  END IF;
  IF v_n = 0 THEN
    RETURN 'no_match';
  END IF;

  -- The pass over the hold is on the document's record in the same
  -- transaction — a record that cannot be written rolls the put-back back
  -- with it. Written as the caller: audit_logs' insert policy admits the
  -- session's own row in its own org.
  IF v_forced THEN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,
            (SELECT m.email FROM org_members m WHERE m.org_id = v_org AND m.uid = v_uid LIMIT 1),
            jsonb_build_object(
              'via', p_via,
              'holds', (SELECT jsonb_agg(jsonb_build_object('id', h.id, 'reason', h.reason) ORDER BY h.opened_at)
                          FROM document_holds h
                         WHERE h.document_id = p_document_id AND h.released_at IS NULL),
              'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),
              'stampedPutBack', true,
              'retiredIssueStatus', v_stamp,
              'versionId', v_version,
              'revisionLabel', v_rev,
              'priorStatus', v_status,
              'newStatus', p_status,
              'branch', false
            ));
  END IF;

  RETURN CASE WHEN v_forced THEN 'restored_over_hold' ELSE 'restored' END;
END;
$$;
COMMENT ON FUNCTION put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text) IS
  'REV-23 (20261165); REV-29 (20261192): the app''s put-back of a stamped retirement — the un-archive (lib/revisions.ts unarchiveDocument, p_via unarchive) and the rollbacks of a failed supersede, split / merge or reversal (undoFailedSupersede, restoreSupersededSource, the reversal''s putStatusBack; supersede_rollback, lifecycle_rollback, reversal_rollback), each writing the app''s own fields. A rollback door puts back what the document WAS, a NULL or blank status included (REV-29); the un-archive door refuses a blank status. SECURITY INVOKER: the caller''s row-level policies and trg_document_publish_guard decide the write exactly as for a bare UPDATE. For Document Control asking for the force (p_force_hold: the un-archive dialog after an explicit confirmation over the holds it showed; the rollbacks) and putting back the revision a stamped retirement took away, out of that door''s retirement (for a rollback, a retirement the caller made: superseded_by_user = the session), while a hold is active, the write runs under the transaction-local flag app.publish_hold_override and the pass is recorded as REV_HOLD_OVERRIDDEN in the same transaction. Returns restored_over_hold (that recorded pass), restored (the bare write) or no_match; refuses a call with no session.';
-- DRLS-16: authenticated only, as before (the body refuses a NULL uid too).
REVOKE ALL ON FUNCTION put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text) TO authenticated;

-- ── 2. REV-29: restore_reversed_source — 20261164 body + the P25 lines ─────
CREATE OR REPLACE FUNCTION restore_reversed_source(
  p_document_id uuid,
  p_status text,
  p_reversal_of uuid,
  p_reason text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_found   boolean;
  v_org     uuid;
  v_status  text;
  v_stamp   text;
  v_version uuid;
  v_rev     text;
  v_action  text;
  v_forced  boolean := false;
  v_n       integer;
BEGIN
  -- DRLS-16: a signed-in act only. A call with no session (anon, or the
  -- service role, whose writes this guard never judges) never sets the flag.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'restore_reversed_source: a reversal''s restore is a signed-in act, and this call has no session.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- REV-29 (document-control Round F wave 3, P25): the reversal restores the
  -- status the split / merge recorded for its source, and since P25 a source
  -- that had no status (NULL) or an empty one is recorded so — restored as
  -- that, never guessed as 'Issued' (which put it in force, unreviewed). So a
  -- call that names the reversed event (the reversal's door: every call the
  -- app makes) takes a NULL or blank status; the blank-status refusal just
  -- below (20261164's, unchanged) binds a call that names none. The guard
  -- decides the write as before, and the recorded door below reads no
  -- status, so it opens for a NULL exactly as for any other.
  IF p_reversal_of IS NULL THEN
  IF btrim(COALESCE(p_status, '')) = '' THEN
    RAISE EXCEPTION 'restore_reversed_source: name the status to restore the document to.'
      USING ERRCODE = 'check_violation';
  END IF;
  END IF;

  -- The document, as the caller sees it.
  SELECT true, d.org_id, d.status, d.retired_issue_status, d.current_version_id, d.rev
    INTO v_found, v_org, v_status, v_stamp, v_version, v_rev
    FROM documents d WHERE d.id = p_document_id;
  IF v_found IS NULL THEN
    RETURN 'no_match';
  END IF;

  -- The recorded door: Document Control (the session's tier, as the guard
  -- reads it), putting back a Superseded document that is the source of the
  -- recorded split / merge it names, while a hold stands — the legacy
  -- reversal's put-back over the hold HLD-2 carried onto it. Anything else
  -- is the bare write below, judged by the guard as before. An event a
  -- recorded reversal has already undone opens nothing: every reversal the
  -- app has written (DOC_SPLIT_REVERSED / DOC_MERGE_REVERSED) is on the
  -- event's own resource and names it as reversedAuditEventId, and it is
  -- written only once that reversal's saga has landed — so the reversal
  -- being run is never one of them. Both rows are read under the same
  -- audit_logs policy. The reversal's id is compared as the uuid it names —
  -- lower-cased, without the braces and hyphens the uuid type also accepts —
  -- so a reversal recorded with the caller's own spelling of the id (upper
  -- case, braces: the app wrote the id it was given until P18's integrator
  -- fix, which writes the database's own) is seen too.
  SELECT a.action INTO v_action
    FROM audit_logs a
   WHERE a.id = p_reversal_of
     AND a.org_id = v_org
     AND a.action IN ('DOC_SPLIT', 'DOC_MERGED')
     AND (a.resource_id = p_document_id::text
          OR COALESCE(jsonb_typeof(a.details->'mergeSiblings') = 'array'
                      AND (a.details->'mergeSiblings') ? p_document_id::text, false))
     AND NOT EXISTS (SELECT 1 FROM audit_logs r
                      WHERE r.org_id = v_org
                        AND r.resource_id = a.resource_id
                        AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')
                        AND translate(lower(r.details->>'reversedAuditEventId'), '{}-', '') = replace(p_reversal_of::text, '-', ''))
   LIMIT 1;
  IF v_status = 'Superseded'
     AND v_action IS NOT NULL
     AND is_org_controller(v_org)
     AND EXISTS (SELECT 1 FROM document_holds h
                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN
    v_forced := true;
  END IF;

  -- The put-back: restoreStatus's own write, as the caller. The flag names
  -- this document for this one statement only.
  IF v_forced THEN
    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);
  END IF;
  UPDATE documents
     SET status = p_status,
         superseded_at = NULL,
         superseded_by_user = NULL,
         supersession_reason = NULL,
         supersession_moc = NULL,
         updated_at = now(),
         updated_by = v_uid
   WHERE id = p_document_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_forced THEN
    PERFORM set_config('app.publish_hold_override', '', true);
  END IF;
  IF v_n = 0 THEN
    RETURN 'no_match';
  END IF;

  -- The pass over the hold is on the document's record in the same
  -- transaction — a record that cannot be written rolls the put-back back
  -- with it. Written as the caller: audit_logs' insert policy admits the
  -- session's own row in its own org.
  IF v_forced THEN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, v_uid,
            (SELECT m.email FROM org_members m WHERE m.org_id = v_org AND m.uid = v_uid LIMIT 1),
            jsonb_build_object(
              'via', 'reversal_restore',
              'holds', (SELECT jsonb_agg(jsonb_build_object('id', h.id, 'reason', h.reason) ORDER BY h.opened_at)
                          FROM document_holds h
                         WHERE h.document_id = p_document_id AND h.released_at IS NULL),
              'reason', NULLIF(btrim(COALESCE(p_reason, '')), ''),
              'reversedAuditEventId', p_reversal_of,
              'reversedAction', v_action,
              'retirementStamped', v_stamp IS NOT NULL,
              'versionId', v_version,
              'revisionLabel', v_rev,
              'priorStatus', v_status,
              'newStatus', p_status,
              'branch', false
            ));
  END IF;

  -- The answer says whether the pass over a hold was recorded: the reversal
  -- writes the correction (REV_HOLD_OVERRIDE_UNDONE) beside that record if
  -- its saga then rolls this put-back back.
  RETURN CASE WHEN v_forced THEN 'restored_over_hold' ELSE 'restored' END;
END;
$$;
COMMENT ON FUNCTION restore_reversed_source(uuid, text, uuid, text) IS
  'REV-22 (20261164); REV-29 (20261192): the legacy reversal''s put-back of a split / merge source (lib/documentLifecycle/reverse.ts restoreStatus), to the status the event recorded for it — a NULL or blank one included (REV-29) when the call names the reversed event. SECURITY INVOKER: the caller''s row-level policies and trg_document_publish_guard decide the write exactly as for a bare UPDATE. For Document Control putting back a Superseded source of the recorded DOC_SPLIT / DOC_MERGED named by p_reversal_of, which no recorded reversal has undone, while a hold is active, the write runs under the transaction-local flag app.publish_hold_override and the pass is recorded as REV_HOLD_OVERRIDDEN in the same transaction. Returns restored_over_hold (that recorded pass), restored (the bare write) or no_match; refuses a call with no session.';
-- DRLS-16: authenticated only, as before (the body refuses a NULL uid too).
REVOKE ALL ON FUNCTION restore_reversed_source(uuid, text, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION restore_reversed_source(uuid, text, uuid, text) TO authenticated;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 6. Inventory rows: n = the aggregate count.
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here).
SELECT 'REV-29 (P25): put_back_retired_issue refuses a blank status for the un-archive door only — the three rollback doors put back a NULL or blank status (what the document was)' AS check,
       (SELECT prosrc LIKE '%p_via NOT IN (%IF p_via = ''unarchive'' THEN%IF btrim(COALESCE(p_status, '''')) = '''' THEN%RAISE EXCEPTION ''put_back_retired_issue: name the status to put the document back to.''%END IF;%END IF;%SELECT true, d.org_id%'
          FROM pg_proc WHERE proname = 'put_back_retired_issue') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'REV-29 (P25): put_back_retired_issue''s recorded door opens for a NULL status on a rollback door exactly as for any other (Document Control, the force asked, the caller''s own Superseded retirement, the stamp naming the current revision, an active hold) — after the 20261165 door, before the write',
       (SELECT prosrc LIKE '%IF COALESCE(p_force_hold, false)%v_forced := true;%END IF;%IF NOT v_forced%AND p_status IS NULL%AND p_via <> ''unarchive''%AND COALESCE(p_force_hold, false)%AND v_status = ''Superseded''%AND v_retired_by = v_uid%AND v_stamped IS NOT NULL%AND v_stamped = v_version%AND is_org_controller(v_org)%AND EXISTS (SELECT 1 FROM document_holds h%v_forced := true;%END IF;%IF v_forced THEN%PERFORM set_config(''app.publish_hold_override'', p_document_id%'
          FROM pg_proc WHERE proname = 'put_back_retired_issue'),
       NULL
UNION ALL
SELECT 'REV-23 (P19) survives the re-create: put_back_retired_issue refuses a call with no session, opens its recorded door on the same conditions, sets the flag only around its own write, records REV_HOLD_OVERRIDDEN, writes no pointer',
       (SELECT prosrc LIKE '%IF v_uid IS NULL THEN%RAISE EXCEPTION%'
           AND prosrc LIKE '%IF COALESCE(p_force_hold, false)%AND v_status = (CASE WHEN p_via = ''unarchive'' THEN ''Archived'' ELSE ''Superseded'' END)%AND (p_via = ''unarchive'' OR v_retired_by = v_uid)%AND v_stamped IS NOT NULL%AND v_stamped = v_version%AND btrim(p_status) NOT IN (''Draft'', ''In Review'', ''Superseded'', ''Void'', ''Archived'')%AND is_org_controller(v_org)%AND EXISTS (SELECT 1 FROM document_holds h%v_forced := true;%'
           AND prosrc LIKE '%PERFORM set_config(''app.publish_hold_override'', p_document_id%IF p_via = ''unarchive'' THEN%UPDATE documents%ELSE%UPDATE documents%END IF;%PERFORM set_config(''app.publish_hold_override'', '''', true);%'
           AND prosrc LIKE '%VALUES (''REV_HOLD_OVERRIDDEN''%''via'', p_via%''stampedPutBack'', true%'
           AND prosrc LIKE '%RETURN CASE WHEN v_forced THEN ''restored_over_hold'' ELSE ''restored'' END;%'
           AND prosrc NOT LIKE '%current_version_id =%'
          FROM pg_proc WHERE proname = 'put_back_retired_issue'),
       NULL
UNION ALL
SELECT 'REV-29 (P25): restore_reversed_source refuses a blank status only for a call naming no reversed event — the reversal''s door restores a NULL or blank recorded status; REV-22 (P18) survives (the session check, the recorded door, the flag, REV_HOLD_OVERRIDDEN, no pointer write)',
       (SELECT prosrc LIKE '%IF p_reversal_of IS NULL THEN%IF btrim(COALESCE(p_status, '''')) = '''' THEN%RAISE EXCEPTION ''restore_reversed_source: name the status to restore the document to.''%END IF;%END IF;%SELECT true, d.org_id%'
           AND prosrc LIKE '%IF v_uid IS NULL THEN%RAISE EXCEPTION%'
           AND prosrc LIKE '%IF v_status = ''Superseded''%AND v_action IS NOT NULL%AND is_org_controller(v_org)%PERFORM set_config(''app.publish_hold_override'', p_document_id%VALUES (''REV_HOLD_OVERRIDDEN''%''via'', ''reversal_restore''%RETURN CASE WHEN v_forced THEN ''restored_over_hold'' ELSE ''restored'' END;%'
           AND prosrc NOT LIKE '%current_version_id =%'
          FROM pg_proc WHERE proname = 'restore_reversed_source'),
       NULL
UNION ALL
SELECT 'DRLS-16: each runs as the CALLER (SECURITY INVOKER, search_path pinned), one signature each (9 and 4 arguments); authenticated may execute each, PUBLIC, anon and service_role may not',
       (SELECT COUNT(*) FROM pg_proc WHERE proname = 'put_back_retired_issue') = 1
       AND (SELECT COUNT(*) FROM pg_proc WHERE proname = 'restore_reversed_source') = 1
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'put_back_retired_issue' AND p.pronargs = 9
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.proacl IS NOT NULL)
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'restore_reversed_source' AND p.pronargs = 4
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.proacl IS NOT NULL)
       AND has_function_privilege('authenticated', 'put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text)', 'EXECUTE')
       AND NOT has_function_privilege('service_role', 'put_back_retired_issue(uuid, text, text, text, boolean, timestamptz, uuid, text, text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('service_role', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                        WHERE p.proname IN ('put_back_retired_issue', 'restore_reversed_source')
                          AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'the publish guard is untouched by this file — it still reads the flag the two doors set (REV-23''s v_restoring limb and REV-22''s unstamped Superseded limb)',
       (SELECT prosrc LIKE '%OR COALESCE(v_restoring%AND current_setting(''app.publish_hold_override'', true) IS DISTINCT FROM NEW.id%'
           AND prosrc LIKE '%AND OLD.status = ''Superseded''%AND OLD.retired_issue_status IS NULL%AND current_setting(''app.publish_hold_override'', true) IS DISTINCT FROM NEW.id%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_192_before;
