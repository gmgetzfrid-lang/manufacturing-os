-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F wave 2 — P12 WAVE-2 RESIDUALS: a non-controller's
-- first issue under require mode (REV-17) and the revision-branch close-out
-- (DRLS-9).
--
--   REV-17  enforce_document_publish_guard's RG-7 block raised "requires
--           reviewer sign-off" only for a revision THROUGH the gate
--           (OLD.current_version_id IS NOT NULL), so a NULL -> version first
--           pointer write passed whatever the policy: a non-controller owner
--           in a library whose policy requires sign-off could write an
--           Issued documents row, its first revision and the first pointer
--           from their own session, and an unreviewed controlled Rev 0
--           landed. The app refused it (REV-11, resolveCreationReviewGate);
--           the database did not. Re-created from its NEWEST body (20261105,
--           J1 — 20261130 / 20261131 do not re-create it) plus ONE block in
--           the zero-roster branch: a first pointer write onto a document in
--           an issued status (not Draft / In Review / Superseded / Void /
--           Archived — lib/revisions.ts isControlledIssueStatus) by a
--           non-controller, when the folder / library chain or the
--           document's own policy requires sign-off, is refused. A first
--           revision that carries a complete roster passes (it was
--           reviewed); intake-linked versions are SEC-13's (below it); a
--           controller proceeds (DEC-63 s.2 — the app records the decision).
--           Every other line of the 20261105 body is carried byte for byte
--           (pinned by a lineDiff test).
--   DRLS-9  revision_branches_org_update (20261061, R&P Round E OWN-21 /
--           DEC-11 — a controller or the document's effective owner) had no
--           WITH CHECK, so the resolver could close the debt with no note,
--           no resolution, in someone else's name, or as 'merged' with
--           nothing merged. Re-created with its USING byte for byte and a
--           WITH CHECK: the same authority AND the row comes out resolved
--           (resolved_at set, resolution merged | withdrawn, a non-empty
--           resolution_note, resolved_by = the caller) AND a 'merged' claim
--           names a later revision — the document's current revision is not
--           the branch and was written after it; otherwise it is recorded
--           'withdrawn'.
--
-- NOT a widening: both changes refuse something that was allowed. DEC-30
-- inventories (aggregate counts, captured BEFORE the transaction): documents
-- issued the way REV-17 now refuses (and how many of those a member who is
-- not now a controller created) — not changed by the apply, the rail binds
-- the next first issue; revision branches open, resolved with no note, with
-- no resolution, or resolved 'merged' while the document's current revision
-- is not later than the branch — kept for the record, the rail binds the
-- next resolution.
-- The trigger function is not callable directly (it RETURNS trigger); its
-- EXECUTE is revoked from PUBLIC and every client role anyway (DRLS-16 rule)
-- — a trigger's function privilege is checked when the trigger is created,
-- never when it fires (exercised: the guard still refuses after the revoke).
-- HOW TO APPLY: after 20261105 (the guard's base) and 20261061 (the
-- policy's base); it pastes cleanly before or after 20261129 / 20261130 /
-- 20261131, BUT REV-17's refusal is complete only once 20261131's
-- trg_document_insert_pointer_rail is live too: this guard fires BEFORE
-- UPDATE, so until then a member can INSERT a document already pointing at a
-- revision and reach the issue as a non-first pointer move. Do not re-paste
-- 20261105 after this one (it would drop the REV-17 block).
-- Single paste: temp-table inventory -> BEGIN/DDL/COMMIT -> one SELECT
-- (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_139_before;
CREATE TEMP TABLE dc_round_f_139_before AS
SELECT 'inventory (before apply): documents in an issued status whose current revision is their first, with no reviewer roster and no intake link, under a policy that requires sign-off (REV-17: first issues the guard admitted unreviewed)' AS inventory,
       COUNT(*)::text AS n
  FROM documents d
  JOIN document_versions cv ON cv.id = d.current_version_id
 WHERE COALESCE(d.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')
   AND cv.intake_link_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM document_versions v2
                    WHERE v2.record_id = d.id AND v2.id <> cv.id AND v2.created_at < cv.created_at)
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs s
                    WHERE s.document_version_id = cv.id AND s.slot = 'primary')
   AND (review_control_mode_for(NULL, d.collection_id, d.library_id) = 'require'
        OR review_control_mode_for(d.review_control, d.collection_id, d.library_id) = 'require')
UNION ALL
SELECT 'inventory (before apply): of those, documents whose creator is not now an active controller of their org (is_org_controller''s predicate, spelled out for another user)',
       COUNT(*)::text
  FROM documents d
  JOIN document_versions cv ON cv.id = d.current_version_id
 WHERE COALESCE(d.status, '') NOT IN ('Draft', 'In Review', 'Superseded', 'Void', 'Archived')
   AND cv.intake_link_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM document_versions v2
                    WHERE v2.record_id = d.id AND v2.id <> cv.id AND v2.created_at < cv.created_at)
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs s
                    WHERE s.document_version_id = cv.id AND s.slot = 'primary')
   AND (review_control_mode_for(NULL, d.collection_id, d.library_id) = 'require'
        OR review_control_mode_for(d.review_control, d.collection_id, d.library_id) = 'require')
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = d.org_id AND m.uid::text = d.created_by::text AND m.status = 'active'
                      AND (m.role IN ('Admin', 'DocCtrl') OR m.roles && ARRAY['Admin', 'DocCtrl']::text[]))
