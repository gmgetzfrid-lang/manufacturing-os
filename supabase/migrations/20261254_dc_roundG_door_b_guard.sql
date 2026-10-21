-- ─────────────────────────────────────────────────────────────────────────────
-- 20261254_dc_roundG_door_b_guard.sql
--
-- document-control Round G — P37 DOOR B GUARD (DCK-18's remainders and REV-37;
-- assigned by the integrator at the P35 and P36 merges, DEC-31; ruled under
-- DEC-90: fail-safe, no regression).
--
--   DCK-18 (a) A door-(b) pointer write over another person's checkout made
--          outside finalize_reviewed_promote (the three-step PATCH sent by
--          hand) is recorded by the publish guard — the same
--          REVIEW_PROMOTED_OVER_CHECKOUT row and holder's notice 20261252
--          writes; finalize marks its own promote (transaction-local
--          app.review_promote_records) so nothing is doubled. Never a
--          refusal: each write its own sub-block, a WARNING when it fails.
--   DCK-18 (b) Door (b)'s intake limb trusted the version row's columns
--          alone; a door-shaped row a signed-in session wrote before 20261247
--          could not be told from a genuine submission. Over another person's
--          checkout, an intake-only promote (no bound roster) now needs a
--          proof naming the version, no person named (user_id NULL — no
--          signed-in session can write one): the door's own
--          INTAKE_DOOR_SUBMITTED record, written by intake_door_submit_version
--          in the door's transaction on BOTH its paths (role switch, bound-
--          identity fallback; P37 final fix pass — every door path that can
--          file a submission here goes through it: 20261254 → 20261252 →
--          20261247 → 20261214 → 20261184); the intake route's
--          INTAKE_SUBMISSION record; or that record kept as a server dead
--          letter in the EVID-6 outbox (20261219; still there, or drained as
--          AUDIT_DEAD_LETTER). Else refused 42501 in the lock leg's words.
--   REV-37 (1) retire_over_hold's recorded park (p_via 'reversal_park', the
--          force asked) is bound to the reversal being run: an unreversed
--          recorded split naming the document as a replacement, or merge as
--          its target; else 42501. The split / merge source flip stays the
--          recorded Document Control pass (the integrator's ruling).
--          (2) A write rail for REV_HOLD_OVERRIDDEN (the evidence
--          put_back_retired_issue reads): a signed-in session's row only in
--          the transaction that wrote the document it names (its documents
--          row, or the version details.versionId names — publish_revision's
--          forced branch writes no documents row); else 42501. The service
--          role passes. Rows written before this paste are not re-judged
--          (the recorded residual; inventory row 5 is the operator's look-
--          over).
--
-- RE-CREATED FROM THE NEWEST BODIES (found by scanning; lineDiff-pinned —
-- every base line kept, the added lines exactly the P37 blocks):
-- enforce_document_publish_guard (20261253), finalize_reviewed_promote
-- (20261252, same eight-argument signature), retire_over_hold (20261253),
-- intake_door_submit_version (20261214, same signature). Created:
-- enforce_hold_override_record_rail() and its trigger on audit_logs. No row is
-- moved. DRLS-16: the guard and the rail are SECURITY DEFINER, search_path
-- pinned, executable by no client role; the other three stay SECURITY
-- INVOKER with their grants restated (intake_door_submit_version: the service
-- role only). NOT a widening: every limb refuses, or records, a write it
-- admitted. DEC-30 inventory: aggregate counts only, BEFORE the transaction.
--
-- APP BEFORE AND AFTER THIS PASTE: no app change is needed. finalize keeps its
-- signature and answers; the intake route's call to intake_door_submit_version
-- is unchanged (the door's record is one more audit row per submission). The
-- app carrying P37 adds the Inspector's retire of a stray pending submission
-- (an intent row before the void, the outcome after), re-reads a recorded flip
-- or park whose answer was lost, and keeps a failed INTAKE_SUBMISSION write in
-- the outbox (before 20261219: only logged, as before) — all on any database.
-- DEPLOY ORDER: none — deploy the P37 app before or after this paste.
--
-- What changes after the paste: an unproven door-shaped submission is no
-- longer promoted over another person's checkout (the holder checks in, or
-- Document Control retires it); a door-(b) write over a checkout outside
-- finalize is recorded and the holder told; an unbound recorded park and a
-- member's direct REV_HOLD_OVERRIDDEN insert are refused (42501); each door
-- submission writes INTAKE_DOOR_SUBMITTED.
--
-- HOW TO APPLY: AFTER 20261253 (required — the first statement refuses,
-- changing nothing, without 20261253, 20261252 or 20261214's bodies), so it
-- waits behind paste guide row 193 (HOLD behind rows 187 / 150).
-- ⚠ Never re-paste 20261253, 20261252, 20261245, 20261214, 20261193,
-- 20261185, 20261184, 20261182, 20261174, 20261165, 20261164, 20261159,
-- 20261151, 20261144, 20261139, 20261105 or any earlier guard / finalize /
-- intake-door migration after this one: each would drop a P37 limb.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the bases) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'
                  AND prosrc LIKE '%IF COALESCE(NEW.status IN (''Superseded'', ''Void''), false)%') THEN
    RAISE EXCEPTION '20261254 needs 20261253 (the hold leg in the publish guard) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'finalize_reviewed_promote' AND pronargs = 8
                  AND prosrc LIKE '%REVIEW_PROMOTED_OVER_CHECKOUT%') THEN
    RAISE EXCEPTION '20261254 needs 20261252 (finalize_reviewed_promote''s over-checkout record) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'retire_over_hold' AND pronargs = 6) THEN
    RAISE EXCEPTION '20261254 needs 20261253 (retire_over_hold) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'intake_door_submit_version' AND pronargs = 2
                  AND prosrc LIKE '%intake_door_version_rls_ready()%') THEN
    RAISE EXCEPTION '20261254 needs 20261214 (intake_door_submit_version''s role switch) pasted first; nothing was changed.';
  END IF;
END
$$;

-- The inventory's outbox reader (20261219; false where the table is not):
-- session-local (pg_temp), read by the inventory only.
CREATE OR REPLACE FUNCTION pg_temp.dc_round_g_254_outbox_names(p_org uuid, p_doc text, p_version text)
RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE
  v boolean := false;
BEGIN
  IF to_regclass('public.audit_dead_letters') IS NULL THEN RETURN false; END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.audit_dead_letters o
                           WHERE o.org_id = $1 AND o.action = ''INTAKE_SUBMISSION''
                             AND o.source = ''server'' AND o.reported_by IS NULL
                             AND o.entry->''row''->>''resource_type'' = ''document''
                             AND o.entry->''row''->>''resource_id'' = $2
                             AND jsonb_typeof(COALESCE(o.entry->''row''->''user_id'', ''null''::jsonb)) = ''null''
                             AND o.entry->''row''->''details''->>''versionId'' = $3)'
    INTO v USING p_org, p_doc, p_version;
  RETURN COALESCE(v, false);
END
$f$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_g_254_before;
CREATE TEMP TABLE dc_round_g_254_before AS
WITH s AS (
  -- the door-shaped submissions pending now (20261252's rows 3-6) and
  -- whether any proof door (b)'s intake limb accepts from this paste names
  -- them: the route's own record, the door's own record (none before a
  -- first apply), or the route's record kept as a server dead letter
  -- (drained into the trail, or still in the outbox)
  SELECT d.checked_out_by IS NOT NULL AS checked_out,
         (EXISTS (SELECT 1 FROM audit_logs a
                   WHERE a.org_id = d.org_id AND a.resource_type = 'document' AND a.resource_id = d.id::text
                     AND a.action IN ('INTAKE_SUBMISSION', 'INTAKE_DOOR_SUBMITTED') AND a.user_id IS NULL
                     AND a.details->>'versionId' = v.id::text)
          OR EXISTS (SELECT 1 FROM audit_logs a
                      WHERE a.org_id = d.org_id AND a.resource_type = 'org' AND a.resource_id = d.org_id::text
                        AND a.action = 'AUDIT_DEAD_LETTER' AND a.user_id IS NULL
                        AND a.details->>'lostAction' = 'INTAKE_SUBMISSION' AND a.details->>'source' = 'server'
                        AND jsonb_typeof(COALESCE(a.details->'reportedBy', 'null'::jsonb)) = 'null'
                        AND a.details->'lost'->>'resource_type' = 'document'
                        AND a.details->'lost'->>'resource_id' = d.id::text
                        AND jsonb_typeof(COALESCE(a.details->'lost'->'user_id', 'null'::jsonb)) = 'null'
                        AND a.details->'lost'->'details'->>'versionId' = v.id::text)
          OR pg_temp.dc_round_g_254_outbox_names(d.org_id, d.id::text, v.id::text)) AS proven
    FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
   WHERE v.review_state = 'in_review' AND COALESCE(v.provenance, '') = 'external'
     AND (v.created_by IS NULL OR v.created_by = v.intake_link_id)
)
SELECT 'inventory (before apply): pending door-shaped external submissions no proof names (the route''s INTAKE_SUBMISSION record, the door''s INTAKE_DOOR_SUBMITTED record, or a server dead letter of the route''s record) — door (b) no longer promotes one over another person''s checkout; expected 0 (a genuine pre-paste one whose route record was lost counts too: indistinguishable from a hand-written row)' AS inventory,
       COUNT(*)::text AS n
  FROM s WHERE NOT proven
UNION ALL
SELECT 'inventory (before apply): of those, on a document checked out right now (the ones this paste refuses to promote until the holder checks in, or Document Control retires them)',
       COUNT(*)::text
  FROM s WHERE NOT proven AND checked_out
UNION ALL
SELECT 'inventory (before apply): REVIEW_PROMOTED_OVER_CHECKOUT records to date — informational: from this paste a door-(b) write over a checkout made outside finalize_reviewed_promote is recorded too',
       COUNT(*)::text
  FROM audit_logs WHERE action = 'REVIEW_PROMOTED_OVER_CHECKOUT'
UNION ALL
SELECT 'inventory (before apply): REV_HOLD_OVERRIDDEN records to date — informational: from this paste a signed-in session writes one only in the transaction that wrote the document it names',
       COUNT(*)::text
  FROM audit_logs WHERE action = 'REV_HOLD_OVERRIDDEN'
UNION ALL
SELECT 'inventory (before apply): OPERATOR LOOK-OVER (owner: the operator at the 20261254 paste, reported to the integrator) — REV_HOLD_OVERRIDDEN via reversal_restore with no matching restore_reversed_source trace (no recorded DOC_SPLIT / DOC_MERGED of the action it names naming the document, recorded no later; or not that function''s shape: priorStatus Superseded, holds listed, branch false). Pre-paste rows stay readable as evidence (REV-37''s residual) — expected 0; each counted is looked over',
       COUNT(*)::text
  FROM audit_logs r
 WHERE r.action = 'REV_HOLD_OVERRIDDEN' AND r.details->>'via' = 'reversal_restore'
   AND NOT (
         COALESCE(r.details->>'priorStatus' = 'Superseded', false)
     AND COALESCE(jsonb_typeof(r.details->'holds') = 'array', false)
     AND COALESCE(r.details->>'branch' = 'false', false)
     AND EXISTS (SELECT 1 FROM audit_logs e
                  WHERE e.id::text = r.details->>'reversedAuditEventId'
                    AND e.org_id = r.org_id
                    AND e.action IN ('DOC_SPLIT', 'DOC_MERGED')
                    AND e.action = r.details->>'reversedAction'
                    AND (e.resource_id = r.resource_id
                         OR COALESCE(jsonb_typeof(e.details->'mergeSiblings') = 'array'
                                     AND (e.details->'mergeSiblings') ? r.resource_id, false))
                    AND e."timestamp" <= r."timestamp"))
UNION ALL
SELECT 'inventory (before apply): documents under an active hold that an unreversed recorded split names as a replacement or merge as its target — informational: the documents a reversal may still park over a hold, recorded, from this paste',
       COUNT(DISTINCT d.id)::text
  FROM documents d
  JOIN audit_logs e ON e.org_id = d.org_id
   AND ((e.action = 'DOC_SPLIT' AND jsonb_typeof(e.details->'replacementDocIds') = 'array' AND (e.details->'replacementDocIds') ? d.id::text)
        OR (e.action = 'DOC_MERGED' AND e.details->>'mergedIntoDocumentId' = d.id::text))
 WHERE EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM audit_logs r
                    WHERE r.org_id = e.org_id AND r.resource_id = e.resource_id
                      AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')
                      AND translate(lower(r.details->>'reversedAuditEventId'), '{}-', '') = replace(e.id::text, '-', ''))
