-- ─────────────────────────────────────────────────────────────────────────────
-- 20261151_dc_roundF_promote_transaction_and_hold_override.sql
--
-- document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS: the
-- review promote as ONE transaction (RG-12), and a controller's issue over an
-- active hold only through the recorded override (REV-20).
--
--   RG-12   finalizeReviewedRevision (lib/reviewControl.ts) promoted the
--           approved draft with one PostgREST UPDATE of documents, THEN
--           relabeled / approved the draft and stamped the prior revision
--           superseded in two more. Each is checked (Round E / Round F wave
--           1), but they are three transactions: a refused or failed
--           bookkeeping write left current_version_id pointing at a row still
--           marked in_review ('2A', released_at NULL) beside a prior revision
--           still un-superseded — the incident is named, not prevented.
--           finalize_reviewed_promote (new) does the three writes in ONE
--           function call — one transaction: the promote (compare-and-set on
--           both pointers, as the app's), then the relabel / approve, then the
--           supersede; a bookkeeping write that matches no row RAISEs, so the
--           promote rolls back with it and the document is left exactly as it
--           was. SECURITY INVOKER: every write runs as the caller — their
--           row-level policies (document_versions_update_integrity's
--           publisher-grade arm) and trg_document_publish_guard's authority,
--           hold, review and independence rules apply exactly as to the
--           app's own UPDATE. updated_by is the session's uid; p_actor is
--           read only when there is none (the service role). EXECUTE:
--           authenticated and service_role (the callers), never PUBLIC /
--           anon. The app calls it first and keeps its three-step path only
--           for a database without this function (PGRST202 / 42883), so the
--           app may deploy before or after this paste.
--           document_versions.updated_at: the relabel has always written it
--           (lib/reviewControl.ts) but no migration in this repository adds
--           it; it is added IF NOT EXISTS so the function cannot fail on a
--           database that never had it (the inventory says which world this
--           was).
--
--   REV-20  20261144 refused a status-only issue over an active hold for
--           everyone; two controller writes still passed a hold unrecorded:
--           (a) the exit of a retirement that carries NO stamp (retired
--               before 20261144, or by the service role) into an issue
--               status — it kept OWN-15's advancing rule, which a controller
--               passes. Now judged as a status-only issue: the new-door hold
--               binds a controller too (the same sentence as 20261144's —
--               the un-archive dialog recognises it; the Draft restore stays
--               open to a controller);
--           (b) ONE write that moves the pointer AND makes the status an
--               issue (a direct PATCH; the review promote of a Draft / In
--               Review document) — an advancing write a controller passed.
--               Now a controller passes a hold there only through
--               publish_revision's force: publish_revision sets the
--               transaction-local flag app.publish_hold_override to the
--               document's id around its promote (and clears it after), and
--               RECORDS the force past the hold — REV_HOLD_OVERRIDDEN, in
--               the same transaction, naming the holds — as it records a
--               lock override (REV_LOCK_OVERRIDDEN, DCK-8). A bare UPDATE
--               carries no flag and is refused ("…release the hold before
--               issuing it, or publish over it with Document Control's
--               recorded override.").
--           Both limbs bind a controller only: below a controller nothing
--           changes (the publisher tier's own hold check, the guard's last,
--           still refuses every advancing write over a hold in its own
--           words). The flag cannot be set by a client: PostgREST sets only
--           request.* settings, and no function a client may call sets it
--           but publish_revision, after re-deriving the controller tier.
--
--   RE-CREATED FROM THE NEWEST BODIES (found by scanning; lineDiff-pinned —
--   every line of each base body is kept, the lines added are exactly the
--   REV-20 blocks): enforce_document_publish_guard from 20261144 (P13) and
--   publish_revision (the 12-argument form) from 20261130 (P3). Grants are
--   restated as their bases left them: the guard executable by no client
--   role; publish_revision by authenticated and service_role only (anon
--   revoked explicitly — DRLS-16: the function reads a NULL auth.uid() as a
--   service-role call that may name its actor).
--
-- NOT a widening: every change refuses something that was allowed, or
-- records it. DEC-30 inventories (aggregate counts only, captured BEFORE the
-- transaction): the documents whose finalize or direct pointer-and-issue
-- write by a controller is now refused while a hold stands; the unstamped
-- retirements, and those of them under an active hold (their exit into an
-- issue now needs the hold released, controllers included); the documents
-- whose current revision is still marked in_review (RG-12's residue —
-- counted, not repaired); whether document_versions.updated_at existed.
-- HOW TO APPLY: after 20261144 (the guard's base) and 20261130
-- (publish_revision's base) — the first statement refuses to run without
-- them. ⚠ Never re-paste 20261144, 20261139, 20261105 or any earlier guard
-- migration after this one, nor 20261130 or any earlier publish_revision
-- migration: either would drop the REV-20 rules. Independent of 20261131
-- (its rails fire on their own triggers; with it pasted the promote's
-- relabel still syncs the label as before), 20261143, 20261149 and
-- 20261150. Deploy the app carrying P14 with or after the paste; the app
-- before it keeps working (it never calls finalize_reviewed_promote, and its
-- three-step promote meets the same guard).
-- Single paste: prerequisite check → temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the bases) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'publish_revision' AND pronargs = 12) THEN
    RAISE EXCEPTION '20261151 needs 20261130 (publish_revision with p_override_reason) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'retired_issue_status')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'
                     AND prosrc LIKE '%v_restoring := COALESCE(v_issuing%') THEN
    RAISE EXCEPTION '20261151 needs 20261144 (the REV-18 publish guard) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_151_before;
CREATE TEMP TABLE dc_round_f_151_before AS
SELECT 'inventory (before apply): documents in Draft / In Review with a review draft pending and an active hold (REV-20: a controller''s finalize of these is now refused until the hold is released)' AS inventory,
       COUNT(*)::text AS n
  FROM documents d
 WHERE d.pending_version_id IS NOT NULL
   AND btrim(COALESCE(d.status, '')) IN ('Draft', 'In Review')
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
UNION ALL
SELECT 'inventory (before apply): documents in Superseded / Archived / Void with no retirement stamp and a current revision (retired before 20261144, or by the service role — their exit into an issue is judged as a status-only issue from now on)',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL
   AND d.status IN ('Superseded', 'Archived', 'Void')
   AND d.retired_issue_status IS NULL
UNION ALL
SELECT 'inventory (before apply): of those, under an active hold (REV-20: their exit into an issue now needs the hold released, Document Control included)',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL
   AND d.status IN ('Superseded', 'Archived', 'Void')
   AND d.retired_issue_status IS NULL
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
UNION ALL
SELECT 'inventory (before apply): documents whose CURRENT revision is still marked in_review (RG-12: a promote whose bookkeeping never landed — counted, not repaired; a controller corrects the label)',
       COUNT(*)::text
  FROM documents d JOIN document_versions v ON v.id = d.current_version_id
 WHERE v.review_state = 'in_review'
UNION ALL
SELECT 'inventory (before apply): document_versions.updated_at already existed (1) or is added by this paste (0)',
       COUNT(*)::text
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'document_versions' AND column_name = 'updated_at'
UNION ALL
SELECT 'inventory (before apply): publish_revision signatures (expect 1 — the 12-argument form this paste re-creates)',
       COUNT(*)::text
  FROM pg_proc WHERE proname = 'publish_revision';

BEGIN;

-- ── 1. RG-12: the column the relabel has always written ─────────────────────
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- ── 2. RG-12: the review promote and its bookkeeping, ONE transaction ──────
CREATE OR REPLACE FUNCTION finalize_reviewed_promote(
  p_document_id uuid,
  p_pending_id uuid,
  p_expected_current uuid,
  p_base_rev text,
  p_actor uuid DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_now timestamptz := now();
  v_n   integer;
BEGIN
  -- The promote: the write trg_document_publish_guard inspects, AS THE
  -- CALLER. Compare-and-set on both pointers: a concurrent finaliser (the
  -- promote clears pending_version_id) or a document that moved on matches
  -- no row, and nothing else is written.
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
  IF v_n = 0 THEN
    RETURN 'no_match';
  END IF;

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

  RETURN 'promoted';
END;
$$;
REVOKE ALL ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid) TO authenticated, service_role;

-- ── 3. REV-20: the publish guard — 20261144 body + the two hold limbs ──────
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
  -- active hold for a controller, unrecorded. (a) The exit of a retirement
  -- that carries NO stamp (retired before 20261144, or by the service role)
  -- into an issue status, its pointer unmoved: what that retirement took
  -- away is not known, so the exit is judged as a status-only issue — the
  -- new door, whose hold binds everyone. (b) ONE write that moves the
  -- pointer AND makes the status an issue: a controller passes a hold only
  -- through publish_revision's recorded force, which sets the
  -- transaction-local flag app.publish_hold_override to this document's id
  -- (20261151) and records REV_HOLD_OVERRIDDEN; a bare UPDATE carries no
  -- flag. Both bind a controller only: below a controller nothing changes —
  -- the publisher tier's own hold check (the last one) still refuses every
  -- advancing write over a hold, in its own words.
  v_new_door := v_new_door
                OR COALESCE(v_issuing
                            AND NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id
                            AND OLD.status IN ('Superseded', 'Archived', 'Void')
                            AND OLD.retired_issue_status IS NULL
                            AND is_org_controller(NEW.org_id), false);
  v_unforced_issue := COALESCE(v_issuing
                               AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
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
    -- carries publish_revision's recorded force, or it is refused.
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

-- ── 4. REV-20: publish_revision — 20261130 body + the recorded hold force ──
CREATE OR REPLACE FUNCTION publish_revision(
  p_doc UUID,
  p_expected_base UUID,
  p_op_class TEXT,
  p_version JSONB,
  p_actor UUID,
  p_actor_name TEXT DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE,
  p_as_branch BOOLEAN DEFAULT FALSE,
  p_branch_reason TEXT DEFAULT NULL,
  p_new_status TEXT DEFAULT 'Issued',
  p_override_lock BOOLEAN DEFAULT FALSE,
  p_override_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_doc RECORD;
  v_is_member BOOLEAN;
  v_is_controller BOOLEAN;
  v_current RECORD;
  v_new_id UUID;
  v_new_row JSONB;
  v_branch_id UUID;
  v_label TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_doc_class TEXT;
  v_is_revert BOOLEAN;
  v_minor_like BOOLEAN;
  v_revert_target UUID;
  v_lock_via TEXT;
  v_lock_holder TEXT;
  v_hold_forced BOOLEAN := FALSE;
BEGIN
  IF p_op_class NOT IN ('content','metadata') THEN
    RAISE EXCEPTION 'publish_revision: unknown op_class %', p_op_class;
  END IF;

  -- OWN-5: the acting identity comes from the SESSION. A signed-in caller
  -- cannot publish as someone else — attribution, authority, and lock
  -- evaluation all follow auth.uid(). Only a service-role call (auth.uid()
  -- IS NULL) may name its actor explicitly.
  IF auth.uid() IS NOT NULL THEN
    IF p_actor IS NULL THEN
      p_actor := auth.uid();
    ELSIF p_actor IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'publish_revision: p_actor does not match the calling session.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_actor IS NULL THEN
    RAISE EXCEPTION 'publish_revision: a service-role call must name its actor';
  END IF;

  SELECT * INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publish_revision: document % not found', p_doc;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_doc.org_id AND uid = p_actor AND status = 'active'
  ) INTO v_is_member;
  IF NOT v_is_member THEN
    RAISE EXCEPTION 'publish_revision: actor is not an active member of this org';
  END IF;

  -- OWN-3/DEC-2: the controller tier is a property of the COLLECTION.
  -- Inline (not is_org_controller) because p_actor may be a service-role
  -- caller's named actor, not auth.uid().
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_doc.org_id AND uid = p_actor AND status = 'active'
      AND (role IN ('Admin','DocCtrl') OR roles && ARRAY['Admin','DocCtrl']::text[])
  ) INTO v_is_controller;

  -- DCK-8: passing another user's checkout is an ACT — asserted with its
  -- reason, by someone eligible, and recorded below. A controller's explicit
  -- force (p_force, the controller tier re-derived from org_members above)
  -- passes the lock as before. Any other override must carry
  -- p_override_reason (at least 5 characters) and publish authority on this
  -- library or effective ownership of the document — re-derived here, never
  -- trusted from the caller's boolean.
  IF v_doc.checked_out_by IS NOT NULL
     AND v_doc.checked_out_by::text <> p_actor::text THEN
    IF p_force AND v_is_controller THEN
      v_lock_via := 'force';
    ELSIF p_override_lock THEN
      IF length(btrim(COALESCE(p_override_reason, ''))) < 5 THEN
        RAISE EXCEPTION 'publish_revision: publishing over another user''s checkout needs a reason (at least 5 characters); it is shown to them and recorded.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT v_is_controller
         AND NOT user_can_publish_on_library(v_doc.library_id, p_actor::text, v_doc.org_id)
         AND NOT user_is_effective_owner(v_doc.owner_user_id, v_doc.collection_id, v_doc.library_id, p_actor) THEN
        RAISE EXCEPTION 'publish_revision: only a publisher on this library (or the document''s owner) may publish over another user''s checkout.'
          USING ERRCODE = 'check_violation';
      END IF;
      v_lock_via := 'override';
    ELSE
      RETURN jsonb_build_object(
        'status', 'locked_by_other',
        'holder_name', v_doc.checked_out_by_name
      );
    END IF;
    v_lock_holder := v_doc.checked_out_by::text;
  END IF;

  IF EXISTS (
    SELECT 1 FROM document_holds
    WHERE document_id = p_doc AND released_at IS NULL
  ) AND NOT (p_force AND v_is_controller) THEN
    RETURN jsonb_build_object('status', 'on_hold');
  END IF;

  -- REV-20 (document-control Round F wave 3, P14): a controller's force
  -- past an active hold is an ACT, recorded like a lock override (below, in
  -- the same transaction, REV_HOLD_OVERRIDDEN) — and the publish guard admits
  -- a controller's write that moves the pointer AND makes the status an issue
  -- over a hold only under the transaction-local flag set around the
  -- promote below, naming this document.
  IF p_force AND v_is_controller AND EXISTS (
    SELECT 1 FROM document_holds
    WHERE document_id = p_doc AND released_at IS NULL
  ) THEN
    v_hold_forced := TRUE;
  END IF;

  IF p_op_class = 'content' AND NOT p_as_branch
     AND v_doc.current_version_id IS DISTINCT FROM p_expected_base THEN
    SELECT id, revision_label, created_by, created_by_name, created_at, change_log
      INTO v_current FROM document_versions WHERE id = v_doc.current_version_id;
    RETURN jsonb_build_object(
      'status', 'stale_base',
      'current_version_id', v_current.id,
      'current_rev', v_current.revision_label,
      'current_by', v_current.created_by,
      'current_by_name', v_current.created_by_name,
      'current_at', v_current.created_at,
      'current_change_log', v_current.change_log
    );
  END IF;

  IF p_as_branch AND (p_branch_reason IS NULL OR btrim(p_branch_reason) = '') THEN
    RAISE EXCEPTION 'publish_revision: a branch publish requires a reason';
  END IF;

  -- OWN-5: the BRANCH insert carries the same publish-authority bar as the
  -- promote. The promote's authority lives in trg_document_publish_guard on
  -- the documents write — a branch never touches documents, so without this
  -- block any active member could park arbitrary content as a branch row.
  IF p_as_branch AND auth.uid() IS NOT NULL AND NOT v_is_controller
     AND NOT user_can_publish_on_library(v_doc.library_id, p_actor::text, v_doc.org_id)
     AND NOT user_is_effective_owner(v_doc.owner_user_id, v_doc.collection_id, v_doc.library_id, p_actor) THEN
    RAISE EXCEPTION 'publish_revision: you do not have authority to publish revisions (branches included) in this library.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_op_class = 'content' THEN
    BEGIN
      SELECT COALESCE(
               NULLIF(v_doc.doc_class, ''),
               (SELECT NULLIF(c.doc_class, '') FROM collections c WHERE c.id = v_doc.collection_id),
               (SELECT NULLIF(l.doc_class, '') FROM libraries l WHERE l.id = v_doc.library_id)
             ) INTO v_doc_class;
    EXCEPTION WHEN undefined_column THEN
      v_doc_class := NULL;
    END;
    v_is_revert := NULLIF(p_version->>'reverted_from_version_id', '') IS NOT NULL;
    v_minor_like := COALESCE(NULLIF(p_version->>'change_type', ''), '') IN ('Minor', 'Correction')
                    AND NOT v_is_revert;
    IF v_doc_class = 'drawing' AND NOT v_minor_like
       AND length(btrim(COALESCE(p_version->>'moc_reference', ''))) < 3 THEN
      RAISE EXCEPTION 'publish_revision: PSM requires an MOC reference to publish a non-minor revision of a drawing-class document (OSHA 1910.119(l)).'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_op_class = 'content'
     AND NULLIF(p_version->>'reverted_from_version_id', '') IS NOT NULL THEN
    v_revert_target := (p_version->>'reverted_from_version_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM document_versions t
      WHERE t.id = v_revert_target AND t.record_id = p_doc
    ) THEN
      RAISE EXCEPTION 'publish_revision: revert target is not a revision of this document.'
        USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      IF EXISTS (
        SELECT 1 FROM document_versions t
        WHERE t.id = v_revert_target
          AND (COALESCE(t.review_state, '') IN ('in_review', 'rejected', 'superseded')
               OR COALESCE(t.is_branch, FALSE))
      ) THEN
        RAISE EXCEPTION 'publish_revision: revert target is an unreviewed draft or an unreconciled branch — only previously-issued revisions can be restored.'
          USING ERRCODE = 'check_violation';
      END IF;
    EXCEPTION WHEN undefined_column THEN
      NULL;
    END;
  END IF;

  v_label := COALESCE(p_version->>'revision_label', '');
  IF btrim(v_label) = '' THEN
    RAISE EXCEPTION 'publish_revision: revision_label is required';
  END IF;

  BEGIN
    INSERT INTO document_versions (
      org_id, record_id, revision_label, issue_type, change_type,
      file_url, file_type, size, change_log,
      created_by, created_by_name, created_at,
      supersedes_version_id, drawn_by_name, checked_by_name, approved_by_name,
      released_at, moc_reference, source_file_name, source_file_key, file_hash,
      reverted_from_version_id,
      is_branch, published_base_version_id, provenance, related_ticket_id
    ) VALUES (
      v_doc.org_id, p_doc, btrim(v_label),
      NULLIF(p_version->>'issue_type',''), NULLIF(p_version->>'change_type',''),
      p_version->>'file_url', NULLIF(p_version->>'file_type',''),
      NULLIF(p_version->>'size','')::bigint, NULLIF(p_version->>'change_log',''),
      p_actor, COALESCE(NULLIF(p_version->>'created_by_name',''), p_actor_name, p_actor::text), v_now,
      CASE WHEN p_as_branch THEN NULL ELSE v_doc.current_version_id END,
      NULLIF(p_version->>'drawn_by_name',''), NULLIF(p_version->>'checked_by_name',''),
      NULLIF(p_version->>'approved_by_name',''),
      v_now, NULLIF(p_version->>'moc_reference',''),
      NULLIF(p_version->>'source_file_name',''), NULLIF(p_version->>'source_file_key',''),
      NULLIF(p_version->>'file_hash',''),
      NULLIF(p_version->>'reverted_from_version_id','')::uuid,
      p_as_branch, p_expected_base, NULLIF(p_version->>'provenance',''),
      NULLIF(p_version->>'related_ticket_id','')::uuid
    )
    RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'duplicate_label', 'label', btrim(v_label));
  END;

  IF p_as_branch THEN
    INSERT INTO revision_branches (
      org_id, document_id, branch_version_id, diverged_from_version_id,
      reason, created_by, created_by_name
    ) VALUES (
      v_doc.org_id, p_doc, v_new_id, v_doc.current_version_id,
      btrim(p_branch_reason), p_actor::text, p_actor_name
    ) RETURNING id INTO v_branch_id;
  ELSE
    IF v_doc.current_version_id IS NOT NULL THEN
      UPDATE document_versions SET superseded_at = v_now
      WHERE id = v_doc.current_version_id;
    END IF;
    IF v_hold_forced THEN
      PERFORM set_config('app.publish_hold_override', p_doc::text, true);
    END IF;
    UPDATE documents SET
      current_version_id = v_new_id,
      rev = btrim(v_label),
      revision = btrim(v_label),
      status = COALESCE(NULLIF(p_new_status,''), 'Issued'),
      updated_at = v_now,
      updated_by = p_actor
    WHERE id = p_doc;
    IF v_hold_forced THEN
      PERFORM set_config('app.publish_hold_override', '', true);
    END IF;
  END IF;

  -- DCK-8: the override is on the document's record in the same
  -- transaction, whether or not the caller went through the app (which also
  -- tells the holder on their episode thread).
  IF v_lock_via IS NOT NULL THEN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('REV_LOCK_OVERRIDDEN', p_doc::text, 'document', v_doc.org_id, p_actor,
            (SELECT m.email FROM org_members m WHERE m.org_id = v_doc.org_id AND m.uid = p_actor LIMIT 1),
            jsonb_build_object(
              'via', v_lock_via,
              'holder', v_lock_holder,
              'holderName', v_doc.checked_out_by_name,
              'reason', NULLIF(btrim(COALESCE(p_override_reason, '')), ''),
              'versionId', v_new_id,
              'revisionLabel', btrim(v_label),
              'branch', p_as_branch
            ));
  END IF;

  -- REV-20: the force past a hold is on the document's record in the same
  -- transaction, whoever called (the app, or a direct POST).
  IF v_hold_forced THEN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('REV_HOLD_OVERRIDDEN', p_doc::text, 'document', v_doc.org_id, p_actor,
            (SELECT m.email FROM org_members m WHERE m.org_id = v_doc.org_id AND m.uid = p_actor LIMIT 1),
            jsonb_build_object(
              'holds', (SELECT jsonb_agg(jsonb_build_object('id', h.id, 'reason', h.reason) ORDER BY h.opened_at)
                          FROM document_holds h
                         WHERE h.document_id = p_doc AND h.released_at IS NULL),
              'versionId', v_new_id,
              'revisionLabel', btrim(v_label),
              'newStatus', CASE WHEN p_as_branch THEN NULL ELSE COALESCE(NULLIF(p_new_status,''), 'Issued') END,
              'branch', p_as_branch
            ));
  END IF;

  SELECT to_jsonb(dv) INTO v_new_row FROM document_versions dv WHERE dv.id = v_new_id;
  RETURN jsonb_build_object(
    'status', CASE WHEN p_as_branch THEN 'branched' ELSE 'published' END,
    'version', v_new_row,
    'branch_id', v_branch_id,
    'superseded_version_id', CASE WHEN p_as_branch THEN NULL ELSE v_doc.current_version_id END
  );