UNION ALL
SELECT 'inventory (before apply): revision branches still open (DRLS-9)', COUNT(*)::text
  FROM revision_branches WHERE resolved_at IS NULL
UNION ALL
SELECT 'inventory (before apply): resolved revision branches with no resolution note (DRLS-9 - kept; the rail binds the next resolution)', COUNT(*)::text
  FROM revision_branches WHERE resolved_at IS NOT NULL AND btrim(COALESCE(resolution_note, '')) = ''
UNION ALL
SELECT 'inventory (before apply): resolved revision branches with no resolution (DRLS-9)', COUNT(*)::text
  FROM revision_branches WHERE resolved_at IS NOT NULL AND resolution IS NULL
UNION ALL
SELECT 'inventory (before apply): branches resolved ''merged'' while the document''s current revision is not later than the branch (DRLS-9 - the claim the rail now refuses)', COUNT(*)::text
  FROM revision_branches rb
 WHERE rb.resolved_at IS NOT NULL AND rb.resolution = 'merged'
   AND NOT EXISTS (SELECT 1 FROM documents d
                     JOIN document_versions cv ON cv.id = d.current_version_id
                     JOIN document_versions bv ON bv.id = rb.branch_version_id
                    WHERE d.id = rb.document_id AND cv.id <> bv.id AND cv.created_at > bv.created_at);

BEGIN;

-- ── 1. REV-17: the publish guard — 20261105 body + the first-issue block ────
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

