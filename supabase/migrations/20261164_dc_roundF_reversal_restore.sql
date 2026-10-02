-- ─────────────────────────────────────────────────────────────────────────────
-- 20261164_dc_roundF_reversal_restore.sql
--
-- document-control Round F wave 3 — P18 RECORDED REVERSAL RESTORE: the
-- legacy reversal puts its source back through a recorded door, so the
-- publish guard binds a held Superseded exit (REV-22, done-when 2).
--
--   REV-22  REV-20 (a) (20261151) judges the exit of an UNSTAMPED Archived /
--           Void retirement into an issue status as a status-only issue, so
--           its hold binds a controller too, but it SPARED an unstamped
--           Superseded document (superseded before 20261144, or by the
--           service role): that exit is how the legacy reversal
--           (lib/documentLifecycle/reverse.ts reverseSplit / reverseMerge →
--           restoreStatus) puts a split / merge source back over the hold
--           HLD-2 carries onto it first, and the put-back was a bare
--           PostgREST UPDATE that could carry no transaction-local flag —
--           so a controller's bare un-supersede of a held, unstamped
--           Superseded document passed the hold too, unrecorded. Now:
--           (1) restore_reversed_source (new; SECURITY INVOKER — every read
--               and the write run as the caller, under their row-level
--               policies and this guard) is the reversal's put-back: the
--               same status write restoreStatus made (status, the four
--               supersession fields cleared, updated_at / updated_by), and,
--               when the caller is Document Control (is_org_controller), the
--               document is Superseded, the audit row it names is the
--               recorded DOC_SPLIT / DOC_MERGED of which it is the source (the
--               event's resource, or one of a merge's mergeSiblings) that no
--               recorded reversal has undone yet (no DOC_SPLIT_REVERSED /
--               DOC_MERGE_REVERSED names it) and an active hold stands, it
--               sets the transaction-local flag app.publish_hold_override to
--               the document's id immediately before that write and clears
--               it immediately after, and records the pass in the same
--               transaction — REV_HOLD_OVERRIDDEN (via reversal_restore; the
--               holds, the reversal's reason, the reversed event, the status
--               restored), as publish_revision's and
--               finalize_reviewed_promote's recorded forces do — and answers
--               restored_over_hold, so the reversal writes the correction
--               (REV_HOLD_OVERRIDE_UNDONE) if its saga later rolls the
--               put-back back. Anyone else's call is exactly the bare write
--               (no flag, no record; it answers restored);
--           (2) enforce_document_publish_guard binds the unstamped Superseded
--               exit too: a controller's write taking an unstamped Superseded
--               document into an issue status, its pointer unmoved, WITHOUT
--               the flag naming that document, is the new door — refused
--               over an active hold for a controller too ("Document has an
--               active hold; release the hold before issuing it." — the
--               sentence the status editors and the un-archive dialog already
--               recognise). Below a controller nothing changes (the publisher
--               tier's own hold check refuses it, in its own words); the
--               stamped put-back (v_restoring) and a Draft restore keep their
--               rules.
--           DECIDED (the record's two alternatives): the recorded door, not a
--           backfill of the retirement stamp for the recorded split / merge
--           sources. A backfill cannot name what a legacy event never
--           recorded — a split / merge recorded before prior statuses were
--           captured carries no priorStatus (the reverse dialog has the
--           controller NAME one, REV-16), and no DOC_SPLIT / DOC_MERGED
--           carries the revision it retired (versionId ""), which
--           retired_issue_version_id must name — so binding "the rest" would
--           strand exactly those reversals; a backfilled stamp would make the
--           put-back v_restoring, which still passes a controller over a hold
--           UNRECORDED; and the stamp is written only by this guard, which a
--           data backfill would break.
--
--   RE-CREATED FROM THE NEWEST BODY (found by scanning; lineDiff-pinned —
--   every line of the base is kept, the lines added are exactly the P18
--   block): enforce_document_publish_guard from 20261159 (P17) — REV-22 limb
--   1 (the held pointer move), RG-14 (the owner slot), REV-20's rules and
--   20261144's all kept. Nothing else is re-created: restore_reversed_source
--   is new. Grants (DRLS-16): the guard executable by no client role; the
--   restore by authenticated only (PUBLIC, anon and service_role revoked) and
--   it refuses a NULL auth.uid() outright — the flag is never set without a
--   session.
--
-- NOT a widening: the guard refuses a write it admitted (a controller's bare
-- un-supersede of a held, unstamped Superseded document into an issue); the
-- restore admits nothing a bare write did not (its only addition is the flag,
-- which the guard reads only where a bare write was admitted before this
-- paste), and records what passed unrecorded. DEC-30 inventories (aggregate
-- counts only, captured BEFORE the transaction): the unstamped Superseded
-- documents with a current revision; those of them under an active hold now;
-- those held ones that are the source of a recorded split / merge no
-- recorded reversal has undone (the reversal restores them through the
-- recorded door) and those that are not (their exit into an issue now needs
-- the hold released, Document Control included); the unstamped Superseded
-- sources of such a split / merge in all; whether restore_reversed_source
-- already existed.
-- HOW TO APPLY: AFTER 20261159 (required — this re-creates 20261159's guard,
-- and the first statement refuses to run, changing nothing, without it; so
-- after 20261151, 20261144, 20261130 and 20261070 too). 20261159 is itself
-- HELD (paste guide row 119): it waits until projects-and-cost INTK-18's
-- intake force is deployed or the user ratifies DEC-63's P17 Landed line —
-- this file waits with it. ⚠ Never re-paste 20261159, 20261151, 20261144,
-- 20261139, 20261105 or any earlier guard migration after this one: each
-- would drop this rule (and an earlier one the REV-22 limb 1, RG-14 and
-- REV-20 rules). P16 (REV-21) re-creates this guard next, from this body.
-- ⚠ DEPLOY FIRST: deploy the app carrying P18 (restoreStatus calls
-- restore_reversed_source, and keeps today's bare write while the function
-- is absent — PGRST202 / 42883), THEN paste. An app before P18 restores with
-- the bare write, which this guard refuses over a carried hold: its legacy
-- reversal over a held parked document would roll back whole until the app
-- is deployed. (Right after the paste, while PostgREST reloads its schema
-- cache, the P18 app may still fall back once and be refused the same way;
-- the reversal rolls back whole and a retry goes through.)
-- Single paste: prerequisite check → temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'
                  AND prosrc LIKE '%v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL%') THEN
    RAISE EXCEPTION '20261164 needs 20261159 (the REV-22 publish guard) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_164_before;
CREATE TEMP TABLE dc_round_f_164_before AS
WITH recorded AS (
  -- The sources restore_reversed_source's door can name, computed ONCE — a
  -- set each document is looked up in (hashed), not a scan of audit_logs per
  -- document: a DOC_SPLIT's or DOC_MERGED's resource, or one of a
  -- DOC_MERGED's mergeSiblings, of an event no recorded reversal has undone
  -- (a DOC_SPLIT_REVERSED / DOC_MERGE_REVERSED — written on the event's own
  -- resource — naming it as reversedAuditEventId, in any spelling the uuid
  -- type accepts), as the door reads it.
  SELECT e.org_id, e.source_id
    FROM (SELECT a.org_id, a.id AS event_id, a.resource_id, a.resource_id AS source_id
            FROM audit_logs a
           WHERE a.action IN ('DOC_SPLIT', 'DOC_MERGED')
          UNION ALL
          SELECT a.org_id, a.id, a.resource_id, s.sibling
            FROM audit_logs a
           CROSS JOIN LATERAL jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(a.details->'mergeSiblings') = 'array'
                        THEN a.details->'mergeSiblings' ELSE '[]'::jsonb END) AS s(sibling)
           WHERE a.action = 'DOC_MERGED') e
   WHERE NOT EXISTS (SELECT 1 FROM audit_logs r
                      WHERE r.org_id = e.org_id
                        AND r.resource_id = e.resource_id
                        AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')
                        AND translate(lower(r.details->>'reversedAuditEventId'), '{}-', '') = replace(e.event_id::text, '-', ''))
),
unstamped AS (
  -- Superseded with no retirement stamp and a current revision: retired
  -- before 20261144, or by the service role
  SELECT d.id,
         EXISTS (SELECT 1 FROM document_holds h
                  WHERE h.document_id = d.id AND h.released_at IS NULL) AS held,
         COALESCE((d.org_id, d.id::text) IN (SELECT c.org_id, c.source_id FROM recorded c), false) AS recorded_source
    FROM documents d
   WHERE d.current_version_id IS NOT NULL
     AND d.status = 'Superseded'
     AND d.retired_issue_status IS NULL
)
SELECT 'inventory (before apply): documents in Superseded with no retirement stamp and a current revision (REV-22: Document Control''s bare un-supersede of one into an issue status is judged as a status-only issue from now on — refused while a hold is active)' AS inventory,
       COUNT(*)::text AS n
  FROM unstamped