UNION ALL
SELECT 'inventory (before apply): INTAKE_DOOR_SUBMITTED records to date — 0 on a first apply (only this paste''s door writes them); non-zero on a first apply is for the operator to look over',
       COUNT(*)::text
  FROM audit_logs WHERE action = 'INTAKE_DOOR_SUBMITTED';

BEGIN;

-- ── DCK-18 (P37): the publish guard — 20261253 body + door (b)'s two limbs ──
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
  v_door_b_rev   text;
  v_door_b_label text;
  v_door_b_who   text;
  v_door_b_told  boolean;
  v_door_b_n     integer;
  v_door_b_proof boolean;
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
  -- REV-21 (document-control Round F wave 3, P16; DEC-77 §4, ratified by
  -- the integrator under the user's delegation, 2026-10-07 — DEC-90 A3,
  -- option 1): a status-only move INTO Issued / Locked from any status
  -- outside them is an issue too. is_controlled_issue_status counts every
  -- status but the five above as an issue — "IFC", an empty status, a case
  -- or spacing variant, a library's own — while the print gate
  -- (lib/docPack.ts filterPackDocs) and the verify allow-list
  -- (lib/verifyVerdict.ts IN_FORCE_STATUSES) read only Issued and Locked as
  -- in force. So IFC -> Issued, the move that puts such a document in
  -- force, was issue-to-issue here, and the guard returned before its
  -- publisher tier, its hold check and its require limb. Now a write that
  -- leaves a document WITH a current revision, its pointer unmoved, moving
  -- out of an issue status other than Issued / Locked into Issued or Locked
  -- is v_issuing (lib/documentStatusOptions.ts isUnguardedEntryIntoForce,
  -- pinned by test; out of Draft / In Review / a retirement it already is),
  -- judged as every status-only issue is: the new door just below (never
  -- over an active hold, for anyone), the require limb, the publisher tier.
  -- A write that ALSO moves the pointer (publish_revision's rev-up or revert
  -- of an IFC document, which writes 'Issued') is not this: it keeps the
  -- pointer move's rules — the review gate, RG-7's Minor / Correction hatch,
  -- RG-14, the publisher tier and its hold, P17's v_unforced_move. No IFC
  -- row is moved: Document Control re-issues each through this path.
  v_issuing := v_issuing
               OR COALESCE(NEW.current_version_id IS NOT NULL
                           AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
                           AND is_controlled_issue_status(OLD.status)
                           AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')
                           AND NEW.status IN ('Issued', 'Locked'), false);
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
  -- REV-21 (document-control Round F wave 3, P16 review fix): the same move
  -- out of a retirement. A retirement entered from an issue status no gate
  -- reads as in force (IFC, an empty status, a case or spacing variant, a
  -- library's own, a NULL status) is stamped below with that status and its
  -- revision, so its exit into Issued / Locked at that revision was
  -- v_restoring, a put-back: the require limb did not decide it, and the
  -- flag put_back_retired_issue (the un-archive dialog's recorded override)
  -- or restore_reversed_source sets passed Document Control over a hold
  -- (REV-23's limb just below). But that retirement took away nothing in
  -- force: IFC -> Archived -> Issued (the un-archive dialog's default for
  -- any stamp naming the current revision), IFC -> Void -> Locked and IFC ->
  -- Superseded -> Issued put the revision in force exactly as the direct
  -- move the REV-21 limb of v_issuing above judges. So a put-back INTO
  -- Issued / Locked of a stamp outside them is not v_restoring (the require
  -- limb decides it), and it is the new door: refused over an active hold
  -- for everyone, Document Control included, whatever flag is set (never a
  -- recorded pass — a controller's override of a hold is publish_revision's
  -- force, never a status edit). A put-back to the stamped status itself
  -- (Archived -> IFC), and an Issued / Locked stamp put back into Issued or
  -- Locked, keep v_restoring and its rules. A retirement with no stamp at
  -- all (retired before 20261144, or by the service role) keeps REV-20's and
  -- REV-22's limbs above; a 'not-issued' stamp's exit is the new door
  -- already.
  v_restoring := v_restoring
                 AND NOT COALESCE(NEW.status IN ('Issued', 'Locked')
                                  AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked'), false);
  v_new_door := v_new_door
                OR COALESCE(v_issuing
                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
                            AND OLD.status IN ('Superseded', 'Archived', 'Void')
                            AND OLD.retired_issue_version_id IS NOT NULL
                            AND COALESCE(OLD.retired_issue_status, '') NOT IN ('Issued', 'Locked')
                            AND NEW.status IN ('Issued', 'Locked'), false);
  -- REV-23 (document-control Round F wave 3, P19): the STAMPED put-back
  -- (v_restoring, just above) binds a controller over a hold too. The
  -- comments in this body that say a controller passes the hold there
  -- (REV-18's just above, P18's further up) describe this guard before
  -- 20261165. The app's put-backs of a stamped retirement — the un-archive
  -- (lib/revisions.ts unarchiveDocument), a failed supersede's rollback
  -- (undoFailedSupersede), a failed split / merge's rollback
  -- (lib/documentLifecycle/common.ts restoreSupersededSource) and a failed
  -- reversal's un-park (lib/documentLifecycle/reverse.ts putStatusBack) —
  -- now go through put_back_retired_issue (20261165), which sets the
  -- transaction-local flag app.publish_hold_override to the document's id
  -- around its own status write — for Document Control only, only when the
  -- caller asks for the force (p_force_hold: the un-archive dialog after an
  -- explicit confirmation over the holds it showed; the rollbacks), only for
  -- the put-back of the revision the retirement took away into an issue
  -- status (for a rollback, of a retirement the caller made), only while a
  -- hold is active — and records REV_HOLD_OVERRIDDEN in the
  -- same transaction (the legacy reversal's restore_reversed_source,
  -- 20261164, sets the same flag around its put-back of a held source,
  -- stamped or not). So a controller's stamped put-back without that flag
  -- naming the document (a bare PATCH, a status editor's write) is judged as
  -- a status-only issue: the new door, whose hold binds a controller too.
  -- The require limb still does not decide a put-back (v_restoring); below a
  -- controller nothing changes (the publisher tier's own hold check still
  -- refuses it, in its own words).
  v_new_door := v_new_door
                OR COALESCE(v_restoring
                            AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
                            AND is_org_controller(NEW.org_id), false);
  -- REV-24 (document-control Round F wave 3, P20): two controller writes on
  -- a held RETIRED document (Superseded, Archived, Void) still passed an
  -- active hold with nothing recorded after 20261165. Both are bound here.
  -- (b) The pointer move. v_unforced_move (P17, above) binds only a move
  -- whose OLD status is an issue status, so Document Control's bare move of
  -- a held retired document's current_version_id was admitted — and it left
  -- a retirement stamp naming another revision, whose exit (a) then passed
  -- too. Over a hold such a move now needs the transaction-local flag naming
  -- this document — set only around a write by a function that records
  -- REV_HOLD_OVERRIDDEN in the same transaction (publish_revision's
  -- controller force, the review promote's) — or it is refused, in REV-20
  -- (b)'s sentence, like any other unforced move over a hold. A move is any
  -- write that takes the pointer off the current revision: to another
  -- revision, or cleared to NULL (fix pass 2 — a clear, then an exit into an
  -- issue with no revision, then a first pointer write, put a revision the
  -- retirement never issued in force over the hold, unrecorded). No app
  -- write moves a retired document's pointer, and none clears any
  -- document's: a rev-up of one is refused before anything is written
  -- (lib/revisions.ts describeRetiredRevUp), a revert goes through
  -- publish_revision (which answers on_hold for a held document unless
  -- Document Control forces it, and then sets the flag), the split / merge /
  -- reversal sagas, their compensations and every put-back write a status
  -- and its fields, never the pointer, and every pointer write the app
  -- makes names a revision. A first pointer write (no current revision yet)
  -- is a creation's — REV-17's — not this, as in P17's limb. Bound to a
  -- controller only: below a controller the publisher tier's own hold check
  -- still refuses every pointer move over a hold, in its own words.
  -- (a) The exit. A stamped retirement whose stamp names ANOTHER revision
  -- than its current one (the pointer moved while it was retired, or by the
  -- service role, whose writes never touch the stamp) is not v_restoring:
  -- its exit into an issue status, its pointer unmoved, would put in force a
  -- revision its retirement did not take away. It is judged as a
  -- status-only issue — the new door, refused over an active hold for
  -- everyone, Document Control included, as a 'not-issued' stamp's exit is
  -- (the require limb decides it, as it already did). No flag passes it: it
  -- is never a recorded controller pass (REV-18: a controller's override of
  -- a hold is publish_revision's recorded force, never a status edit), and
  -- put_back_retired_issue never sets the flag for it (its door needs the
  -- stamp to name the current revision). An exit that also moves the
  -- pointer is v_unforced_issue's (REV-20 (b)), as before. The REV-18
  -- comment on the issue block below lists the new door's earlier members;
  -- this exit is one more.
  v_unforced_move := v_unforced_move
                     OR COALESCE(OLD.current_version_id IS NOT NULL
                                 AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
                                 AND OLD.status IN ('Superseded', 'Archived', 'Void')
                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
                                 AND is_org_controller(NEW.org_id), false);
  v_new_door := v_new_door
                OR COALESCE(v_issuing
                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
                            AND OLD.status IN ('Superseded', 'Archived', 'Void')
                            AND OLD.retired_issue_version_id IS NOT NULL
                            AND OLD.retired_issue_version_id IS DISTINCT FROM OLD.current_version_id, false);
  -- REV-25 (document-control Round F wave 3, P21): two more controller
  -- writes over an active hold still put a never-issued revision in force
  -- with nothing recorded after 20261174. Both are bound here as unforced
  -- moves: refused over a hold, in REV-20 (b)'s sentence, unless the
  -- transaction-local flag names this document (set only around a write by
  -- a function that records REV_HOLD_OVERRIDDEN in the same transaction —
  -- publish_revision's controller force, the review promote's).
  -- (i) The FIRST pointer write (no current revision -> a revision), in any
  -- status. The limbs above judge a move off a current revision and left a
  -- first pointer write to REV-17 as a creation's. A held document reaches
  -- "no current revision" by a clear made while it was unheld, or by the
  -- service role, and its first pointer write then put any revision in
  -- force over the hold: after an un-archive to Issued with no revision,
  -- and as the last step of the Draft route (restore to Draft, clear, make
  -- it Issued with no revision, set the pointer). A creation is not this:
  -- this trigger fires BEFORE UPDATE only (TG_OP is always UPDATE here), the
  -- app's creations write the first pointer in their own request after the
  -- INSERT (so "created in this transaction" cannot tell them apart either),
  -- and none carries a hold at that write — holds are opened on an existing
  -- document, and HLD-2 carries a split / merge source's holds onto a new
  -- sheet only after the sheet's first pointer write. So a first pointer
  -- write OVER A HOLD is an existing document's; a creation's is unchanged
  -- (REV-17's rule below decides it, as before). For a write over a hold,
  -- this supersedes "a first pointer write (no current revision yet) is a
  -- creation's — REV-17's — not this" in P17's and P20's comments above.
  -- (ii) The CLEAR of the pointer (the current revision -> NULL) of a
  -- document in an issue status (Issued, IFC, a library's own), whatever
  -- status the write leaves: P17's limb binds a move between two revisions
  -- only, and P20's (b) a retired document's. No app write clears any
  -- document's pointer; every app pointer write that is not a creation's
  -- goes through publish_revision or the review promote, whose recorded
  -- forces set the flag. Both bind a controller only: below a controller
  -- the publisher tier's own hold check already refuses every pointer write
  -- over a hold, in its own words.
  v_unforced_move := v_unforced_move
                     OR COALESCE(OLD.current_version_id IS NULL
                                 AND NEW.current_version_id IS NOT NULL
                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
                                 AND is_org_controller(NEW.org_id), false);
  v_unforced_move := v_unforced_move
                     OR COALESCE(OLD.current_version_id IS NOT NULL
                                 AND NEW.current_version_id IS NULL
                                 AND is_controlled_issue_status(OLD.status)
                                 AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
                                 AND is_org_controller(NEW.org_id), false);
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
  -- REV-36 (document-control Round G, P36 STATUS EDITOR PARITY III —
  -- assigned by the integrator at the P34 merge, 2026-10-21, DEC-31; ruled
  -- under DEC-90: fail-safe, no regression): entry into Superseded or Void
  -- over an active hold is refused HERE, Document Control included. Before
  -- this block a controller's write reached the controller return below
  -- before the publisher tier's hold check, so a status editor's
  -- supersession (the bulk editor, the metadata save) or a bare PATCH of
  -- documents.status retired a held document unrefused whenever the app's
  -- pre-write read missed the hold (opened in the instant between) or was
  -- never made (a script); and entry into Void out of a status that is not
  -- retired is not an advancing write, so a hold refused it for nobody. Now
  -- a write that moves a document INTO Superseded or Void from any other
  -- status (a NULL one included) while a hold is active is refused unless
  -- the transaction-local flag app.publish_hold_override names this
  -- document — set only around a write by a function that records
  -- REV_HOLD_OVERRIDDEN in the same transaction: retire_over_hold (20261253
  -- — the split / merge supersession of a held source and a reversal's park
  -- of a held sheet, each Document Control's explicit proceed-over-the-hold,
  -- HLD-2), put_back_retired_issue (since 20261253 also a failed
  -- operation's rollback putting a held document back into Superseded or
  -- Void, the status it had), restore_reversed_source (the legacy reversal's
  -- put-back, a Void one included), as publish_revision's force and the
  -- review promote's set it for theirs. Bound to a controller for every such
  -- write — the parity of the publisher tier, which refuses each of them
  -- over a hold below a controller — and below a controller only to the
  -- write the rest of this guard does not judge (not advancing: entry into
  -- Void out of a status that is not retired); every advancing one (entry
  -- into Superseded, a move out of a retired status) keeps the publisher
  -- tier's own authority and hold refusals, in their own words, as before.
  -- Every write that is not an entry into Superseded or Void, every
  -- document with no active hold and every service-role write (returned at
  -- the top) is decided exactly as before.
  IF COALESCE(NEW.status IN ('Superseded', 'Void'), false)
     AND NEW.status IS DISTINCT FROM OLD.status
     AND current_setting('app.publish_hold_override', true) IS DISTINCT FROM NEW.id::text
     AND (is_org_controller(NEW.org_id) OR NOT COALESCE(v_advancing, false))
     AND EXISTS (
           SELECT 1 FROM document_holds h
            WHERE h.document_id = NEW.id AND h.released_at IS NULL
         ) THEN
    RAISE EXCEPTION
      'Document has an active hold; a held document can''t be superseded or voided here — release the hold first, or replace it through a split or merge (Document Control proceeds over the hold there, recorded, and it is carried to the new document).'
      USING ERRCODE = 'check_violation';
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
      -- REV-28 (document-control Round F wave 3, P25; DEC-77, option (a),
      -- decided by the integrator under the user's delegation at the P16
      -- merge, 2026-10-07): a rev-up (or a revert) of a document whose OLD
      -- status is an issue status no gate reads as in force (IFC, an empty
      -- status, a case or spacing variant, a library's own, NULL) is a FIRST
      -- issue, not a revision through the gate. Its current revision was
      -- never in force (DEC-77 §3), so nothing says it was reviewed, and this
      -- write puts the new revision in force (Issued / Locked) for the first
      -- time. RG-7's Minor / Correction hatch above assumes a reviewed base
      -- in force, so it does not open such a write: under a policy that
      -- requires sign-off — the folder / library chain OR the document's own
      -- (DEC-71), as REV-17's rule just above and the require limb read it —
      -- a non-controller's pointer move into Issued / Locked out of such a
      -- status is refused when the new revision carries no reviewer roster
      -- (a roster it carries was decided by the review gate above: complete,
      -- or refused), in the require limb's sentence, which the app
      -- recognises (lib/issueStatus.ts ISSUE_REFUSAL.unreviewed). Document
      -- Control (DEC-63 §2), a complete roster, an external submission
      -- (SEC-13 just below), a policy that does not require sign-off, and
      -- every rev-up of a document IN force (Issued / Locked — RG-7's hatch,
      -- as before) pass exactly as before; so does a pointer move that keeps
      -- the document out of force. lib/revisions.ts firstIssueGateForRevUp
      -- asks the same question, so RevUpModal, setLevelRevUp and the merge
      -- rev-up route such a rev-up to review before anything is written.
      IF OLD.current_version_id IS NOT NULL AND v_intake_link IS NULL
         AND COALESCE(is_controlled_issue_status(OLD.status)
                      AND COALESCE(OLD.status, '') NOT IN ('Issued', 'Locked')
                      AND NEW.status IN ('Issued', 'Locked'), false)
         AND NOT is_org_controller(NEW.org_id)
         AND (review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = 'require'
              OR review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id) = 'require') THEN
        RAISE EXCEPTION
          'This library requires reviewer sign-off, so a revision that was not reviewed can''t be made a controlled issue; submit it for review, or ask Document Control.'
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

  -- HAND-13 (drafting-flow; document-control Round G, P32 PUBLISH GUARD LOCK
  -- LEG — assigned by the integrator at the DF-P11 merge, 2026-10-21, and
  -- ruled under DEC-90: fail-safe, no regression): the checkout lock is
  -- enforced HERE for every door, not only inside publish_revision. 20260812
  -- removed this guard's lock branch on purpose because the override-with-
  -- reason flow lived only in the app; since DCK-8 that override is
  -- publish_revision's own (a reason of five characters or more from a
  -- library publisher or the effective owner, or Document Control's force,
  -- re-derived and recorded as REV_LOCK_OVERRIDDEN in the same transaction).
  -- So a write that makes a NEW revision current (a pointer move to a
  -- revision, first pointer included) on a document checked out by someone
  -- other than the signed-in actor is refused (insufficient_privilege),
  -- Document Control included, unless it is one of the two doors that
  -- already decide the lock:
  --   (a) publish_revision's own promote — the revision it names was
  --       inserted by this actor in THIS transaction (created_at is now(),
  --       the transaction's start, which no separate request can reproduce)
  --       on top of the revision this write replaces. publish_revision
  --       reaches that write only for the holder, an unlocked document, a
  --       recorded publisher override or a controller's recorded force
  --       (otherwise it answers locked_by_other and writes nothing), so
  --       every override it admits today lands exactly as before;
  --   (b) the reviewed promote of the document's pending draft, still
  --       marked in_review, whose ROW looks reviewed: either it
  --       carries a bound reviewer roster (v_primary_reqs > 0 — the review
  --       gate above has already refused one that is not complete), or it
  --       is an external submission as the intake door writes it (no
  --       member as its creator — NULL, or the link's own id where a live
  --       column default fills it under the door's bound identity (SEC-22,
  --       20261214) — provenance 'external', its link a link of this org
  --       whose scope holds this document: the document's immutable
  --       authoring link, or one it is assigned to — the door's own scope
  --       check, 20261184) — the click that approves it is the review a
  --       roster-free policy asks for. finalize_reviewed_promote and its three-
  --       step fallback write that shape, and neither has ever read the
  --       lock, so a review finished while someone holds a checkout
  --       publishes as it does today. A pending draft merely LABELLED
  --       in_review and as an intake submission by a signed-in publisher
  --       (any creator, or any link id) borrows nothing: it is refused here.
  --       What the database cannot tell apart is a draft a publisher
  --       inserts (or re-shapes by UPDATE) with no member creator and a
  --       link that already scopes the document (document_versions_insert_
  --       integrity / _update_integrity admit a publisher's row whatever its
  --       provenance — DCK-16), nor an earlier reviewed revision a publisher
  --       relabels back to in_review, whose old signed roster satisfies the
  --       roster limb (_update_integrity lets a publisher rewrite
  --       review_state, released_at, superseded_at and supersedes_version_id
  --       — DCK-17). Both are closed in those policies, not here.
  -- The holder's own publish and a publish on an unlocked document never
  -- reach the refusal. A status-only act (supersede, archive, a status
  -- edit) moves no pointer and is not judged here; the service role
  -- returned at the top, as always. Placed after every refusal above and
  -- before the controller return: a write a rule above refuses keeps that
  -- rule's sentence; one the publisher tier below would refuse (no
  -- authority, an active hold) is refused here first when it is also over
  -- another person's checkout.
  IF OLD.checked_out_by IS NOT NULL
     AND OLD.checked_out_by::text <> v_actor::text
     AND NEW.current_version_id IS NOT NULL
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
     AND NOT EXISTS (
           SELECT 1 FROM document_versions v
            WHERE v.id = NEW.current_version_id
              AND v.record_id = NEW.id
              AND v.created_by = v_actor
              AND v.created_at = now()
              AND v.supersedes_version_id IS NOT DISTINCT FROM OLD.current_version_id)
     AND NOT COALESCE(NEW.current_version_id = OLD.pending_version_id
                      AND NEW.pending_version_id IS NULL
                      AND EXISTS (SELECT 1 FROM document_versions v
                                   WHERE v.id = NEW.current_version_id
                                     AND v.record_id = NEW.id
                                     AND v.review_state = 'in_review'
                                     AND (COALESCE(v_primary_reqs, 0) > 0
                                          OR (v.provenance = 'external'
                                              AND (v.created_by IS NULL OR v.created_by = v.intake_link_id)
                                              AND EXISTS (SELECT 1 FROM project_intake_links l
                                                           WHERE l.id = v.intake_link_id
                                                             AND l.org_id = NEW.org_id
                                                             AND (l.id = NEW.authored_by_link_id
                                                                  OR NEW.id = ANY (l.assigned_doc_ids)))))), false) THEN
    RAISE EXCEPTION
      'This document is checked out by %, so a new revision can''t be made current here; publish it from the revision flow with an override reason (shown to them and recorded), or ask them to check it in first.',
      COALESCE(NULLIF(btrim(OLD.checked_out_by_name), ''), 'another user')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- DCK-18 (document-control Round G, P37 DOOR B GUARD — assigned by the
  -- integrator at the P35 merge, DEC-31; ruled under DEC-90: fail-safe, no
  -- regression): two limbs on door (b), the reviewed promote over another
  -- person's checkout the lock leg admits (a review stays finishable).
  -- (b) The intake limb admits only a submission the database can vouch for:
  --     a door-shaped row a signed-in session wrote before 20261247 cannot
  --     be told from a genuine one by its columns. An intake-only promote
  --     (no bound roster) over another person's checkout needs ONE proof
  --     naming the version, written by the service role with no person
  --     named (user_id NULL — audit_logs_insert lets no signed-in session
  --     write one): the door's own INTAKE_DOOR_SUBMITTED record
  --     (intake_door_submit_version, in the door's transaction, both paths —
  --     P37 final fix pass: the route's record comes after, in another
  --     request, and a failed write left a genuine submission unproven);
  --     the intake route's INTAKE_SUBMISSION record; or that record kept as
  --     a SERVER dead letter (no reporter — a browser's names its member
  --     and vouches for nothing), still in audit_dead_letters or drained as
  --     AUDIT_DEAD_LETTER. Else refused in the lock leg's words: the holder
  --     checks in, then it is approved. No checkout, the holder's own, a
  --     roster's and publish_revision's (door (a)) are decided as before.
  IF OLD.checked_out_by IS NOT NULL
     AND OLD.checked_out_by::text <> v_actor::text
     AND NEW.current_version_id IS NOT NULL
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
     AND COALESCE(v_primary_reqs, 0) = 0
     AND NOT EXISTS (
           SELECT 1 FROM document_versions v
            WHERE v.id = NEW.current_version_id
              AND v.record_id = NEW.id
              AND v.created_by = v_actor
              AND v.created_at = now()
              AND v.supersedes_version_id IS NOT DISTINCT FROM OLD.current_version_id)
     AND NOT EXISTS (
           SELECT 1 FROM audit_logs a
            WHERE a.org_id = NEW.org_id
              AND a.resource_type = 'document'
              AND a.resource_id = NEW.id::text
              AND a.action IN ('INTAKE_SUBMISSION', 'INTAKE_DOOR_SUBMITTED')
              AND a.user_id IS NULL
              AND a.details->>'versionId' = NEW.current_version_id::text)
     AND NOT EXISTS (
           SELECT 1 FROM audit_logs a
            WHERE a.org_id = NEW.org_id
              AND a.resource_type = 'org'
              AND a.resource_id = NEW.org_id::text
              AND a.action = 'AUDIT_DEAD_LETTER'
              AND a.user_id IS NULL
              AND a.details->>'lostAction' = 'INTAKE_SUBMISSION'
              AND a.details->>'source' = 'server'
              AND jsonb_typeof(COALESCE(a.details->'reportedBy', 'null'::jsonb)) = 'null'
              AND a.details->'lost'->>'resource_type' = 'document'
              AND a.details->'lost'->>'resource_id' = NEW.id::text
              AND jsonb_typeof(COALESCE(a.details->'lost'->'user_id', 'null'::jsonb)) = 'null'
              AND a.details->'lost'->'details'->>'versionId' = NEW.current_version_id::text) THEN
    -- the route's record kept in the EVID-6 outbox and not drained yet (a
    -- server row: the service role wrote it, no reporter); the outbox is
    -- read only where 20261219 created it, and an outbox that cannot be read
    -- vouches for nothing (the refusal below — the fail-safe direction)
    v_door_b_proof := false;
    IF to_regclass('public.audit_dead_letters') IS NOT NULL THEN
      BEGIN
        SELECT EXISTS (
                 SELECT 1 FROM audit_dead_letters o
                  WHERE o.org_id = NEW.org_id
                    AND o.action = 'INTAKE_SUBMISSION'
                    AND o.source = 'server'
                    AND o.reported_by IS NULL
                    AND o.entry->'row'->>'resource_type' = 'document'
                    AND o.entry->'row'->>'resource_id' = NEW.id::text
                    AND jsonb_typeof(COALESCE(o.entry->'row'->'user_id', 'null'::jsonb)) = 'null'
                    AND o.entry->'row'->'details'->>'versionId' = NEW.current_version_id::text)
          INTO v_door_b_proof;
      EXCEPTION WHEN OTHERS THEN
        v_door_b_proof := false;
      END;
    END IF;
    IF NOT COALESCE(v_door_b_proof, false) THEN
    RAISE EXCEPTION
      'This document is checked out by %, so a new revision can''t be made current here; publish it from the revision flow with an override reason (shown to them and recorded), or ask them to check it in first.',
      COALESCE(NULLIF(btrim(OLD.checked_out_by_name), ''), 'another user')
      USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- (a) The pass is recorded and the holder told, whichever door wrote it.
  --     The three-step PATCH sent by hand reached the database untold and
  --     unrecorded. Now a door-(b) write over another person's checkout the
  --     guard admits (never publish_revision's own) queues the holder's
  --     notice (the EXISTING kind revision_published_over_checkout) and
  --     writes 20261252's REVIEW_PROMOTED_OVER_CHECKOUT row (via 'database',
  --     promote 'direct_write') — unless finalize_reviewed_promote is the
  --     writer: it sets the transaction-local app.review_promote_records to
  --     the document around its own promote and records itself (no double;
  --     a client cannot call set_config). Each write its own sub-block: a
  --     WARNING and the write stands, never a refusal. SECURITY DEFINER: no
  --     row policy, but every trigger (the notification rails, 20261160; the
  --     audit identity stamp, 20261201); a write refused below rolls both
  --     back.
  IF OLD.checked_out_by IS NOT NULL
     AND OLD.checked_out_by::text <> v_actor::text
     AND NEW.current_version_id IS NOT NULL
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
     AND current_setting('app.review_promote_records', true) IS DISTINCT FROM NEW.id::text
     AND NOT EXISTS (
           SELECT 1 FROM document_versions v
            WHERE v.id = NEW.current_version_id
              AND v.record_id = NEW.id
              AND v.created_by = v_actor
              AND v.created_at = now()
              AND v.supersedes_version_id IS NOT DISTINCT FROM OLD.current_version_id) THEN
    SELECT v.revision_label INTO v_door_b_label FROM document_versions v WHERE v.id = NEW.current_version_id;
    v_door_b_rev := COALESCE(NULLIF(btrim(COALESCE(NEW.rev, '')), ''), v_door_b_label, 'the reviewed revision');
    v_door_b_who := COALESCE((SELECT NULLIF(btrim(m.email), '') FROM org_members m
                               WHERE m.org_id = NEW.org_id AND m.uid = v_actor LIMIT 1),
                             v_actor::text);
    v_door_b_told := false;
    BEGIN
      INSERT INTO notifications (org_id, user_id, kind, title, body, link, resource_type, resource_id, actor_user_id, actor_name, metadata)
      VALUES (NEW.org_id, OLD.checked_out_by::text::uuid, 'revision_published_over_checkout',
              'Reviewed Rev ' || v_door_b_rev || ' published while you''re checked out',
              v_door_b_who || ' published the reviewed revision'
                || CASE WHEN v_door_b_label IS NOT NULL AND v_door_b_label <> v_door_b_rev THEN ' (reviewed as ' || v_door_b_label || ')' ELSE '' END
                || '. Your checkout stays open — check your work against Rev ' || v_door_b_rev || ' before you publish.',
              '/documents/' || NEW.library_id::text || '?doc=' || NEW.id::text, 'document', NEW.id::text,
              v_actor, v_door_b_who,
              jsonb_build_object('newVersionId', NEW.current_version_id, 'newRev', v_door_b_rev, 'via', 'database'));
      GET DIAGNOSTICS v_door_b_n = ROW_COUNT;
      v_door_b_told := v_door_b_n > 0;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'enforce_document_publish_guard: the reviewed revision was made current over the checkout of %, but their notice was not written (the write stands): %', OLD.checked_out_by, SQLERRM;
    END;
    BEGIN
      INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
      VALUES ('REVIEW_PROMOTED_OVER_CHECKOUT', NEW.id::text, 'document', NEW.org_id, v_actor,
              (SELECT m.email FROM org_members m WHERE m.org_id = NEW.org_id AND m.uid = v_actor LIMIT 1),
              jsonb_build_object(
                'via', 'database',
                'promote', 'direct_write',
                'holderUserId', OLD.checked_out_by::text,
                'holderName', NULLIF(btrim(COALESCE(OLD.checked_out_by_name, '')), ''),
                'holderNotified', v_door_b_told,
                'versionId', NEW.current_version_id,
                'previousVersionId', OLD.current_version_id,
                'revisionLabel', v_door_b_rev
              ));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'enforce_document_publish_guard: the reviewed revision was made current over the checkout of %, but the record was not written (the write stands): %', OLD.checked_out_by, SQLERRM;
    END;
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
REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ── DCK-18 (P37): finalize_reviewed_promote — 20261252 body + its flag ──────
-- Same eight-argument signature (CREATE OR REPLACE keeps it — no PostgREST
-- schema change); grants restated as 20261252 left them.
CREATE OR REPLACE FUNCTION finalize_reviewed_promote(
  p_document_id uuid,
  p_pending_id uuid,
  p_expected_current uuid,
  p_base_rev text,
  p_actor uuid DEFAULT NULL,
  p_force_hold boolean DEFAULT false,
  p_override_reason text DEFAULT NULL,
  p_report_over_checkout boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_now timestamptz := now();
  v_n   integer;
  v_org uuid;
  v_hold_forced boolean := false;
  v_lib text;
  v_holder text;
  v_holder_name text;
  v_draft_label text;
  v_who text;
  v_over boolean := false;
  v_recorded boolean := false;
  v_told boolean := false;
BEGIN
  -- REV-20 (P14 final review): a controller's force past an active hold is
  -- an ACT, as publish_revision's (§4 below). It is honoured only for a
  -- controller — the session's tier as the publish guard reads it
  -- (is_org_controller), or, for a service-role call, the named actor's,
  -- re-derived as publish_revision derives it — and only while a hold is
  -- active. The guard then admits this promote over the hold under the
  -- transaction-local flag set around it, and the force is recorded below in
  -- the same transaction (REV_HOLD_OVERRIDDEN). Anyone else's force is
  -- ignored: the guard refuses their promote over a hold in its own words.
  IF p_force_hold THEN
    SELECT d.org_id INTO v_org FROM documents d WHERE d.id = p_document_id;
    IF v_org IS NOT NULL
       AND (CASE WHEN auth.uid() IS NOT NULL THEN is_org_controller(v_org)
                 ELSE EXISTS (SELECT 1 FROM org_members m
                               WHERE m.org_id = v_org AND m.uid = p_actor AND m.status = 'active'
                                 AND (m.role IN ('Admin','DocCtrl') OR m.roles && ARRAY['Admin','DocCtrl']::text[]))
            END)
       AND EXISTS (SELECT 1 FROM document_holds h
                    WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN
      v_hold_forced := TRUE;
    END IF;
  END IF;

  -- The promote: the write trg_document_publish_guard inspects, AS THE
  -- CALLER. Compare-and-set on both pointers: a concurrent finaliser (the
  -- promote clears pending_version_id) or a document that moved on matches
  -- no row, and nothing else is written.
  IF v_hold_forced THEN
    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);
  END IF;
  -- DCK-18 (document-control P37, 20261254): this promote records the pass
  -- over a checkout and tells the holder itself (below), so the publish
  -- guard's own record of a door-(b) pass is not written for it — the
  -- transaction-local flag names this document for the one statement, as
  -- the hold override's does, and is cleared right after it.
  PERFORM set_config('app.review_promote_records', p_document_id::text, true);
  UPDATE documents
     SET current_version_id = p_pending_id,
         rev = p_base_rev,
         revision = p_base_rev,
         status = 'Issued',
         pending_version_id = NULL,
         updated_at = v_now,
         updated_by = COALESCE(auth.uid(), p_actor)
   WHERE id = p_document_id
     AND pending_version_id = p_pending_id
     AND current_version_id IS NOT DISTINCT FROM p_expected_current;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_hold_forced THEN
    PERFORM set_config('app.publish_hold_override', '', true);
  END IF;
  PERFORM set_config('app.review_promote_records', '', true);
  IF v_n = 0 THEN
    RETURN 'no_match';
  END IF;

  -- DCK-18 (document-control P35): who holds the checkout, read in the
  -- promote's own transaction. The promote above writes no checkout column
  -- and no trigger rewrites one, so these are the row's values before it
  -- (OLD's); the row stays locked by the promote until the transaction ends.
  -- The draft's own label is read before the relabel below drops its letter.
  SELECT d.org_id, d.library_id::text, d.checked_out_by::text, NULLIF(btrim(COALESCE(d.checked_out_by_name, '')), '')
    INTO v_org, v_lib, v_holder, v_holder_name
    FROM documents d WHERE d.id = p_document_id;
  SELECT v.revision_label INTO v_draft_label FROM document_versions v WHERE v.id = p_pending_id;

  -- The bookkeeping, in the SAME transaction: the approved draft drops its
  -- letter and is released; a write that matches no row rolls the promote
  -- back with it, so current_version_id never names a row still in_review.
  UPDATE document_versions
     SET review_state = 'approved',
         revision_label = p_base_rev,
         released_at = v_now,
         supersedes_version_id = p_expected_current,
         updated_at = v_now
   WHERE id = p_pending_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'The approved draft could not be relabeled to Rev %, so nothing was published; the document is unchanged.', p_base_rev
      USING ERRCODE = 'check_violation';
  END IF;

  -- The prior revision is superseded with it. A pointer that named no row
  -- (a dangling current_version_id, counted by 20261131) has nothing to
  -- supersede; a row that exists and was not updated refuses the whole act.
  IF p_expected_current IS NOT NULL THEN
    UPDATE document_versions SET superseded_at = v_now WHERE id = p_expected_current;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 AND EXISTS (SELECT 1 FROM document_versions v WHERE v.id = p_expected_current) THEN
      RAISE EXCEPTION 'The prior revision could not be marked superseded, so nothing was published; the document is unchanged.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- REV-20 (P14 final review): the force past a hold is on the document's
  -- record in the same transaction — a record that cannot be written rolls
  -- the promote back with it. Written as the caller: audit_logs' insert
  -- policy admits the session's own row in its own org.
  IF v_hold_forced THEN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('REV_HOLD_OVERRIDDEN', p_document_id::text, 'document', v_org, COALESCE(auth.uid(), p_actor),
            (SELECT m.email FROM org_members m WHERE m.org_id = v_org AND m.uid = COALESCE(auth.uid(), p_actor) LIMIT 1),
            jsonb_build_object(
              'via', 'review_promote',
              'holds', (SELECT jsonb_agg(jsonb_build_object('id', h.id, 'reason', h.reason) ORDER BY h.opened_at)
                          FROM document_holds h
                         WHERE h.document_id = p_document_id AND h.released_at IS NULL),
              'reason', NULLIF(btrim(COALESCE(p_override_reason, '')), ''),
              'versionId', p_pending_id,
              'revisionLabel', p_base_rev,
              'newStatus', 'Issued',
              'branch', false
            ));
  END IF;

  -- DCK-18 (document-control P35): a reviewed promote over a checkout held
  -- by someone OTHER than the actor (the publish guard's door (b), ratified
  -- under DEC-90 — a review stays finishable) is recorded and the holder is
  -- told, in the promote's own transaction, whichever caller ran it (the app,
  -- a direct PostgREST call, the service role naming p_actor). Never a
  -- refusal: each write runs in its own sub-block, so a notice or a record
  -- that cannot be written is a WARNING and the promote stands — the app,
  -- which asks for the answer (p_report_over_checkout), writes whatever this
  -- left unwritten. Written as the caller, as the app's own notice and record
  -- are: the notice of the existing kind revision_published_over_checkout
  -- passes the notification insert rails (20261160: the signed-in member is
  -- its actor, a declared kind, an app-relative link; a recipient who is no
  -- longer an active member is skipped); the record, REVIEW_PROMOTED_OVER_
  -- CHECKOUT with via 'database', is the session's own row in its own org
  -- (audit_logs_insert). The service role (no auth.uid()) names p_actor.
  IF v_holder IS NOT NULL AND v_holder IS DISTINCT FROM COALESCE(auth.uid(), p_actor)::text THEN
    v_over := true;
    v_who := COALESCE((SELECT NULLIF(btrim(m.email), '') FROM org_members m
                        WHERE m.org_id = v_org AND m.uid = COALESCE(auth.uid(), p_actor) LIMIT 1),
                      COALESCE(auth.uid(), p_actor)::text, 'Someone');
    BEGIN
      INSERT INTO notifications (org_id, user_id, kind, title, body, link, resource_type, resource_id, actor_user_id, actor_name, metadata)
      VALUES (v_org, v_holder::uuid, 'revision_published_over_checkout',
              'Reviewed Rev ' || p_base_rev || ' published while you''re checked out',
              v_who || ' published the reviewed revision'
                || CASE WHEN v_draft_label IS NOT NULL AND v_draft_label <> p_base_rev THEN ' (reviewed as ' || v_draft_label || ')' ELSE '' END
                || '. Your checkout stays open — check your work against Rev ' || p_base_rev || ' before you publish.',
              '/documents/' || v_lib || '?doc=' || p_document_id::text, 'document', p_document_id::text,
              COALESCE(auth.uid(), p_actor), v_who,
              jsonb_build_object('newVersionId', p_pending_id, 'newRev', p_base_rev, 'via', 'database'));
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_told := v_n > 0;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'finalize_reviewed_promote: the reviewed revision was published over the checkout of %, but their notice was not written (the publish stands): %', v_holder, SQLERRM;
    END;
    BEGIN
      INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
      VALUES ('REVIEW_PROMOTED_OVER_CHECKOUT', p_document_id::text, 'document', v_org, COALESCE(auth.uid(), p_actor),
              (SELECT m.email FROM org_members m WHERE m.org_id = v_org AND m.uid = COALESCE(auth.uid(), p_actor) LIMIT 1),
              jsonb_build_object(
                'via', 'database',
                'holderUserId', v_holder,
                'holderName', v_holder_name,
                'holderNotified', v_told,
                'versionId', p_pending_id,
                'previousVersionId', p_expected_current,
                'revisionLabel', p_base_rev
              ));
      v_recorded := true;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'finalize_reviewed_promote: the reviewed revision was published over the checkout of %, but the record was not written (the publish stands): %', v_holder, SQLERRM;
    END;
  END IF;

  -- The answer: exactly 'promoted' as before unless the caller asks for the
  -- report (the app since P35), which says whether a checkout was passed and
  -- which of the two writes landed, so the app neither doubles nor drops one.
  IF p_report_over_checkout THEN
    RETURN CASE WHEN NOT v_over THEN 'promoted_clear'
                ELSE 'promoted_over_checkout'
                     || CASE WHEN v_recorded THEN '_recorded' ELSE '' END
                     || CASE WHEN v_told THEN '_told' ELSE '' END
           END;
  END IF;
  RETURN 'promoted';
END;
$$;
REVOKE ALL ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) TO authenticated, service_role;

-- ── REV-37 (P37): retire_over_hold — 20261253 body + the park's binding ────
CREATE OR REPLACE FUNCTION retire_over_hold(
  p_document_id uuid,
  p_via text,
  p_reason text,
  p_at timestamptz DEFAULT NULL,
  p_supersession_moc text DEFAULT NULL,
  p_force_hold boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_found   boolean;
  v_org     uuid;
  v_status  text;
  v_version uuid;
  v_rev     text;
  v_at      timestamptz := COALESCE(p_at, now());
  v_forced  boolean := false;
  v_n       integer;
BEGIN
  -- DRLS-16: a signed-in act only. A call with no session (anon, or the
  -- service role, whose writes the guard never judges) never sets the flag.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'retire_over_hold: a retirement over a hold is a signed-in act, and this call has no session.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_via IS NULL OR p_via NOT IN ('split', 'merge', 'reversal_park') THEN
    RAISE EXCEPTION 'retire_over_hold: name the door (split, merge or reversal_park).'
      USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'retire_over_hold: give the supersession''s reason.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The document, as the caller sees it.
  SELECT true, d.org_id, d.status, d.current_version_id, d.rev
    INTO v_found, v_org, v_status, v_version, v_rev
    FROM documents d WHERE d.id = p_document_id;
  IF v_found IS NULL THEN
    RETURN 'no_match';
  END IF;

  -- The recorded door: exactly the write the guard refuses bare since this
  -- migration — Document Control taking a document into Superseded from any
  -- other status while a hold stands — and only when the caller asks for the
  -- override (p_force_hold: chosen, never implied). Anything else is the
  -- bare write below.
  IF COALESCE(p_force_hold, false)
     AND v_status IS DISTINCT FROM 'Superseded'
     AND is_org_controller(v_org)
     AND EXISTS (SELECT 1 FROM document_holds h
                  WHERE h.document_id = p_document_id AND h.released_at IS NULL) THEN
    v_forced := true;
  END IF;

  -- REV-37 (document-control Round G, P37 DOOR B GUARD, 20261254 — ruled
  -- under DEC-90): the reversal's park over a hold is bound to the reversal
  -- being run, as restore_reversed_source binds its restore — a document a
  -- recorded split names among its replacementDocIds, or a recorded merge as
  -- its mergedIntoDocumentId, in this workspace, its reversal not landed (no
  -- DOC_SPLIT_REVERSED / DOC_MERGE_REVERSED naming the event): what
  -- lib/documentLifecycle/reverse.ts parks. Anything else: 42501, nothing
  -- changed. The split / merge source flip is not bound: its evidence is
  -- written by the saga AFTER the flip, in other requests, so a binding
  -- would refuse every genuine split or merge over a hold — the integrator's
  -- ruling, recorded on REV-37: the recorded Document Control
  -- pass is enough there.
  IF v_forced
     AND p_via = 'reversal_park'
     AND NOT EXISTS (
           SELECT 1
             FROM audit_logs e
            WHERE e.org_id = v_org
              AND ((e.action = 'DOC_SPLIT'
                    AND jsonb_typeof(e.details->'replacementDocIds') = 'array'
                    AND (e.details->'replacementDocIds') ? p_document_id::text)
                   OR (e.action = 'DOC_MERGED'
                       AND e.details->>'mergedIntoDocumentId' = p_document_id::text))
              AND NOT EXISTS (SELECT 1 FROM audit_logs r
                               WHERE r.org_id = v_org
                                 AND r.resource_id = e.resource_id
                                 AND r.action IN ('DOC_SPLIT_REVERSED', 'DOC_MERGE_REVERSED')
                                 AND translate(lower(r.details->>'reversedAuditEventId'), '{}-', '') = replace(e.id::text, '-', ''))
         ) THEN
    RAISE EXCEPTION 'retire_over_hold: a reversal parks a held document only when a recorded split names it among its replacements, or a recorded merge as its target, and that operation has not been reversed — none was found; nothing was changed.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The write: the door's own, as the caller. The flag names this document
  -- for this one statement only.
  IF v_forced THEN
    PERFORM set_config('app.publish_hold_override', p_document_id::text, true);
  END IF;
  IF p_via = 'reversal_park' THEN
    UPDATE documents
       SET status = 'Superseded',
           superseded_at = v_at,
           superseded_by_user = v_uid,
           supersession_reason = p_reason,
           updated_at = v_at,
           updated_by = v_uid
     WHERE id = p_document_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    UPDATE documents
       SET status = 'Superseded',
           superseded_at = v_at,
           superseded_by_user = v_uid,
           supersession_reason = p_reason,
           supersession_moc = p_supersession_moc,
           updated_at = v_at,
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
  -- transaction. Written as the caller: audit_logs' insert policy admits the
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
              'retiredOverHold', true,
              'versionId', v_version,
              'revisionLabel', v_rev,
              'priorStatus', v_status,
              'newStatus', 'Superseded',
              'branch', false
            ));
  END IF;

  RETURN CASE WHEN v_forced THEN 'superseded_over_hold' ELSE 'superseded' END;
END;
$$;
COMMENT ON FUNCTION retire_over_hold(uuid, text, text, timestamptz, text, boolean) IS
  'REV-36 (20261253): the split / merge supersession of a source and a reversal''s park of a sheet (lib/documentLifecycle/common.ts markSupersededAndLink, reverse.ts parkAsSuperseded; p_via split, merge or reversal_park), writing the door''s own columns, called by the app only when Document Control chose to proceed over an active hold (HLD-2). SECURITY INVOKER: the caller''s row-level policies and trg_document_publish_guard decide the write exactly as for a bare UPDATE. For Document Control taking a document into Superseded from any other status while a hold is active and asking for the override (p_force_hold — chosen, never implied), the write runs under the transaction-local flag app.publish_hold_override and the pass is recorded as REV_HOLD_OVERRIDDEN in the same transaction. REV-37 (20261254): a recorded reversal_park needs the reversal being run — a recorded split naming the document among its replacements, or a merge as its target, not reversed — else 42501, nothing changed. Returns superseded_over_hold (that recorded pass), superseded (the bare write) or no_match; refuses a call with no session.';
-- DRLS-16: authenticated only (the body refuses a NULL uid too), as before.
REVOKE ALL ON FUNCTION retire_over_hold(uuid, text, text, timestamptz, text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION retire_over_hold(uuid, text, text, timestamptz, text, boolean) TO authenticated;

-- ── DCK-18 (P37 final fix pass): intake_door_submit_version — 20261214 body ──
-- + the door's own record of its submission. Same signature; grants restated.
CREATE OR REPLACE FUNCTION public.intake_door_submit_version(p_token_hash text, p_version jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_door jsonb := intake_door_resolve(p_token_hash);
  v_link uuid  := (v_door->>'link_id')::uuid;
  v_org  uuid  := (v_door->>'org_id')::uuid;
  v_proj uuid  := (v_door->>'project_id')::uuid;
  v_v    document_versions%ROWTYPE;
  v_prev jsonb;
  v_id   uuid  := gen_random_uuid();
  v_rls  boolean := intake_door_version_rls_ready();
  v_role text  := current_setting('role');
BEGIN
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF jsonb_typeof(p_version) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'intake_door: one version object is required.' USING ERRCODE = '22023';
  END IF;
  v_v := jsonb_populate_record(NULL::document_versions, p_version);
  IF NOT EXISTS (SELECT 1 FROM documents d
                  WHERE d.id = v_v.record_id AND d.org_id = v_org
                    AND (d.authored_by_link_id = v_link
                         OR d.id::text IN (SELECT jsonb_array_elements_text(v_door->'assigned')))) THEN
    RAISE EXCEPTION 'intake_door: this link submits only to its own or assigned documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF v_v.file_url IS NULL OR v_v.file_url !~ ('^orgs/' || v_org::text || '/project-intake/' || v_proj::text || '/[^/]+$') THEN
    RAISE EXCEPTION 'intake_door: the file is not stored under this link''s project.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF v_v.supersedes_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM document_versions b WHERE b.id = v_v.supersedes_version_id AND b.record_id = v_v.record_id) THEN
    RAISE EXCEPTION 'intake_door: the base revision is not a revision of this document.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);
  -- OWN-4: an external upload is in review until a person decides; its link,
  -- its provenance and its org are the door's, never the caller's.
  -- SEC-22 (a) (J20): the INSERT as intake_door, under row-level security
  -- (document_versions_intake_door_* and every policy written for all roles);
  -- the id is chosen here, as a RETURNING would also need read policies. A
  -- privilege the role lacks that intake_door_version_rls_ready could not
  -- foresee ("permission denied …"), or the refusal of a NAMED policy that is
  -- not the door's own, is undone with its role switch, leaves a WARNING and
  -- runs the same INSERT once more with the bound identity alone — the shape
  -- before this file. The door's own policies' refusal (none permissive
  -- admitted the row — Postgres names none — or the scope policy, named) and
  -- every other error are raised: they are the link's boundary.
  LOOP
    BEGIN
      IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;
      INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, file_type, size, change_log,
                                     created_by_name, created_at, released_at, review_state, provenance,
                                     intake_link_id, file_hash, supersedes_version_id)
      VALUES (v_id, v_org, v_v.record_id, v_v.revision_label, v_v.file_url, v_v.file_type, v_v.size, v_v.change_log,
              v_v.created_by_name, COALESCE(v_v.created_at, NOW()), NULL, 'in_review', 'external',
              v_link, v_v.file_hash, v_v.supersedes_version_id);
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      EXIT;
    EXCEPTION WHEN insufficient_privilege THEN
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      IF NOT v_rls
         OR SQLERRM IN ('new row violates row-level security policy for table "document_versions"',
                        'new row violates row-level security policy "document_versions_intake_door_scope" for table "document_versions"')
         OR NOT (SQLERRM LIKE 'permission denied%' OR SQLERRM LIKE 'new row violates row-level security policy "%') THEN
        RAISE;
      END IF;
      RAISE WARNING 'intake_door_submit_version: % — this submission is written with the bound identity alone, without row-level security (projects-tab SEC-22).', SQLERRM;
      v_rls := false;
    END;
  END LOOP;
  PERFORM intake_door_unbind(v_prev);
  -- DCK-18 (b) (document-control Round G, P37 final fix pass, 20261254 — the
  -- integrator's ruling (1), DEC-90): the door's own record of the submission
  -- it inserted, in its own transaction — the proof door (b)'s intake limb
  -- reads even when the route's later INTAKE_SUBMISSION write fails. After
  -- the role switch and bound identity are undone: as the caller (the
  -- service role only), no person named. Both paths reach it (insertedAs).
  -- Its own sub-block: a WARNING, and the submission stands.
  BEGIN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('INTAKE_DOOR_SUBMITTED', v_v.record_id::text, 'document', v_org, NULL, NULL,
            jsonb_build_object(
              'versionId', v_id,
              'linkId', v_link,
              'projectId', v_proj,
              'revisionLabel', v_v.revision_label,
              'insertedAs', CASE WHEN v_rls THEN 'intake_door' ELSE 'bound_identity' END,
              'via', 'intake_door_submit_version'
            ));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'intake_door_submit_version: the submission % was filed, but the door''s own record of it was not written (the submission stands): %', v_id, SQLERRM;
  END;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.intake_door_submit_version(text, jsonb) IS
  'GAP-401 (J16): the contractor door inserts an in-review external submission on a document its link authored or was assigned, its file under the link''s project prefix, as the door''s identity. SEC-22 (a) (J20, 20261214): where the paste could grant it, as the role intake_door under the document_versions_intake_door_* policies (SECURITY INVOKER, the 20261184 role switch). DCK-18 (b) (20261254): then records the submission in its own transaction (INTAKE_DOOR_SUBMITTED, no person named, naming the version) — the proof the publish guard''s door (b) intake limb reads; a record that cannot be written leaves a WARNING and the submission stands. Service role only.';
REVOKE ALL ON FUNCTION public.intake_door_submit_version(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_door_submit_version(text, jsonb) TO service_role;

-- ── REV-37 (P37): the write rail for REV_HOLD_OVERRIDDEN ────────────────────
-- put_back_retired_issue (20261253) reads a reversal's REV_HOLD_OVERRIDDEN row
-- (via reversal_restore) as evidence, and audit_logs_insert admitted any row a
-- member writes with their own user_id. Every legitimate row is written by a
-- database function after its own write of the document it names, in the same
-- transaction (finalize_reviewed_promote, put_back_retired_issue,
-- restore_reversed_source, retire_over_hold after their UPDATE; publish_revision
-- after its INSERT of the version details.versionId names, on both arms). So
-- a signed-in session's row is admitted only when that documents row's xmin,
-- or that version's (of that document, in that workspace), is a transaction
-- of this session (pg_xact_status 'in progress' — another session's row is
-- visible only once committed). The xmin is widened to 64 bits from the
-- current epoch; a status that cannot be read refuses (fail-safe). The
-- service role, a restore and the SQL console (no auth.uid()) pass. SECURITY
-- DEFINER, search_path pinned; no client role may call it.
CREATE OR REPLACE FUNCTION public.enforce_hold_override_record_rail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_xmins  bigint[] := ARRAY[]::bigint[];
  v_xmin   bigint;
  v_cur    bigint;
  v_full   bigint;
  v_status text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service role, a restore, the SQL console
  IF NEW.resource_type = 'document'
     AND COALESCE(NEW.resource_id, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT d.xmin::text::bigint INTO v_xmin
      FROM documents d
     WHERE d.id = NEW.resource_id::uuid AND d.org_id = NEW.org_id;
    IF v_xmin IS NOT NULL THEN
      v_xmins := v_xmins || v_xmin;
      -- the version proof (publish_revision's branch arm writes no documents
      -- row — only the version and its revision_branches row): the version
      -- the row names (details.versionId), of this document in this
      -- workspace, inserted by this transaction.
      IF COALESCE(NEW.details->>'versionId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_xmin := NULL;
        SELECT v.xmin::text::bigint INTO v_xmin
          FROM document_versions v
         WHERE v.id = (NEW.details->>'versionId')::uuid
           AND v.record_id = NEW.resource_id::uuid AND v.org_id = NEW.org_id;
        IF v_xmin IS NOT NULL THEN
          v_xmins := v_xmins || v_xmin;
        END IF;
      END IF;
    END IF;
    FOREACH v_xmin IN ARRAY v_xmins LOOP
      v_status := NULL;
      BEGIN
        v_cur := pg_current_xact_id()::text::bigint;
        v_full := (v_cur - (v_cur % 4294967296)) + v_xmin;
        IF v_full > v_cur + 2147483648 THEN
          v_full := v_full - 4294967296;
        END IF;
        IF v_full >= 0 THEN
          v_status := pg_xact_status(v_full::text::xid8);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_status := NULL;
      END;
      IF v_status = 'in progress' THEN
        RETURN NEW;
      END IF;
    END LOOP;
  END IF;
  RAISE EXCEPTION 'A hold-override record (REV_HOLD_OVERRIDDEN) is written only by the database function that made the write it records, in that write''s own transaction; nothing was changed. (REV-37, 20261254)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION public.enforce_hold_override_record_rail() IS
  'REV-37 (20261254): BEFORE INSERT on audit_logs for REV_HOLD_OVERRIDDEN. A signed-in session''s row is admitted only when this transaction wrote the document it names (its documents row, or the version details.versionId names, of that document); else 42501. The service role passes. Nobody may call it.';

REVOKE ALL ON FUNCTION public.enforce_hold_override_record_rail() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_hold_override_record_rail() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_hold_override_record_rail() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_hold_override_record_rail() FROM service_role;

DROP TRIGGER IF EXISTS trg_audit_logs_hold_override_rail ON audit_logs;
CREATE TRIGGER trg_audit_logs_hold_override_rail
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  WHEN (NEW.action = 'REV_HOLD_OVERRIDDEN')
  EXECUTE FUNCTION public.enforce_hold_override_record_rail();

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 11. Inventory rows (7): n = the aggregate count.
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here).
SELECT 'DCK-18 (P37) (b): over another person''s checkout an intake-only promote needs a proof naming the version, no person named (the door''s INTAKE_DOOR_SUBMITTED, the route''s INTAKE_SUBMISSION, or its server dead letter), else 42501' AS check,
       (SELECT prosrc LIKE '%AND COALESCE(v_primary_reqs, 0) = 0%AND v.created_at = now()%SELECT 1 FROM audit_logs a%AND a.action IN (''INTAKE_SUBMISSION'', ''INTAKE_DOOR_SUBMITTED'')%AND a.user_id IS NULL%AND a.details->>''versionId'' = NEW.current_version_id::text)%AND a.action = ''AUDIT_DEAD_LETTER''%AND a.details->>''source'' = ''server''%AND a.details->''lost''->''details''->>''versionId'' = NEW.current_version_id::text) THEN%IF to_regclass(''public.audit_dead_letters'') IS NOT NULL THEN%AND o.source = ''server''%AND o.reported_by IS NULL%IF NOT COALESCE(v_door_b_proof, false) THEN%USING ERRCODE = ''insufficient_privilege'';%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'DCK-18 (P37) (a): a door-(b) write over another person''s checkout outside finalize_reviewed_promote queues the holder''s notice and writes REVIEW_PROMOTED_OVER_CHECKOUT, each a WARNING never a refusal',
       (SELECT prosrc LIKE '%AND current_setting(''app.review_promote_records'', true) IS DISTINCT FROM NEW.id::text%INSERT INTO notifications%''revision_published_over_checkout''%EXCEPTION WHEN OTHERS THEN%RAISE WARNING%INSERT INTO audit_logs%''REVIEW_PROMOTED_OVER_CHECKOUT''%''via'', ''database''%''promote'', ''direct_write''%EXCEPTION WHEN OTHERS THEN%RAISE WARNING%IF is_org_controller(NEW.org_id) THEN%RETURN NEW;%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'HAND-13 (P32) and REV-36 (P36) survive the re-create: the lock leg (42501) and the hold leg (check_violation) are both still in the guard, before the P37 limbs',
       (SELECT prosrc LIKE '%IF COALESCE(NEW.status IN (''Superseded'', ''Void''), false)%''Document has an active hold; a held document can''''t be superseded or voided here%IF OLD.checked_out_by IS NOT NULL%AND OLD.checked_out_by::text <> v_actor::text%AND NOT COALESCE(NEW.current_version_id = OLD.pending_version_id%''This document is checked out by %, so a new revision can''''t be made current here;%AND COALESCE(v_primary_reqs, 0) = 0%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'the guard is SECURITY DEFINER with search_path pinned, no client role may execute it, and trg_document_publish_guard still fires it BEFORE UPDATE only',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')
       AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgname = 'trg_document_publish_guard' AND NOT t.tgisinternal
                      AND t.tgrelid = 'documents'::regclass AND p.proname = 'enforce_document_publish_guard'
                      AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0),
       NULL
UNION ALL
SELECT 'DCK-18 (P37): finalize_reviewed_promote sets and clears app.review_promote_records around its promote; its P35 record survives; one eight-argument SECURITY INVOKER signature, authenticated and service_role only',
       (SELECT prosrc LIKE '%PERFORM set_config(''app.review_promote_records'', p_document_id::text, true);%UPDATE documents%SET current_version_id = p_pending_id,%PERFORM set_config(''app.review_promote_records'', '''', true);%IF v_n = 0 THEN%''REVIEW_PROMOTED_OVER_CHECKOUT''%IF p_report_over_checkout THEN%RETURN ''promoted'';%'
          FROM pg_proc WHERE proname = 'finalize_reviewed_promote')
       AND (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'finalize_reviewed_promote')
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'finalize_reviewed_promote' AND p.pronargs = 8
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND has_function_privilege('authenticated', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean)', 'EXECUTE')
       AND has_function_privilege('service_role', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'REV-37 (P37): retire_over_hold''s recorded reversal_park needs an unreversed recorded split / merge naming the document, else 42501 before any write; SECURITY INVOKER, authenticated only',
       (SELECT prosrc LIKE '%v_forced := true;%IF v_forced%AND p_via = ''reversal_park''%AND NOT EXISTS (%e.action = ''DOC_SPLIT''%(e.details->''replacementDocIds'') ? p_document_id::text%e.action = ''DOC_MERGED''%e.details->>''mergedIntoDocumentId'' = p_document_id::text%r.action IN (''DOC_SPLIT_REVERSED'', ''DOC_MERGE_REVERSED'')%USING ERRCODE = ''insufficient_privilege'';%PERFORM set_config(''app.publish_hold_override'', p_document_id::text, true);%VALUES (''REV_HOLD_OVERRIDDEN''%'
          FROM pg_proc WHERE proname = 'retire_over_hold')
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'retire_over_hold'
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'retire_over_hold')
       AND has_function_privilege('authenticated', 'retire_over_hold(uuid, text, text, timestamptz, text, boolean)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'retire_over_hold(uuid, text, text, timestamptz, text, boolean)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'REV-37 (P37): the REV_HOLD_OVERRIDDEN rail admits a signed-in session''s row only in the transaction that wrote its document or the version it names (else 42501); the service role passes',
       (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%SELECT d.xmin::text::bigint INTO v_xmin%WHERE d.id = NEW.resource_id::uuid AND d.org_id = NEW.org_id;%SELECT v.xmin::text::bigint INTO v_xmin%WHERE v.id = (NEW.details->>''versionId'')::uuid%AND v.record_id = NEW.resource_id::uuid AND v.org_id = NEW.org_id;%FOREACH v_xmin IN ARRAY v_xmins LOOP%pg_xact_status(v_full::text::xid8)%IF v_status = ''in progress'' THEN%RETURN NEW;%USING ERRCODE = ''insufficient_privilege'';%'
          FROM pg_proc WHERE proname = 'enforce_hold_override_record_rail'),
       NULL
UNION ALL
SELECT 'DCK-18 (P37) (b): intake_door_submit_version records its submission (INTAKE_DOOR_SUBMITTED, no person named) after the unbind, in its own sub-block; its 20261214 role switch and fallback survive',
       (SELECT prosrc LIKE '%IF v_rls THEN PERFORM set_config(''role'', ''intake_door'', true); END IF;%INSERT INTO document_versions%RAISE WARNING ''intake_door_submit_version: % — this submission is written with the bound identity alone%PERFORM intake_door_unbind(v_prev);%INSERT INTO audit_logs%''INTAKE_DOOR_SUBMITTED'', v_v.record_id::text, ''document'', v_org, NULL, NULL,%''versionId'', v_id,%EXCEPTION WHEN OTHERS THEN%RAISE WARNING%RETURN v_id;%'
          FROM pg_proc WHERE proname = 'intake_door_submit_version'),
       NULL
UNION ALL
SELECT 'DRLS-16: intake_door_submit_version: one, SECURITY INVOKER, search_path pinned, the service role only',
       (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'intake_door_submit_version')
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'intake_door_submit_version' AND p.pronargs = 2
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND has_function_privilege('service_role', 'public.intake_door_submit_version(text, jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.intake_door_submit_version(text, jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.intake_door_submit_version(text, jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'DRLS-16: the rail is SECURITY DEFINER with search_path pinned, no client role may execute it, and trg_audit_logs_hold_override_rail fires it BEFORE INSERT on audit_logs for REV_HOLD_OVERRIDDEN only',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_hold_override_record_rail'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'enforce_hold_override_record_rail()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_hold_override_record_rail()', 'EXECUTE')
       AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgname = 'trg_audit_logs_hold_override_rail' AND NOT t.tgisinternal
                      AND t.tgrelid = 'audit_logs'::regclass AND p.proname = 'enforce_hold_override_record_rail'
                      AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 0
                      AND pg_get_triggerdef(t.oid) LIKE '%WHEN ((new.action = ''REV_HOLD_OVERRIDDEN''::text))%'),
       NULL
UNION ALL
SELECT 'the holder''s notice is of a declared kind (notification_kinds() lists revision_published_over_checkout, untouched here — or the registry is absent and the rail with it)',
       COALESCE((SELECT bool_or(prosrc LIKE '%(''revision_published_over_checkout'',%') FROM pg_proc WHERE proname = 'notification_kinds'), true),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_g_254_before;