-- ── 2. DRLS-9: revision_branches UPDATE — 20261061's USING + a WITH CHECK ───
DROP POLICY IF EXISTS revision_branches_org_update ON revision_branches;
CREATE POLICY revision_branches_org_update ON revision_branches FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = revision_branches.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND (
    is_org_controller(org_id)
    OR EXISTS (SELECT 1 FROM documents d
                WHERE d.id = revision_branches.document_id
                  AND user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid()))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = revision_branches.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND (
    is_org_controller(org_id)
    OR EXISTS (SELECT 1 FROM documents d
                WHERE d.id = revision_branches.document_id
                  AND user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid()))
  )
  -- DRLS-9: an UPDATE is a resolution, on the record. The row comes out
  -- resolved, with a resolution and a non-empty note, by the caller (no
  -- resolving in someone else's name) ...
  AND resolved_at IS NOT NULL
  AND resolution IN ('merged', 'withdrawn')
  AND btrim(COALESCE(resolution_note, '')) <> ''
  AND resolved_by = auth.uid()::text
  -- ... and a 'merged' claim names a later revision that supersedes the
  -- branch: the document's current revision is not the branch and was
  -- written after it. Anything else is recorded as 'withdrawn'.
  AND (
    resolution = 'withdrawn'
    OR EXISTS (SELECT 1 FROM documents d
                 JOIN document_versions cv ON cv.id = d.current_version_id
                 JOIN document_versions bv ON bv.id = revision_branches.branch_version_id
                WHERE d.id = revision_branches.document_id
                  AND cv.id <> bv.id
                  AND cv.created_at > bv.created_at)
  )
);

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row. Inventory rows carry ok NULL and the
--    count in n. pg_policies.qual / with_check are DEPARSED (no casts inside a
--    LIKE pattern); pg_proc.prosrc is verbatim.
SELECT 'REV-17: the publish guard refuses a non-controller''s first issue under require mode (the first-pointer block is in the body)' AS check,
       (SELECT prosrc LIKE '%IF OLD.current_version_id IS NULL AND v_intake_link IS NULL%'
           AND prosrc LIKE '%AND COALESCE(NEW.status, '''') NOT IN (''Draft'', ''In Review'', ''Superseded'', ''Void'', ''Archived'')%'
           AND prosrc LIKE '%AND NOT is_org_controller(NEW.org_id)%'
           AND prosrc LIKE '%review_control_mode_for(NULL, NEW.collection_id, NEW.library_id) = ''require''%'
           AND prosrc LIKE '%a new document can''''t be issued unreviewed%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'REV-17: the 20261105 rules survive (RG-7 Major block, SEC-13, SEC-14, reviewer independence, the hold, the controller short-circuit)',
       (SELECT prosrc LIKE '%requires reviewer sign-off for a Major revision%'
           AND prosrc LIKE '%send the external submission to its reviewers before publishing it%'
           AND prosrc LIKE '%PSM requires an MOC reference to publish an external submission%'
           AND prosrc LIKE '%Reviewer independence: you are on this revision''''s review roster%'
           AND prosrc LIKE '%Document has an active hold%'
           AND prosrc LIKE '%IF is_org_controller(NEW.org_id) THEN%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'REV-17: the guard is SECURITY DEFINER with search_path pinned, and no client role (anon, authenticated) may execute it directly',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_publish_guard'
                  AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'enforce_document_publish_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_document_publish_guard()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'REV-17: trg_document_publish_guard still fires the guard on documents',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgname = 'trg_document_publish_guard' AND NOT t.tgisinternal
                  AND t.tgrelid = 'documents'::regclass AND p.proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'DRLS-9: revision_branches UPDATE keeps 20261061''s USING (active member AND (controller OR effective owner))',
       (SELECT qual LIKE '%org_members.status = ''active''%'
           AND qual LIKE '%is_org_controller(org_id)%'
           AND qual LIKE '%user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())%'
          FROM pg_policies WHERE tablename = 'revision_branches' AND policyname = 'revision_branches_org_update'),
       NULL
UNION ALL
SELECT 'DRLS-9: the WITH CHECK takes the same authority and requires a resolution on the record (resolved, merged | withdrawn, a note, by the caller)',
       (SELECT with_check LIKE '%is_org_controller(org_id)%'
           AND with_check LIKE '%user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())%'
           AND with_check LIKE '%resolved_at IS NOT NULL%'
           AND with_check LIKE '%''merged''%' AND with_check LIKE '%''withdrawn''%'
           AND with_check LIKE '%btrim(COALESCE(resolution_note, %'
           AND with_check LIKE '%resolved_by = (auth.uid())%'
          FROM pg_policies WHERE tablename = 'revision_branches' AND policyname = 'revision_branches_org_update'),
       NULL
UNION ALL
SELECT 'DRLS-9: a ''merged'' resolution names a later current revision (cv.created_at > bv.created_at, not the branch itself)',
       (SELECT with_check LIKE '%cv.id <> bv.id%' AND with_check LIKE '%cv.created_at > bv.created_at%'
          FROM pg_policies WHERE tablename = 'revision_branches' AND policyname = 'revision_branches_org_update'),
       NULL
UNION ALL
SELECT 'DRLS-9: exactly one UPDATE policy on revision_branches, SELECT / INSERT untouched, no DELETE policy',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE tablename = 'revision_branches' AND cmd = 'UPDATE')
       AND (SELECT COUNT(*) = 2 FROM pg_policies WHERE tablename = 'revision_branches'
              AND policyname IN ('revision_branches_org_select', 'revision_branches_org_insert'))
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'revision_branches' AND cmd IN ('DELETE', 'ALL')),
       NULL
UNION ALL
SELECT inventory, NULL, n FROM dc_round_f_139_before;