UNION ALL
SELECT 'inventory (before apply): of those, under an active hold now (their exit into an issue now needs the hold released, Document Control included — unless the legacy reversal restores them through restore_reversed_source, recorded)',
       COUNT(*)::text
  FROM unstamped WHERE held
UNION ALL
SELECT 'inventory (before apply): of those held ones, the source of a recorded split or merge no recorded reversal has undone (a DOC_SPLIT''s resource, a DOC_MERGED''s resource or mergeSiblings — the reversal puts them back over the hold through the recorded door, REV_HOLD_OVERRIDDEN)',
       COUNT(*)::text
  FROM unstamped WHERE held AND recorded_source
UNION ALL
SELECT 'inventory (before apply): of those held ones, NOT the source of a recorded split or merge that is still unreversed (no recorded door: release the hold to bring one back to an issue, or restore it to Draft)',
       COUNT(*)::text
  FROM unstamped WHERE held AND NOT recorded_source
UNION ALL
SELECT 'inventory (before apply): documents in Superseded with no retirement stamp that are the source of a recorded split or merge no recorded reversal has undone (the legacy reversal''s population; each restore now goes through restore_reversed_source)',
       COUNT(*)::text
  FROM unstamped WHERE recorded_source
UNION ALL
SELECT 'inventory (before apply): restore_reversed_source already existed (1) or is created by this paste (0)',
       COUNT(*)::text
  FROM pg_proc WHERE proname = 'restore_reversed_source';

