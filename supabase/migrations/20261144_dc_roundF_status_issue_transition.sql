-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 2 — P13 STATUS-TRANSITION: a status change
-- that makes a document a controlled issue is a guarded write (REV-18).
--
--   REV-18  enforce_document_publish_guard decided only "advancing" writes —
--           a current_version_id move, entry into Superseded / Archived, exit
--           from Superseded / Archived / Void (OWN-15 / OWN-19). A status
--           change from Draft or In Review to Issued (or IFC, or a library's
--           own status) moves no pointer, so the guard returned before its
--           review gate, its publish-authority check and its hold check, and
--           documents_org_access admits an UPDATE by any active member: any
--           member issued an unreviewed revision by changing the status, in
--           any library. The same issue was reachable one step later through
--           a Minor / Correction rev-up of a Draft (the pointer moves, but
--           OLD.current_version_id is set, so neither RG-7's Major rule nor
--           REV-17's first-issue rule applies), or through Draft -> Void /
--           Archived / Superseded -> Issued (an exit the guard sees, by the
--           publisher tier, with no review rule).
--
--           Re-created from its NEWEST body (20261139, P12 — nothing later
--           re-creates it; the shape test finds the newest earlier
--           definition by scanning this directory) plus three added blocks
--           and five declarations (pinned line for line by a lineDiff test;
--           every other line of the 20261139 body is carried byte for byte):
--             * v_issuing: the write moves a document that HAS a current
--               revision (NEW.current_version_id IS NOT NULL) out of a status
--               the app does not call an issue into one it does —
--               is_controlled_issue_status (below), the SQL twin of
--               lib/revisions.ts isControlledIssueStatus, pinned by test. It
--               joins v_advancing, so it takes the publisher tier the guard
--               already enforces for pointer moves (controller, library
--               publisher, effective owner — OWN-15 / OWN-19) and the hold
--               check that follows it.
--             * never over an active hold: a status-only issue out of Draft /
--               In Review (the one write no rule saw before) is refused over
--               an active hold for everyone, a controller included — a
--               controller's override of a hold is publish_revision's
--               recorded force, never a status edit. So is (P13 second
--               review fix) a status-only issue out of a retirement that
--               took away NO issue — the 'not-issued' stamp below: Draft ->
--               Void / Archived / Superseded -> Issued is the same issue of a
--               never-issued revision, one write later. Every other write
--               the guard already decided keeps exactly its hold rule (a
--               retirement before this migration carries no stamp: OWN-15's).
--             * require mode: in a library whose policy requires sign-off —
--               the folder / library chain OR the document's own (as
--               REV-17's first-issue rule reads it; DEC-71: a
--               document-level 'none' is not honoured, it can be written at
--               INSERT) — only a controller may make an issue of a revision
--               that does not carry a complete roster (every primary slot
--               filled by a bound signature, counted as the review gate
--               counts it).
--             * a put-back is not a new issue (P13 review fix): entering
--               Superseded / Archived / Void from an issue status stamps what
--               was issued — documents.retired_issue_status and
--               retired_issue_version_id (new columns, written ONLY by this
--               guard: it overwrites a caller's value on every signed-in
--               UPDATE, and trg_document_retired_issue_stamp_insert resets
--               them on a signed-in INSERT); entering one from a status that
--               is not an issue (or from an issue with no revision) stamps
--               'not-issued' with no revision (second review fix: the hold
--               then binds its status-only exit into an issue, above), and
--               so does a signed-in INSERT born retired. Putting that same revision back
--               into an issue status (v_restoring: a failed supersede / split
--               / merge's compensation, an un-archive) is not decided by the
--               require-mode limb — the publisher tier and the hold check
--               still decide it, exactly as OWN-15 did before. A document
--               retired BEFORE this migration carries no stamp, so its
--               restore of an unreviewed revision needs a controller (counted
--               by the inventory).
--             * a NULL status is no way past the hold: v_new_door COALESCEs
--               v_advancing (a NULL NEW.status makes the carried expression
--               NULL, and the app calls a NULL status an issue).
--           A NULL auth.uid() (the service role: the cron, an org restore,
--           the intake route's settle) keeps exactly today's treatment: the
--           guard's first statement returns before any rule, as before (and
--           it neither writes nor clears a stamp).
--
--   is_controlled_issue_status(text): new, IMMUTABLE, not SECURITY DEFINER.
--           btrim of exactly the characters JavaScript's String.trim()
--           removes, then NOT IN ('Draft', 'In Review', 'Superseded',
--           'Void', 'Archived') — lib/revisions.ts WORK_IN_PROGRESS_STATUSES
--           + lib/aiBoundary.ts NOT_CURRENT_STATUSES. A NULL or empty status
--           IS an issue (as in the app). EXECUTE revoked from every client
--           role: only the guard (its owner) calls it.
--
--   documents.retired_issue_status / retired_issue_version_id: new nullable
--           columns (no backfill — what a retired document was before this
--           migration is not known, and a guess would let a Draft archived
--           by a publisher come back Issued); BEFORE INSERT trigger
--           trg_document_retired_issue_stamp_insert ->
--           document_retired_issue_stamp_on_insert() (not SECURITY DEFINER,
--           search_path pinned, EXECUTE revoked from every client role).
--
--   The guard runs as its OWNER (SECURITY DEFINER; CREATE OR REPLACE keeps
--           the owner it was first created with, which need not be the role
--           pasting this script). The predicate's EXECUTE is revoked from
--           every client role, so §3 grants it to the guard's owner when
--           that role cannot already run it, and the final SELECT probes it
--           (P13 second review fix).
--
-- NOT a widening: every change refuses something that was allowed (the
-- put-back exemption only spares a restore the require limb, itself new
-- here). DEC-30 inventories (aggregate counts, captured BEFORE the
-- transaction; kept as they are — the rule binds the next transition):
-- documents already in an issue status under a require policy whose current
-- revision has no complete roster (once retired after this migration, their
-- put-back is spared); Draft / In Review documents under a require policy
-- whose current revision has no complete roster (from now on only a
-- controller issues them, until a review completes); Superseded / Void /
-- Archived documents under a require policy whose current revision has no
-- complete roster (retired before this migration, unstamped: only a
-- controller restores them to an issue status, until a review completes);
-- Draft / In Review documents with a current revision and an active hold
-- (their status-only issue, directly or through a retirement after this
-- migration, is now refused for everyone until the hold is released).
-- No document carries a retirement stamp at the paste (the columns are new),
-- so the 'not-issued' rule binds only retirements made after it.
-- The trigger function is not callable directly (it RETURNS trigger); its
-- EXECUTE stays revoked from PUBLIC and every client role (DRLS-16 rule, as
-- 20261139 left it).
-- HOW TO APPLY: after 20261139 (the guard's base — never re-paste 20261139,
-- 20261105 or any earlier guard migration after this one: it would drop the
-- REV-18 blocks). Independent of 20261131 (its register rail fires on other
-- columns, never on a status-only write) and of 20261129 / 20261130 /
-- 20261140; paste it after 20261131 when both are pending, so REV-17's
-- INSERT door is closed by the time this rule binds the status.
-- Single paste: temp-table inventory -> BEGIN/DDL/COMMIT -> one SELECT
-- (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- "Complete roster" is the review gate's own count: per slot group, every
-- primary slot filled by a signed row (a primary or an activated alternate)
-- carrying its reviewer's bound e-signature. "An issue status" is
-- is_controlled_issue_status's rule (created below), spelled out: the same
-- trim, the same five statuses.
DROP TABLE IF EXISTS dc_round_f_144_before;
CREATE TEMP TABLE dc_round_f_144_before AS
WITH slot_fill AS (
  SELECT s.document_version_id AS vid,
         count(*) FILTER (WHERE s.slot = 'primary') AS reqs,
         count(*) FILTER (WHERE (s.slot = 'primary' OR s.activated)
                            AND s.status = 'signed'
                            AND s.signature_id IS NOT NULL
                            AND EXISTS (SELECT 1 FROM e_signatures e
                                         WHERE e.id = s.signature_id
                                           AND e.signer_user_id = s.reviewer_user_id
                                           AND e.org_id = s.org_id
                                           AND (e.document_version_id = s.document_version_id
                                                OR e.document_version_id IS NULL))) AS filled
    FROM document_review_signoffs s
   GROUP BY s.document_version_id, COALESCE(s.slot_group, '')
), reviewed AS (
  SELECT vid FROM slot_fill
   GROUP BY vid
  HAVING sum(reqs) > 0 AND sum(LEAST(reqs, filled)) >= sum(reqs)
), governed AS (
  SELECT d.id, d.status, d.current_version_id
    FROM documents d
   WHERE d.current_version_id IS NOT NULL
     AND (review_control_mode_for(NULL, d.collection_id, d.library_id) = 'require'
          OR review_control_mode_for(d.review_control, d.collection_id, d.library_id) = 'require')
     AND NOT EXISTS (SELECT 1 FROM reviewed r WHERE r.vid = d.current_version_id)
)
SELECT 'inventory (before apply): documents in an issue status, with a current revision, under a policy that requires sign-off, whose current revision carries no complete reviewer roster (REV-18: issued unreviewed — by a status change, a Minor / Correction rev-up, a controller, or before the policy; kept as they are)' AS inventory,
       COUNT(*)::text AS n
  FROM governed g
 WHERE btrim(COALESCE(g.status, ''), E' \t\n\u000B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')
UNION ALL
SELECT 'inventory (before apply): documents in Draft / In Review, with a current revision, under a policy that requires sign-off, whose current revision carries no complete roster (REV-18: from now on only a controller may issue them until a review completes)',
       COUNT(*)::text
  FROM governed g
 WHERE btrim(COALESCE(g.status, ''), E' \t\n\u000B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') IN ('Draft', 'In Review')
UNION ALL
SELECT 'inventory (before apply): documents in Superseded / Void / Archived, with a current revision, under a policy that requires sign-off, whose current revision carries no complete roster (REV-18: retired before this migration, so they carry no retirement stamp — only a controller may restore them to an issue status until a review completes; one retired after it is put back by the publisher tier)',
       COUNT(*)::text
  FROM governed g
 WHERE btrim(COALESCE(g.status, ''), E' \t\n\u000B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') IN ('Superseded', 'Void', 'Archived')
UNION ALL
SELECT 'inventory (before apply): documents in Draft / In Review, with a current revision and an active hold (REV-18: their status-only issue — directly, or through Void / Archived / Superseded after this migration — is now refused for everyone until the hold is released)',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL
   AND btrim(COALESCE(d.status, ''), E' \t\n\u000B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') IN ('Draft', 'In Review')
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL);

BEGIN;

-- ── 1. REV-18: the SQL twin of isControlledIssueStatus ──────────────────────
-- btrim's character list is exactly what JavaScript's String.prototype.trim
-- removes (WhiteSpace + LineTerminator: TAB, LF, VT, FF, CR, SPACE, NBSP,
-- OGHAM SPACE MARK, U+2000..U+200A, LINE / PARAGRAPH SEPARATOR, NARROW NBSP,
-- MEDIUM MATHEMATICAL SPACE, IDEOGRAPHIC SPACE, BOM) — pinned by test.
CREATE OR REPLACE FUNCTION is_controlled_issue_status(p_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $$
  SELECT btrim(COALESCE(p_status, ''), E' \t\n\u000B\f\r\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF')
         NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived');
$$;
REVOKE ALL ON FUNCTION is_controlled_issue_status(text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. REV-18: the retirement stamp (what was issued when it was retired) ───
-- Written ONLY by the guard below (a signed-in caller's value is overwritten
-- on UPDATE; the INSERT trigger in §4 clears it); read only by it.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retired_issue_status text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retired_issue_version_id uuid;
COMMENT ON COLUMN documents.retired_issue_status IS
  'REV-18 (20261144): the issue status the document held when it entered Superseded / Archived / Void, or ''not-issued'' (with no revision) when it entered from a status that is not an issue or had no revision; NULL when retired before 20261144 or by the service role. Written only by enforce_document_publish_guard (and reset on a signed-in INSERT).';
COMMENT ON COLUMN documents.retired_issue_version_id IS
  'REV-18 (20261144): the revision that was current when the document entered Superseded / Archived / Void from an issue status; putting that revision back is not a new issue. Written only by enforce_document_publish_guard.';

-- ── 3. REV-18: the publish guard — 20261139 body + the issue-transition rule ─
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
REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;
-- The guard calls is_controlled_issue_status as its OWN owner (SECURITY
-- DEFINER), and CREATE OR REPLACE keeps the owner the guard was first
-- created with — not necessarily the role pasting this script, who owns the
-- predicate. Its EXECUTE is revoked from every client role (§1), so the
-- guard's owner is granted it when it cannot already run it (a no-op for
-- the same owner or a superuser); the final SELECT probes it. P13 second
-- review fix: without it every signed-in issue write would fail with
-- "permission denied for function is_controlled_issue_status".
DO $$
DECLARE
  v_owner regrole;
BEGIN
  SELECT p.proowner::regrole INTO v_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard';
  IF v_owner IS NOT NULL
     AND NOT has_function_privilege(v_owner::oid, 'is_controlled_issue_status(text)', 'EXECUTE') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION is_controlled_issue_status(text) TO %s', v_owner);
  END IF;
END
$$;

-- ── 4. REV-18: a signed-in INSERT never carries an issue stamp ─────────────
-- Otherwise a member could insert a retired document already "stamped" and
-- restore it as an issue past the require limb. A document born retired was
-- never issued: it is stamped 'not-issued' (second review fix — its
-- status-only issue is under the new-door hold, as a Draft's is). The
-- service role (a restore replays documents with their stamps) is
-- untouched, as in the guard.
CREATE OR REPLACE FUNCTION document_retired_issue_stamp_on_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF COALESCE(NEW.status IN ('Superseded', 'Archived', 'Void'), false) THEN
      NEW.retired_issue_status := 'not-issued';
    ELSE
      NEW.retired_issue_status := NULL;
    END IF;
    NEW.retired_issue_version_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION document_retired_issue_stamp_on_insert() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_document_retired_issue_stamp_insert ON documents;
CREATE TRIGGER trg_document_retired_issue_stamp_insert
  BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION document_retired_issue_stamp_on_insert();

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows carry ok NULL and the
--    count in n. pg_proc.prosrc is verbatim.
SELECT 'REV-18: is_controlled_issue_status answers as the app''s isControlledIssueStatus (Draft / In Review / Superseded / Void / Archived, trimmed, are not an issue; Issued, IFC, a library''s own status, a case variant, empty and NULL are)' AS check,
       (SELECT bool_and(is_controlled_issue_status(v.s) IS NOT DISTINCT FROM v.e)
          FROM (VALUES ('Draft', false), ('In Review', false), ('Superseded', false), ('Void', false), ('Archived', false),
                       ('  Draft ', false), (E'\tIn Review\n', false), (E'\u00A0Void\u3000', false),
                       ('Issued', true), ('IFC', true), ('Locked', true), ('Approved for Construction', true),
                       ('draft', true), ('In  Review', true), ('', true), (NULL, true)) AS v(s, e)) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'REV-18: the guard makes an issue transition advancing (v_issuing joins v_advancing; a document with a current revision, out of a not-issue status into an issue)',
       (SELECT prosrc LIKE '%v_issuing := NEW.current_version_id IS NOT NULL%'
           AND prosrc LIKE '%AND NOT is_controlled_issue_status(OLD.status)%'
           AND prosrc LIKE '%AND is_controlled_issue_status(NEW.status);%'
           AND prosrc LIKE '%v_advancing := v_advancing OR v_issuing;%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-18: a NULL status is no way past the hold (v_new_door COALESCEs v_advancing), nor is a retirement that took away no issue (stamped not-issued: its status-only exit is the new door); entering Superseded / Archived / Void from an issue stamps it, any other signed-in write keeps or clears it, and putting the stamped revision back is v_restoring',
       (SELECT prosrc LIKE '%v_new_door := v_issuing%AND (NOT COALESCE(v_advancing, false)%OR COALESCE(NEW.current_version_id IS NOT DISTINCT FROM OLD.current_version_id%AND OLD.retired_issue_status = ''not-issued''%AND OLD.retired_issue_version_id IS NULL, false));%'
           AND prosrc LIKE '%NEW.retired_issue_status := ''not-issued'';%'
           AND prosrc LIKE '%v_restoring := COALESCE(v_issuing%'
           AND prosrc LIKE '%AND NEW.current_version_id = OLD.retired_issue_version_id%'
           AND prosrc LIKE '%NEW.retired_issue_status := OLD.status;%'
           AND prosrc LIKE '%NEW.retired_issue_version_id := OLD.current_version_id;%'
           AND prosrc LIKE '%NEW.retired_issue_version_id := NULL;%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-18: the issue is refused over an active hold (the new door, for everyone) and, under a require policy, without a complete roster for anyone but a controller (a put-back of the retired issue excepted)',
       (SELECT prosrc LIKE '%IF v_new_door AND EXISTS (%'
           AND prosrc LIKE '%release the hold before issuing it.%'
           AND prosrc LIKE '%IF NOT is_org_controller(NEW.org_id)%AND NOT v_restoring%'
           AND prosrc LIKE '%IF COALESCE(v_issue_reqs, 0) = 0 OR COALESCE(v_issue_signed, 0) < v_issue_reqs THEN%'
           AND prosrc LIKE '%a revision that was not reviewed can''''t be made a controlled issue%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-18: the 20261139 rules survive (the service-role return, OWN-15 / OWN-19, the review gate, RG-7, REV-17, SEC-13, SEC-14, reviewer independence, the controller short-circuit, the publisher tier, the hold)',
       (SELECT prosrc LIKE '%IF v_actor IS NULL THEN%RETURN NEW;%'
           AND prosrc LIKE '%OR (OLD.status IN (''Superseded'', ''Archived'', ''Void'') AND NEW.status IS DISTINCT FROM OLD.status)%'
           AND prosrc LIKE '%OR (NEW.status = ''Archived'' AND COALESCE(OLD.status, '''') <> ''Archived'');%'
           AND prosrc LIKE '%This revision still has outstanding review sign-offs%'
           AND prosrc LIKE '%requires reviewer sign-off for a Major revision%'
           AND prosrc LIKE '%a new document can''''t be issued unreviewed%'
           AND prosrc LIKE '%send the external submission to its reviewers before publishing it%'
           AND prosrc LIKE '%PSM requires an MOC reference to publish an external submission%'
           AND prosrc LIKE '%Reviewer independence: you are on this revision''''s review roster%'
           AND prosrc LIKE '%IF is_org_controller(NEW.org_id) THEN%'
           AND prosrc LIKE '%You do not have authority to publish revisions in this library.%'
           AND prosrc LIKE '%Document has an active hold; release the hold before publishing a new revision.%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-18: the guard is SECURITY DEFINER with search_path pinned and no client role may execute it; the predicate is not executable by any client role either',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE')
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'is_controlled_issue_status'
                      AND NOT p.prosecdef AND p.provolatile = 'i')
       AND NOT has_function_privilege('anon', 'is_controlled_issue_status(text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'is_controlled_issue_status(text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'REV-18: trg_document_publish_guard still fires the guard on every documents UPDATE',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgname = 'trg_document_publish_guard' AND NOT t.tgisinternal
                  AND t.tgrelid = 'documents'::regclass AND p.proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-18: the retirement stamp columns exist, and a signed-in INSERT resets them — not-issued when born retired, else NULL (trg_document_retired_issue_stamp_insert, BEFORE INSERT; its function not SECURITY DEFINER, executable by no client role)',
       (SELECT count(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'documents'
           AND column_name IN ('retired_issue_status', 'retired_issue_version_id'))
       AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgname = 'trg_document_retired_issue_stamp_insert' AND NOT t.tgisinternal
                      AND t.tgrelid = 'documents'::regclass AND p.proname = 'document_retired_issue_stamp_on_insert'
                      AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4)
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'document_retired_issue_stamp_on_insert'
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                      AND p.prosrc LIKE '%NEW.retired_issue_version_id := NULL;%'
                      AND p.prosrc LIKE '%NEW.retired_issue_status := ''not-issued'';%')
       AND NOT has_function_privilege('authenticated', 'document_retired_issue_stamp_on_insert()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'REV-18: the guard''s owner (the guard runs as its owner) may execute is_controlled_issue_status — else every signed-in issue write fails with permission denied',
       COALESCE(has_function_privilege((SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                         WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard'),
                                       'is_controlled_issue_status(text)', 'EXECUTE'), false),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM dc_round_f_144_before;