END;
$$;

COMMENT ON FUNCTION publish_revision IS
  'Transactional, per-document-serialized revision publish. The acting identity is derived from auth.uid() (p_actor honored only on service-role calls). content op_class enforces the expected-base check, the drawing-class MOC gate (DCK-1) and the revert-target gate (REV-2; in-review, rejected and superseded submissions are never targets); a branch insert carries the same publish-authority bar as a promote (OWN-5). p_override_lock = a publisher''s checkout-override: passes the lock, never a hold, and only with p_override_reason (>= 5 chars) from an actor with publish authority or effective ownership, recorded as REV_LOCK_OVERRIDDEN (DCK-8); p_force = controller-only emergency bypass, recorded when it passes a lock (REV_LOCK_OVERRIDDEN) and when it passes an active hold (REV_HOLD_OVERRIDDEN, REV-20) — its promote over a hold runs under the transaction-local flag app.publish_hold_override, the only way the publish guard admits a controller''s pointer-and-issue write over a hold.';

REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 10. Inventory rows: n = the aggregate count.
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here).
SELECT 'RG-12: finalize_reviewed_promote promotes with compare-and-set on both pointers, then relabels / approves the draft and supersedes the prior revision in the SAME call, raising (so rolling the promote back) when either matches no row' AS check,
       (SELECT prosrc LIKE '%AND pending_version_id = p_pending_id%'
           AND prosrc LIKE '%AND current_version_id IS NOT DISTINCT FROM p_expected_current;%'
           AND prosrc LIKE '%RETURN ''no_match'';%'
           AND prosrc LIKE '%SET review_state = ''approved'',%'
           AND prosrc LIKE '%could not be relabeled to Rev %'
           AND prosrc LIKE '%UPDATE document_versions SET superseded_at = v_now WHERE id = p_expected_current;%'
           AND prosrc LIKE '%could not be marked superseded%'
           AND prosrc LIKE '%RETURN ''promoted'';%'
          FROM pg_proc WHERE proname = 'finalize_reviewed_promote') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'RG-12: finalize_reviewed_promote runs as the CALLER (SECURITY INVOKER — the publish guard and the row-level policies apply), search_path pinned; authenticated and service_role may execute it, PUBLIC and anon may not',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'finalize_reviewed_promote'
                AND NOT prosecdef AND proconfig @> ARRAY['search_path=public'])
       AND has_function_privilege('authenticated', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid)', 'EXECUTE')
       AND has_function_privilege('service_role', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid)', 'EXECUTE')
       AND NOT has_function_privilege('public', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'RG-12: document_versions.updated_at exists (the relabel writes it)',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'document_versions' AND column_name = 'updated_at'),
       NULL