BEGIN;

-- ── 1. REV-22: the reversal's recorded put-back ─────────────────────────────
-- SECURITY INVOKER: every read below and the write run as the caller — their
-- row-level policies (documents_org_access, documents_deny_write_guard,
-- audit_logs' and document_holds' read policies, audit_logs' insert policy)
-- and trg_document_publish_guard apply exactly as to restoreStatus's own
-- UPDATE. Its one addition is the flag around that write, set only for the
-- controller's reversal of a recorded split / merge source over an active
-- hold, and the record of that pass.
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
  IF btrim(COALESCE(p_status, '')) = '' THEN
    RAISE EXCEPTION 'restore_reversed_source: name the status to restore the document to.'
      USING ERRCODE = 'check_violation';
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
  'REV-22 (20261164): the legacy reversal''s put-back of a split / merge source (lib/documentLifecycle/reverse.ts restoreStatus). SECURITY INVOKER: the caller''s row-level policies and trg_document_publish_guard decide the write exactly as for a bare UPDATE. For Document Control putting back a Superseded source of the recorded DOC_SPLIT / DOC_MERGED named by p_reversal_of, which no recorded reversal has undone, while a hold is active, the write runs under the transaction-local flag app.publish_hold_override (the only way the guard admits a controller''s exit of an unstamped Superseded document into an issue over a hold) and the pass is recorded as REV_HOLD_OVERRIDDEN in the same transaction. Returns restored_over_hold (that recorded pass), restored (the bare write) or no_match; refuses a call with no session.';
-- DRLS-16: authenticated only (the app's reversal runs in a signed-in
-- session); the body refuses a NULL uid as well.
REVOKE ALL ON FUNCTION restore_reversed_source(uuid, text, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION restore_reversed_source(uuid, text, uuid, text) TO authenticated;

-- ── 2. REV-22: the publish guard — 20261159 body + the P18 block ────────────
CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor        uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_advancing    boolean;
  v_independent  integer;
  v_on_roster    boolean;
  v_require_ind  boolean;
  v_can_publish  boolean;
  v_has_hold     boolean;
  v_primary_reqs integer;
  v_signed       integer;
  v_review_state text;
  v_change_type  text;
  v_intake_link  uuid;
  v_review_mode  text;
  v_moc          text;
  v_doc_class    text;
  v_issuing      boolean;
  v_new_door     boolean;
  v_issue_reqs   integer;
  v_issue_signed integer;
  v_restoring    boolean;
  v_unforced_issue boolean;
  v_unforced_move boolean;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_advancing :=
       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded')
    -- OWN-15: un-supersede, unarchive and un-void are publish-shaped acts —
    -- the same authority that put the record there takes it back out.
    OR (OLD.status IN ('Superseded', 'Archived', 'Void') AND NEW.status IS DISTINCT FROM OLD.status)
    -- OWN-19: archiving is a lifecycle act of the same shape as supersede —
    -- the publisher tier (controller / granted publisher / effective owner)
    -- retires a record whichever door it leaves by.
    OR (NEW.status = 'Archived' AND COALESCE(OLD.status, '') <> 'Archived');
  -- REV-18 (document-control Round F wave 2, P13): a status change that
  -- makes a document WITH a current revision a controlled issue — out of a
  -- status lib/revisions.ts isControlledIssueStatus does not call an issue
  -- (Draft, In Review, Superseded, Void, Archived) into one it does (Issued,
  -- IFC, a library's own status) — is a guarded write too, whichever door
  -- it comes through: a status edit, or a rev-up / promote that also moves
  -- the pointer. The predicate is is_controlled_issue_status (this
  -- migration; pinned to the app's by test). v_new_door marks the writes
  -- no rule above decided as an issue: a status-only move out of Draft / In
  -- Review into an issue, and (P13 second review fix) a status-only exit
  -- into an issue from a retirement that took away no issue (stamped
  -- 'not-issued' below — Draft -> Void / Archived / Superseded -> Issued).
  -- (v_advancing is NULL for a NULL NEW.status, which the app calls an
  -- issue: COALESCE, so a NULL is no way past the hold.)
  v_issuing := NEW.current_version_id IS NOT NULL
               AND NOT is_controlled_issue_status(OLD.status)
               AND is_controlled_issue_status(NEW.status);
  v_new_door := v_issuing
                AND (NOT COALESCE(v_advancing, false)
                     OR COALESCE(NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')
                                 AND OLD.retired_issue_status = 'not-issued'
                                 AND OLD.retired_issue_version_id IS NULL, false));
  -- REV-20 (document-control Round F wave 3, P14): two writes passed an
  -- active hold for a controller, unrecorded. (a) The exit of an Archived /
  -- Void retirement that carries NO stamp (retired before 20261144, or by
  -- the service role) into an issue status, its pointer unmoved: what that
  -- retirement took away is not known, so the exit is judged as a
  -- status-only issue — the new door, whose hold binds everyone. An
  -- unstamped SUPERSEDED document is spared (P14 review fix): its exit is
  -- the legacy reversal's put-back of a source superseded before 20261144,
  -- over the hold HLD-2 carries onto it first — as a stamped put-back
  -- (v_restoring) passes a controller; the bare un-supersede left open is
  -- REV-22. (b) ONE write that moves the
  -- pointer AND makes the status an issue: a controller passes a hold only
  -- through a recorded force — publish_revision's, or the review promote's
  -- (finalize_reviewed_promote, P14 final review) — each of which sets the
  -- transaction-local flag app.publish_hold_override to this document's id
  -- (20261151) and records REV_HOLD_OVERRIDDEN; a bare UPDATE carries no
  -- flag. Both bind a controller only: below a controller nothing changes —
  -- the publisher tier's own hold check (the last one) still refuses every
  -- advancing write over a hold, in its own words.
  v_new_door := v_new_door
                OR COALESCE(v_issuing
                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
                            AND OLD.status IN ('Archived', 'Void')
                            AND OLD.retired_issue_status IS NULL
                            AND is_org_controller(NEW.org_id), false);
  -- REV-22 (document-control Round F wave 3, P18): REV-20 (a) for the
  -- unstamped SUPERSEDED exit too. The comments in this body that call it
  -- spared (REV-20's above, P17's below) describe this guard before
  -- 20261164: the legacy reversal's put-back of a source superseded before
  -- 20261144 (lib/documentLifecycle/reverse.ts restoreStatus, after HLD-2
  -- carries the parked document's hold onto it) now goes through
  -- restore_reversed_source (20261164), which sets the transaction-local
  -- flag app.publish_hold_override to the source's id around its own status
  -- write — for Document Control only, only for a source of the recorded
  -- split / merge it names that no recorded reversal has undone, only while
  -- a hold is active — and records REV_HOLD_OVERRIDDEN in the same
  -- transaction. So a controller's exit of an UNSTAMPED Superseded document
  -- into an issue status, its pointer unmoved, without that flag naming the
  -- document (a bare un-supersede) is judged as a status-only issue: the new
  -- door, whose hold binds a controller too. Below a controller nothing
  -- changes (the publisher tier's own hold check still refuses it, in its
  -- own words). A STAMPED retirement's put-back (v_restoring, below) keeps
  -- its rule: a controller passes the hold there, unrecorded (OWN-15).
  v_new_door := v_new_door
                OR COALESCE(v_issuing
                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
                            AND OLD.status = 'Superseded'
                            AND OLD.retired_issue_status IS NULL
                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
                            AND is_org_controller(NEW.org_id), false);
  v_unforced_issue := COALESCE(v_issuing
                               AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
                               AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
                               AND is_org_controller(NEW.org_id), false);
  -- REV-22 (document-control Round F wave 3, P17): REV-20 (b)'s recorded-
  -- force rule, for the controller write it left open: one that moves the
  -- pointer of a document ALREADY in an issue status (Issued, IFC, a
  -- library's own) with a current revision. No status becomes an issue, so
  -- v_issuing and v_unforced_issue are false, and a controller passed an
  -- active hold there unrecorded — a bare PATCH of current_version_id, or the
  -- review promote of a held Issued document. Over a hold it now needs the
  -- transaction-local flag naming this document, set only by
  -- publish_revision's controller force and the review promote's
  -- (finalize_reviewed_promote's p_force_hold), each around its own promote
  -- and each recorded (REV_HOLD_OVERRIDDEN); the inspector offers Document
  -- Control the review promote's force when this refuses. A first pointer
  -- write (no current revision yet) is a creation's — REV-17's — not this.
  -- Bound to a controller only, as REV-20's limbs are: below a controller the
  -- publisher tier's own hold check still refuses every pointer move over a
  -- hold. The unstamped Superseded exit REV-20 (a) spares stays spared: its
  -- put-back is the legacy reversal's (lib/documentLifecycle/reverse.ts
  -- restoreStatus), a bare PostgREST write that cannot carry the flag, made
  -- over the hold HLD-2 carries onto the source first — binding it would
  -- refuse that reversal and roll it back (REV-22's other half, open until
  -- that put-back has a recorded door).
  v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL
                              AND NEW.current_version_id IS NOT NULL
                              AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
                              AND is_controlled_issue_status(OLD.status)
                              AND is_controlled_issue_status(NEW.status)
                              AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
                              AND is_org_controller(NEW.org_id), false);
  v_advancing := v_advancing OR v_issuing;
  -- REV-18 (P13 review fix): the retirement stamp. Entering Superseded /
  -- Archived / Void from an ISSUE status stamps what was issued (the status
  -- and the revision); entering one from any other status (a Draft, In
  -- Review, an issue with no revision) stamps 'not-issued' with no revision
  -- (second review fix: nothing issued was taken away, so a status-only
  -- exit into an issue is a new issue under the new-door hold, v_new_door);
  -- moving between those statuses keeps it; any other write clears it. A
  -- caller's own value is overwritten here on every
  -- signed-in UPDATE (and cleared on INSERT, §4), so the stamp says what the
  -- document WAS. v_restoring: this write puts that same revision back into
  -- an issue status — the put-back of the issue its retirement took away (a
  -- failed supersede / split / merge's compensation, an un-archive), not a
  -- new issue — so the require-mode limb below does not decide it; the
  -- publisher tier and the hold check still do (OWN-15).
  v_restoring := COALESCE(v_issuing
                 AND OLD.status IN ('Superseded', 'Archived', 'Void')
                 AND OLD.retired_issue_version_id IS NOT NULL
                 AND NEW.current_version_id = OLD.retired_issue_version_id
                 AND NEW.current_version_id = OLD.current_version_id, false);
  IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN
    IF COALESCE(OLD.status IN ('Superseded', 'Archived', 'Void'), false) THEN
      NEW.retired_issue_status := OLD.retired_issue_status;
      NEW.retired_issue_version_id := OLD.retired_issue_version_id;
    ELSIF OLD.current_version_id IS NOT NULL AND is_controlled_issue_status(OLD.status) THEN
      NEW.retired_issue_status := OLD.status;
      NEW.retired_issue_version_id := OLD.current_version_id;
    ELSE
      NEW.retired_issue_status := 'not-issued';
      NEW.retired_issue_version_id := NULL;
    END IF;
  ELSE
    NEW.retired_issue_status := NULL;
    NEW.retired_issue_version_id := NULL;
  END IF;
  IF NOT v_advancing THEN
    RETURN NEW;
  END IF;

  -- Review gate (applies to ALL authenticated publishers, including Admin/DocCtrl):
  -- if the version being made current has a reviewer roster, every required sign-
  -- off must be in — and a sign-off only counts when it carries the reviewer's
  -- OWN e-signature for this draft (RG-1: a row born 'signed' is not an approval).
  IF NEW.current_version_id IS NOT NULL
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    -- The version match tolerates a NULL on the SIGNATURE side only: legacy
    -- signatures predate the column being stamped, and the only ways to MINT
    -- a signed row now (rail 1 + rail 2) both require a strict match — so
    -- the tolerant branch is reachable only for pre-existing history.
    -- RG-4 / DRLS-6: completion is PER SLOT. Every primary row is a slot in
    -- its slot_group; a slot is filled by its own primary's bound signature
    -- or by the bound signature of an ACTIVATED alternate of the same group
    -- (one signature fills one slot). Primaries count in every status; a
    -- standby alternate, or one with no group and no primary, fills nothing.
    -- Rows without a group (pre-20261070) share one legacy group.
    SELECT COALESCE(sum(g.reqs), 0), COALESCE(sum(LEAST(g.reqs, g.filled)), 0)
      INTO v_primary_reqs, v_signed
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
    IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs THEN
      RAISE EXCEPTION
        'This revision still has outstanding review sign-offs; complete the review before publishing.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- RG-14 (document-control Round F wave 3, P17): the owner-must-approve
    -- rule at the database. Each roster row carries the rule its roster was
    -- opened under (opened_owner_slot — written by
    -- trg_review_signoff_owner_stamp as the row is inserted, never by a
    -- signed-in client, never changed after): 'owner:<uid>' when the
    -- effective policy set ownerMustApprove and the effective owner must
    -- approve (GAP-4's placeOwnerSlot, 'rostered'). Such a roster completes
    -- only when that slot group is filled by THAT owner's own bound
    -- signature — whether or not the owner's row was ever written (a roster
    -- opened through PostgREST without it). 'none', 'no_owner' and 'author'
    -- (the app's other outcomes: no rule, no active owner, an owner who
    -- authored the revision — DEC-21) and an unstamped roster (opened before
    -- 20261159: never retrofitted) need nothing beyond the per-slot count.
    IF EXISTS (
         SELECT 1 FROM document_review_signoffs o
          WHERE o.document_version_id = NEW.current_version_id
            AND o.opened_owner_slot LIKE 'owner:%'
            AND NOT EXISTS (
              SELECT 1 FROM document_review_signoffs s
               WHERE s.document_version_id = NEW.current_version_id
                 AND s.slot_group = o.opened_owner_slot
                 AND 'owner:' || s.reviewer_user_id::text = o.opened_owner_slot
                 AND s.status = 'signed'
                 AND s.signature_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM e_signatures e
                   WHERE e.id = s.signature_id
                     AND e.signer_user_id = s.reviewer_user_id
                     AND e.org_id = s.org_id
                     AND (e.document_version_id = s.document_version_id
                          OR e.document_version_id IS NULL)
                 ))
       ) THEN
      RAISE EXCEPTION
        'This revision''s review was opened under a policy that requires the document owner''s approval, and the owner has not signed it; resubmit it for review so the owner is on its roster.'
        USING ERRCODE = 'check_violation';
    END IF;

    -- RG-7: an absent roster is not "no gate". A draft SUBMITTED for review
    -- (review_state 'in_review', not an external intake submission) with no
    -- primary slot was never reviewed; and a direct non-Minor revision of a
    -- controlled document whose EFFECTIVE policy requires review — resolved
    -- along the same container chain the app walks — may not skip the gate
    -- by never opening a roster. Minor / Correction is the declared escape
    -- hatch; publisher_choice is the publisher's call; a document's first
    -- controlled revision is not a revision through the gate.
    IF COALESCE(v_primary_reqs, 0) = 0 THEN
      SELECT v.review_state, v.change_type, v.intake_link_id
        INTO v_review_state, v_change_type, v_intake_link
        FROM document_versions v WHERE v.id = NEW.current_version_id;
      IF v_review_state = 'in_review' AND v_intake_link IS NULL THEN
        RAISE EXCEPTION
          'This draft was submitted for review but has no reviewer roster; set the reviewers and resubmit it before publishing.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.current_version_id IS NOT NULL AND v_intake_link IS NULL
         AND COALESCE(v_change_type, '') NOT IN ('Minor', 'Correction') THEN
        v_review_mode := review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id);
        IF v_review_mode = 'require' THEN
          RAISE EXCEPTION
            'This library requires reviewer sign-off for a Major revision; submit it for review instead of publishing directly.'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      -- REV-17 (document-control Round F wave 2, P12): a document's FIRST
      -- issue is no exception for anyone but a controller. A NULL -> version
      -- first pointer write onto a document in an issued status (anything
      -- but Draft / In Review and the not-current Superseded / Void /
      -- Archived: lib/revisions.ts isControlledIssueStatus, pinned by test)
      -- is refused for a non-controller when the policy that governs it
      -- requires sign-off: its folder / library chain (what the app's
      -- creation gate reads) or its own. Create it as a Draft and submit it
      -- for review. External submissions are bound by SEC-13 below; a
      -- controller's issue proceeds and the app records it (DEC-63 s.2).
      IF OLD.current_version_id IS NULL AND v_intake_link IS NULL
         AND COALESCE(NEW.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')
         AND NOT is_org_controller(NEW.org_id)
         AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'
              OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require') THEN
        RAISE EXCEPTION
          'This library requires reviewer sign-off, so a new document can''t be issued unreviewed; create it as a Draft and submit it for review, or ask Document Control.'
          USING ERRCODE = 'check_violation';
      END IF;
      -- SEC-13 (projects Round G): an EXTERNAL submission is no exception to
      -- a policy that requires sign-off — its first issue included. The
      -- Intake tab sends it to the resolved roster; a promote that skipped
      -- the roster is refused here.
      IF v_intake_link IS NOT NULL THEN
        v_review_mode := review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id);
        IF v_review_mode = 'require' THEN
          RAISE EXCEPTION
            'This library requires reviewer sign-off; send the external submission to its reviewers before publishing it.'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END IF;

    -- DEC-21: reviewer independence. When the publisher is themselves on the
    -- roster, at least one signed PRIMARY must be someone else. A per-library
    -- policy, ON by default wherever a roster is configured; a library opts
    -- out with review_control.requireIndependentReviewer = false.
    IF COALESCE(v_primary_reqs, 0) > 0 THEN
      SELECT EXISTS (SELECT 1 FROM document_review_signoffs s
                      WHERE s.document_version_id = NEW.current_version_id
                        AND s.reviewer_user_id = v_actor)
        INTO v_on_roster;
      IF v_on_roster THEN
        SELECT COALESCE((l.review_control->>'requireIndependentReviewer')::boolean, true)
          INTO v_require_ind FROM libraries l WHERE l.id = NEW.library_id;
        IF COALESCE(v_require_ind, true) THEN
          SELECT count(*) INTO v_independent
            FROM document_review_signoffs s
           WHERE s.document_version_id = NEW.current_version_id
             AND s.slot = 'primary' AND s.status = 'signed' AND s.signature_id IS NOT NULL
             AND s.reviewer_user_id <> v_actor;
          IF COALESCE(v_independent, 0) = 0 THEN
            RAISE EXCEPTION
              'Reviewer independence: you are on this revision''s review roster, so at least one other primary reviewer must sign before you can publish it.'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      END IF;
    END IF;

    -- SEC-14 (projects Round G): an external submission of a drawing-class
    -- document carries a management-of-change reference into the
    -- controlled revision however it is promoted — the class rule
    -- publish_revision already applies to the service-role door (DCK-1).
    SELECT v.intake_link_id, v.moc_reference INTO v_intake_link, v_moc
      FROM document_versions v WHERE v.id = NEW.current_version_id;
    IF v_intake_link IS NOT NULL THEN
      BEGIN
        v_doc_class := COALESCE(
                         NULLIF(NEW.doc_class, ''),
                         (SELECT NULLIF(c.doc_class, '') FROM collections c WHERE c.id = NEW.collection_id),
                         (SELECT NULLIF(l.doc_class, '') FROM libraries l WHERE l.id = NEW.library_id)
                       );
      EXCEPTION WHEN undefined_column THEN
        v_doc_class := NULL;
      END;
      IF v_doc_class = 'drawing' AND length(btrim(COALESCE(v_moc, ''))) < 3 THEN
        RAISE EXCEPTION
          'PSM requires an MOC reference to publish an external submission of a drawing-class document (OSHA 1910.119(l)); add it to the submission before approving.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- REV-18 (P13): the issue itself. (1) The new door — a status-only issue
  -- out of Draft / In Review, or out of a retirement stamped 'not-issued' —
  -- is never opened over an active hold, by anyone — a controller included:
  -- a controller's override of a hold is publish_revision's force
  -- (recorded), never a status edit. Every other issue keeps the hold rule its write already
  -- had (the check below, for everyone short of a controller). (2) In a
  -- library whose policy requires sign-off — the folder / library chain
  -- OR the document's own, as REV-17's first-issue rule reads it, so a
  -- document-level 'none' written at INSERT is no way past it, DEC-71
  -- — only a controller may issue a revision that does not carry a
  -- complete roster (every primary slot filled by a bound signature,
  -- counted as the review gate above counts it). Who may issue at all is
  -- the publisher tier below (OWN-15 / OWN-19's authority). A put-back of
  -- the retired issue (v_restoring) is not a new issue: the require limb
  -- does not decide it.
  IF v_issuing THEN
    IF v_new_door AND EXISTS (
         SELECT 1 FROM document_holds h
          WHERE h.document_id = NEW.id AND h.released_at IS NULL
       ) THEN
      RAISE EXCEPTION
        'Document has an active hold; release the hold before issuing it.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- REV-20 (b): a controller's pointer-and-issue write over an active hold
    -- carries a recorded force (publish_revision's or the review promote's),
    -- or it is refused.
    IF v_unforced_issue AND EXISTS (
         SELECT 1 FROM document_holds h
          WHERE h.document_id = NEW.id AND h.released_at IS NULL
       ) THEN
      RAISE EXCEPTION
        'Document has an active hold; release the hold before issuing it, or publish over it with Document Control''s recorded override.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT is_org_controller(NEW.org_id)
       AND NOT v_restoring
       AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'
            OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require') THEN
      SELECT COALESCE(sum(g.reqs), 0), COALESCE(sum(LEAST(g.reqs, g.filled)), 0)
        INTO v_issue_reqs, v_issue_signed
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
      IF COALESCE(v_issue_reqs, 0) = 0 OR COALESCE(v_issue_signed, 0) < v_issue_reqs THEN
        RAISE EXCEPTION
          'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- REV-22 (P17): a controller's pointer move over an active hold on a
  -- document already issued carries a recorded force, or it is refused — in
  -- REV-20 (b)'s sentence, which the inspector recognises (it then offers
  -- Document Control the review promote's recorded force).
  IF v_unforced_move AND EXISTS (
       SELECT 1 FROM document_holds h
        WHERE h.document_id = NEW.id AND h.released_at IS NULL
     ) THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before issuing it, or publish over it with Document Control''s recorded override.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- OWN-3/DEC-2: controllers are a property of the role COLLECTION.
  -- v_actor IS auth.uid() here (service-role returned above), so the shared
  -- additive helper applies.
  IF is_org_controller(NEW.org_id) THEN
    RETURN NEW;
  END IF;

  -- Per-library publish authority OR the document's effective owner may publish.
  v_can_publish := user_can_publish_on_library(NEW.library_id, v_actor::text, NEW.org_id)
                OR user_is_effective_owner(NEW.owner_user_id, NEW.collection_id, NEW.library_id, v_actor);

  IF NOT v_can_publish THEN
    RAISE EXCEPTION
      'You do not have authority to publish revisions in this library.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM document_holds h
     WHERE h.document_id = NEW.id AND h.released_at IS NULL
  ) INTO v_has_hold;
  IF v_has_hold THEN
    RAISE EXCEPTION
      'Document has an active hold; release the hold before publishing a new revision.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
-- A trigger function is never called by a client (it RETURNS trigger); its
-- EXECUTE is checked when a trigger is created, not when it fires, so no
-- client role needs it (DRLS-16: grant only to the roles that call it).
-- CREATE OR REPLACE keeps the guard's owner, whose EXECUTE on
-- is_controlled_issue_status 20261144 already ensured (probed below).
REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 7. Inventory rows: n = the aggregate count.
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here).
SELECT 'REV-22 (P18): a controller''s exit of an unstamped Superseded document into an issue status, its pointer unmoved, is the new door (refused over an active hold) unless the recorded-restore flag names the document' AS check,
       (SELECT prosrc LIKE '%AND OLD.status IN (''Archived'', ''Void'')%AND is_org_controller(NEW.org_id), false);%v_new_door := v_new_door%OR COALESCE(v_issuing%AND OLD.status = ''Superseded''%AND OLD.retired_issue_status IS NULL%AND current_setting(''app.publish_hold_override'', true) IS DISTINCT FROM NEW.id%AND is_org_controller(NEW.org_id), false);%v_unforced_issue := COALESCE(v_issuing%'
           AND prosrc LIKE '%IF v_new_door AND EXISTS (%'
           AND prosrc LIKE '%''Document has an active hold; release the hold before issuing it.''%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'REV-22 limb 1 and RG-14 survive the re-create (20261159: a controller''s bare pointer move on a held issued document needs the flag; a roster stamped owner:<uid> needs that owner''s signature)',
       (SELECT prosrc LIKE '%v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL%'
           AND prosrc LIKE '%IF v_unforced_move AND EXISTS (%'
           AND prosrc LIKE '%AND s.slot_group = o.opened_owner_slot%'
           AND prosrc LIKE '%requires the document owner''''s approval, and the owner has not signed it%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-20 and the 20261144 rules survive the re-create (the unstamped Archived / Void exit, the pointer-and-issue force, the issue transition, the stamp, the require limb, the publisher tier, the hold)',
       (SELECT prosrc LIKE '%AND OLD.status IN (''Archived'', ''Void'')%'
           AND prosrc LIKE '%v_unforced_issue := COALESCE(v_issuing%'
           AND prosrc LIKE '%IF v_unforced_issue AND EXISTS (%'
           AND prosrc LIKE '%or publish over it with Document Control''''s recorded override.%'
           AND prosrc LIKE '%v_issuing := NEW.current_version_id IS NOT NULL%'
           AND prosrc LIKE '%v_restoring := COALESCE(v_issuing%'
           AND prosrc LIKE '%NEW.retired_issue_status := ''not-issued'';%'
           AND prosrc LIKE '%a revision that was not reviewed can''''t be made a controlled issue%'
           AND prosrc LIKE '%You do not have authority to publish revisions in this library.%'
           AND prosrc LIKE '%Document has an active hold; release the hold before publishing a new revision.%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'the guard is SECURITY DEFINER with search_path pinned, no client role may execute it, its owner may execute is_controlled_issue_status, and trg_document_publish_guard still fires it',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')
       AND COALESCE(has_function_privilege((SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                             WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard'),
                                           'is_controlled_issue_status(text)', 'EXECUTE'), false)
       AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgname = 'trg_document_publish_guard' AND NOT t.tgisinternal
                      AND t.tgrelid = 'documents'::regclass AND p.proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-22 (P18): restore_reversed_source has one signature (4 arguments), runs as the CALLER (SECURITY INVOKER, search_path pinned); authenticated may execute it, PUBLIC, anon and service_role may not',
       (SELECT COUNT(*) FROM pg_proc WHERE proname = 'restore_reversed_source') = 1
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'restore_reversed_source' AND p.pronargs = 4
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.proacl IS NOT NULL)
       AND has_function_privilege('authenticated', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')
       AND NOT has_function_privilege('service_role', 'restore_reversed_source(uuid, text, uuid, text)', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                        WHERE p.proname = 'restore_reversed_source' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'REV-22 (P18): restore_reversed_source refuses a call with no session, sets the flag only for Document Control''s put-back of a held Superseded source of the recorded split / merge it names that no recorded reversal has undone, around its own write, clears it, records REV_HOLD_OVERRIDDEN and answers restored_over_hold',
       (SELECT prosrc LIKE '%IF v_uid IS NULL THEN%RAISE EXCEPTION%'
           AND prosrc LIKE '%AND a.action IN (''DOC_SPLIT'', ''DOC_MERGED'')%'
           AND prosrc LIKE '%AND NOT EXISTS (SELECT 1 FROM audit_logs r%AND r.resource_id = a.resource_id%AND r.action IN (''DOC_SPLIT_REVERSED'', ''DOC_MERGE_REVERSED'')%AND translate(lower(r.details->>''reversedAuditEventId''), ''{}-'', '''') = replace(p_reversal_of%'
           AND prosrc LIKE '%IF v_status = ''Superseded''%AND v_action IS NOT NULL%AND is_org_controller(v_org)%AND EXISTS (SELECT 1 FROM document_holds h%v_forced := true;%'
           AND prosrc LIKE '%PERFORM set_config(''app.publish_hold_override'', p_document_id%UPDATE documents%SET status = p_status,%GET DIAGNOSTICS v_n = ROW_COUNT;%PERFORM set_config(''app.publish_hold_override'', '''', true);%'
           AND prosrc LIKE '%VALUES (''REV_HOLD_OVERRIDDEN''%''via'', ''reversal_restore''%'
           AND prosrc LIKE '%RETURN CASE WHEN v_forced THEN ''restored_over_hold'' ELSE ''restored'' END;%'
          FROM pg_proc WHERE proname = 'restore_reversed_source'),
       NULL
UNION ALL
SELECT 'REV-22 (P18): the guard and publish_revision / finalize_reviewed_promote still read and set the same flag (publish_revision and finalize_reviewed_promote set it around their promotes, 20261151)',
       (SELECT prosrc LIKE '%PERFORM set_config(''app.publish_hold_override'', p_doc%' FROM pg_proc WHERE proname = 'publish_revision')
       AND (SELECT prosrc LIKE '%PERFORM set_config(''app.publish_hold_override'', p_document_id%' FROM pg_proc WHERE proname = 'finalize_reviewed_promote'),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_164_before;