UNION ALL
SELECT 'REV-20 (a): an unstamped retirement''s exit into an issue is the new door for a controller (its hold binds them)',
       (SELECT prosrc LIKE '%v_new_door := v_new_door%'
           AND prosrc LIKE '%AND OLD.retired_issue_status IS NULL%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-20 (b): a controller''s pointer-and-issue write over an active hold is refused unless publish_revision''s flag names the document',
       (SELECT prosrc LIKE '%v_unforced_issue := COALESCE(v_issuing%'
           AND prosrc LIKE '%current_setting(''app.publish_hold_override'', true) IS DISTINCT FROM NEW.id%'
           AND prosrc LIKE '%IF v_unforced_issue AND EXISTS (%'
           AND prosrc LIKE '%or publish over it with Document Control''''s recorded override.%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-20: the 20261144 rules survive the re-create (the issue transition, the new door, the stamp, the require limb, the publisher tier, the hold)',
       (SELECT prosrc LIKE '%v_issuing := NEW.current_version_id IS NOT NULL%'
           AND prosrc LIKE '%v_advancing := v_advancing OR v_issuing;%'
           AND prosrc LIKE '%v_restoring := COALESCE(v_issuing%'
           AND prosrc LIKE '%NEW.retired_issue_status := ''not-issued'';%'
           AND prosrc LIKE '%Document has an active hold; release the hold before issuing it.%'
           AND prosrc LIKE '%a revision that was not reviewed can''''t be made a controlled issue%'
           AND prosrc LIKE '%Reviewer independence: you are on this revision''''s review roster%'
           AND prosrc LIKE '%IF is_org_controller(NEW.org_id) THEN%'
           AND prosrc LIKE '%You do not have authority to publish revisions in this library.%'
           AND prosrc LIKE '%Document has an active hold; release the hold before publishing a new revision.%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-20: the guard is SECURITY DEFINER with search_path pinned, no client role may execute it, its owner may execute is_controlled_issue_status, and trg_document_publish_guard still fires it',
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
SELECT 'REV-20: publish_revision has exactly one signature (12 arguments); its controller force past a hold sets the flag around its promote and records REV_HOLD_OVERRIDDEN',
       (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'publish_revision')
       AND (SELECT pronargs = 12
               AND prosrc LIKE '%v_hold_forced := TRUE;%'
               AND prosrc LIKE '%PERFORM set_config(''app.publish_hold_override'', p_doc%'
               AND prosrc LIKE '%PERFORM set_config(''app.publish_hold_override'', '''', true);%'
               AND prosrc LIKE '%VALUES (''REV_HOLD_OVERRIDDEN''%'
              FROM pg_proc WHERE proname = 'publish_revision'),
       NULL
UNION ALL
SELECT 'REV-20: the 20261130 contract survived the re-create (override reason, eligibility, REV_LOCK_OVERRIDDEN, stale base, MOC gate, revert-target gate, branch authority, session-derived actor)',
       (SELECT prosrc LIKE '%ELSIF p_override_lock THEN%'
           AND prosrc LIKE '%length(btrim(COALESCE(p_override_reason, ''''))) < 5%'
           AND prosrc LIKE '%REV_LOCK_OVERRIDDEN%'
           AND prosrc LIKE '%''status'', ''stale_base''%'
           AND prosrc LIKE '%PSM requires an MOC reference%'
           AND prosrc LIKE '%IN (''in_review'', ''rejected'', ''superseded'')%'
           AND prosrc LIKE '%branches included%'
           AND prosrc LIKE '%p_actor does not match the calling session%'
           AND prosrc LIKE '%RETURN jsonb_build_object(''status'', ''on_hold'');%'
          FROM pg_proc WHERE proname = 'publish_revision'),
       NULL
UNION ALL
SELECT 'REV-20: publish_revision is SECURITY DEFINER with search_path pinned; authenticated and service_role may execute it, PUBLIC and anon may not',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'publish_revision')
       AND has_function_privilege('authenticated', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE')
       AND NOT has_function_privilege('public', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_151_before;
