-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F (P4 REVIEW) — the review gate counts SLOTS, and a
-- missing roster is not a missing gate.
--
--   · RG-4 / DRLS-6 — completion was a bare signature count: two primaries
--     (Piping + I&E) and one piping alternate published on two piping
--     signatures. Every PRIMARY roster row is now a SLOT in its `slot_group`
--     (the policy entry that produced it: person:<uid> / role:<Role> /
--     team:<teamId>); a slot is filled by its own primary's bound signature
--     or by the bound signature of an ACTIVATED alternate of the SAME group,
--     one signature per slot. A standby alternate fills nothing; a named
--     alternate the policy never paired (NULL group) fills nothing. Primaries
--     count in EVERY status — exactly what lib/reviewControl.ts
--     evaluateSlotCompletion counts, so the app and the guard cannot
--     disagree (DRLS-6 done-when 3). Rows written before this migration
--     carry no group and share one legacy group, which reproduces the old
--     aggregate arithmetic for in-flight rosters only.
--   · DRLS-6 — any active member could INSERT a roster row naming
--     themself as an ACTIVATED alternate and then sign it with their own
--     signature; the INSERT policy now requires the publisher tier
--     (controller / effective owner / library publisher — opening a roster
--     is a publisher's act, submitForReview runs after authorizePublish),
--     binds the row's org to the document's, and requires a primary to be
--     born active and an alternate born standby. Flipping `activated` takes
--     the same tier (the cron scan is service-role and passes).
--   · RG-8 / DEC-21 — the draft's author (document_versions.created_by)
--     may not sign it as its reviewer, unless the library opted out of
--     independent review (review_control.requireIndependentReviewer=false).
--   · RG-7 — an absent roster used to mean "no gate": a draft SUBMITTED
--     for review (review_state='in_review', not an intake submission) with
--     no primary slot may not be promoted, and a direct non-Minor publish on
--     a document whose EFFECTIVE policy (document → folder → ancestors →
--     library, review_control_mode_for below — the SQL twin of
--     lib/containerChain.ts) is 'require' is refused when no roster exists.
--     A document's first controlled revision is not a revision through the
--     gate (OLD.current_version_id IS NULL passes, as the app does).
--   · REV-5 — finalizeReviewedRevision now refuses a draft whose recorded
--     base (supersedes_version_id) is not the current revision. Intake
--     submissions made BEFORE this round carry no base (the route stamped it
--     only on the auto path); they are inventoried and BACKFILLED here to
--     the revision current at apply time, one audit row per document
--     (REVIEW_BASE_BACKFILLED), so no in-flight vendor revision has to be
--     rejected and re-uploaded.
--   · review_control_mode_for is SECURITY INVOKER: called from the
--     SECURITY DEFINER publish guard it reads past RLS as the trigger does;
--     called by a member it reads only what their RLS lets them see, so
--     nobody can probe another org's review mode by id.
--
-- Bodies: enforce_review_signoff_guard starts from the live 20261047 body,
-- enforce_document_publish_guard from the live 20261060 body; each change is
-- line-diffed by lib/__tests__/dcRoundFReviewGate.test.ts.
--
-- NARROWING everywhere (no member gains anything). DEC-30 inventory captured
-- BEFORE the DDL: the in-flight drafts this changes the meaning of.
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _dc_f70_before AS
SELECT 'documents with a draft in review (pending_version_id set)' AS what, COUNT(*) AS n
  FROM documents WHERE pending_version_id IS NOT NULL
UNION ALL
SELECT 'in-review drafts with ZERO primary roster rows and no intake link (RG-7: can no longer be promoted; resubmit)', COUNT(*)
  FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
 WHERE v.review_state = 'in_review' AND v.intake_link_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs s WHERE s.document_version_id = v.id AND s.slot = 'primary')
UNION ALL
SELECT 'in-review intake submissions (exempt from the roster rails; the approve click is the review)', COUNT(*)
  FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
 WHERE v.review_state = 'in_review' AND v.intake_link_id IS NOT NULL
UNION ALL
SELECT 'of which with NO recorded base on a document that has a current revision (REV-5: backfilled below, audited per document)', COUNT(*)
  FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
 WHERE v.review_state = 'in_review' AND v.intake_link_id IS NOT NULL
   AND v.supersedes_version_id IS NULL AND d.current_version_id IS NOT NULL
UNION ALL
SELECT 'roster rows on drafts still in review (all become the legacy slot group)', COUNT(*)
  FROM document_review_signoffs s JOIN documents d ON d.pending_version_id = s.document_version_id
UNION ALL
SELECT 'of which ACTIVATED alternates (their signatures keep counting under the legacy group)', COUNT(*)
  FROM document_review_signoffs s JOIN documents d ON d.pending_version_id = s.document_version_id
 WHERE s.slot = 'alternate' AND s.activated
UNION ALL
SELECT 'of which SIGNED rows whose reviewer authored the draft (RG-8: already signed, untouched; future signings refused)', COUNT(*)
  FROM document_review_signoffs s JOIN documents d ON d.pending_version_id = s.document_version_id
  JOIN document_versions v ON v.id = s.document_version_id
 WHERE s.status = 'signed' AND s.reviewer_user_id = v.created_by
UNION ALL
SELECT 'libraries whose review_control mode is require (direct Major publishes now need a roster at the database)', COUNT(*)
  FROM libraries WHERE review_control->>'mode' = 'require';

BEGIN;

-- ── RG-4: the slot group column ─────────────────────────────────────────────
ALTER TABLE document_review_signoffs ADD COLUMN IF NOT EXISTS slot_group TEXT;
COMMENT ON COLUMN document_review_signoffs.slot_group IS
  'RG-4: the review slot this row holds (primary) or may stand in for (alternate): person:<uid> | role:<Role> | team:<teamId>. NULL = legacy row (pre-20261070) or an unpaired named alternate, which satisfies no slot.';

-- ── REV-5: bind the base of in-flight intake drafts that never recorded one ─
-- Only pending (in_review) INTAKE drafts on a document that has a current
-- revision; the base becomes the revision current NOW — the same binding a
-- controller's approve click makes. Idempotent (NULL bases only). One audit
-- row per document, service-role shaped (user_id NULL), in this transaction.
WITH backfilled AS (
  UPDATE document_versions v
     SET supersedes_version_id = d.current_version_id
    FROM documents d
   WHERE d.pending_version_id = v.id
     AND d.current_version_id IS NOT NULL
     AND v.intake_link_id IS NOT NULL
     AND v.review_state = 'in_review'
     AND v.supersedes_version_id IS NULL
  RETURNING v.id AS version_id, v.record_id AS document_id, d.org_id, d.current_version_id
)
INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
SELECT 'REVIEW_BASE_BACKFILLED', 'document', document_id::text, org_id, NULL, NULL, NULL,
       jsonb_build_object('via', 'migration', 'migration', '20261070',
                          'versionId', version_id, 'supersedesVersionId', current_version_id,
                          'reason', 'REV-5: intake draft submitted before the route recorded its base; bound to the revision current at apply time')
  FROM backfilled;

-- ── DRLS-6 / RG-4: opening a roster is a publisher''s act, in roster shape ───
DROP POLICY IF EXISTS doc_review_signoff_insert ON document_review_signoffs;
CREATE POLICY doc_review_signoff_insert ON document_review_signoffs FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = document_review_signoffs.org_id
      AND uid = auth.uid()
      AND status = 'active'
  )
  AND document_review_signoffs.status = 'pending'
  AND document_review_signoffs.signature_id IS NULL
  AND document_review_signoffs.signed_at IS NULL
  -- a primary is born active; an alternate is born standby and is activated
  -- later by a manager or the timeout scan (guarded below)
  AND ((document_review_signoffs.slot = 'primary' AND document_review_signoffs.activated)
       OR (document_review_signoffs.slot = 'alternate' AND NOT document_review_signoffs.activated))
  -- the publisher tier opens rosters; the row''s org is the document''s org
  AND (
    is_org_controller(document_review_signoffs.org_id)
    OR EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_review_signoffs.document_id
        AND d.org_id = document_review_signoffs.org_id
        AND (user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
             OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id))
    )
  )
);

-- ── RG-7: the effective review MODE along the container chain (SQL twin of
--    lib/containerChain.ts: document → folder → ancestors nearest first →
--    library; a DEFINED level is a stored policy object) ────────────────────
-- SECURITY INVOKER on purpose: from the SECURITY DEFINER publish guard it
-- runs as the guard's owner (past RLS, as the trigger must); called directly
-- by a member it sees only their own org's rows (RLS), so it cannot be used
-- to probe another org's collection or library review mode by id.
CREATE OR REPLACE FUNCTION review_control_mode_for(p_doc_control jsonb, p_collection_id uuid, p_library_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    CASE WHEN jsonb_typeof(p_doc_control) = 'object' THEN COALESCE(p_doc_control->>'mode', 'none') END,
    (SELECT COALESCE(c.review_control->>'mode', 'none')
       FROM collections c
      WHERE c.id = p_collection_id AND jsonb_typeof(c.review_control) = 'object'),
    (SELECT COALESCE(a.review_control->>'mode', 'none')
       FROM collections c
       CROSS JOIN LATERAL unnest(c.path_ids) WITH ORDINALITY AS p(id, ord)
       JOIN collections a ON a.id = p.id
      WHERE c.id = p_collection_id AND jsonb_typeof(a.review_control) = 'object'
      ORDER BY p.ord DESC
      LIMIT 1),
    (SELECT COALESCE(l.review_control->>'mode', 'none')
       FROM libraries l
      WHERE l.id = p_library_id AND jsonb_typeof(l.review_control) = 'object'),
    'none');
$$;
REVOKE ALL ON FUNCTION review_control_mode_for(jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_control_mode_for(jsonb, uuid, uuid) TO authenticated, service_role;

-- ── RG-4 / RG-8: the sign-off guard (body from 20261047) ────────────────────
CREATE OR REPLACE FUNCTION enforce_review_signoff_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service-role / cron / restore writes carry no JWT and are trusted.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- The row's identity is immutable — repointing an approval at a different
  -- reviewer, slot, draft or document is never a legitimate edit.
  IF NEW.reviewer_user_id     IS DISTINCT FROM OLD.reviewer_user_id
     OR NEW.reviewer_name      IS DISTINCT FROM OLD.reviewer_name
     OR NEW.slot               IS DISTINCT FROM OLD.slot
     OR NEW.slot_group         IS DISTINCT FROM OLD.slot_group
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.document_id        IS DISTINCT FROM OLD.document_id
     OR NEW.org_id             IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Review sign-off rows are immutable in identity — void it and open a new roster instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- RG-4: activating an alternate is a manager's act — a controller, the
  -- document's effective owner or a library publisher (the timeout scan is
  -- service-role and returned above). Never the alternate themself.
  IF NEW.activated AND NOT OLD.activated THEN
    IF NOT is_org_controller(OLD.org_id) AND NOT EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = OLD.document_id
        AND (user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
             OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id))
    ) THEN
      RAISE EXCEPTION 'Only a document controller, the document''s owner or a library publisher can activate an alternate reviewer.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- SURF-13: a signature is attached only by the act of signing.
  IF NEW.signature_id IS DISTINCT FROM OLD.signature_id AND NEW.status IS DISTINCT FROM 'signed' THEN
    RAISE EXCEPTION 'A signature can only be attached to a review row by signing it.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Becoming signed: only the named reviewer, with their own e-signature
  -- bound to this exact draft. (e_signatures is self-insert-only by RLS, so
  -- signer_user_id is trustworthy.)
  IF NEW.status = 'signed' AND OLD.status IS DISTINCT FROM 'signed' THEN
    IF OLD.reviewer_user_id::text <> auth.uid()::text THEN
      RAISE EXCEPTION 'Only the named reviewer can sign their own review row.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- RG-4: a standby alternate has no slot to sign for.
    IF OLD.slot = 'alternate' AND NOT NEW.activated THEN
      RAISE EXCEPTION 'A standby alternate cannot sign — the alternate must be activated first.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- RG-8 / DEC-21: the draft's author never signs it as its reviewer,
    -- unless the library opted out of independent review.
    IF EXISTS (SELECT 1 FROM document_versions v
                WHERE v.id = OLD.document_version_id AND v.created_by::text = auth.uid()::text)
       AND COALESCE((SELECT (l.review_control->>'requireIndependentReviewer')::boolean
                       FROM documents d JOIN libraries l ON l.id = d.library_id
                      WHERE d.id = OLD.document_id), true) THEN
      RAISE EXCEPTION 'You authored this revision, so you can''t sign it as its reviewer — a reviewer''s sign-off has to come from someone else.'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Strict on every axis for NEW signings: the app always stamps the
    -- signature with this draft's version and org, and signature_id carries
    -- no FK — without the org/version match a dangling or reused UUID (even
    -- another org's) would pass.
    IF NEW.signature_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM e_signatures e
      WHERE e.id = NEW.signature_id
        AND e.signer_user_id::text = auth.uid()::text
        AND e.org_id = OLD.org_id
        AND e.document_version_id = OLD.document_version_id
    ) THEN
      RAISE EXCEPTION 'A review sign-off must carry the reviewer''s own e-signature for this draft.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A recorded approval cannot be quietly edited or resurrected: on a row
  -- already signed, the signature may not be swapped, and the only way OUT of
  -- 'signed' (or back from any decided state to 'pending') is void/invalidate.
  IF OLD.status = 'signed' AND NEW.status = 'signed'
     AND (NEW.signature_id IS DISTINCT FROM OLD.signature_id
          OR NEW.signed_at IS DISTINCT FROM OLD.signed_at) THEN
    RAISE EXCEPTION 'A signed review row''s signature cannot be altered.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'A decided review row cannot return to pending — open a new roster for a new draft.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ── RG-4 / RG-7: the publish guard (body from 20261060) ─────────────────────
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

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 9. Inventory rows: n = the aggregate count.
SELECT 'slot_group column exists on document_review_signoffs' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'document_review_signoffs' AND column_name = 'slot_group') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'INSERT policy: pending + unsigned, primary born active / alternate born standby, publisher tier, org bound to the document',
       (SELECT with_check LIKE '%status = ''pending''%'
           AND with_check LIKE '%signature_id IS NULL%'
           AND with_check LIKE '%slot = ''primary''%' AND with_check LIKE '%slot = ''alternate''%'
           AND with_check LIKE '%is_org_controller(%'
           AND with_check LIKE '%user_can_publish_on_library(%'
           AND with_check LIKE '%d.org_id = document_review_signoffs.org_id%'
          FROM pg_policies WHERE tablename = 'document_review_signoffs' AND policyname = 'doc_review_signoff_insert'),
       NULL::text
UNION ALL
SELECT 'sign-off guard: activation takes the publisher tier; a standby alternate cannot sign; the author cannot sign',
       (SELECT prosrc LIKE '%can activate an alternate reviewer%'
           AND prosrc LIKE '%A standby alternate cannot sign%'
           AND prosrc LIKE '%You authored this revision%'
           AND prosrc LIKE '%NEW.slot_group         IS DISTINCT FROM OLD.slot_group%'
          FROM pg_proc WHERE proname = 'enforce_review_signoff_guard'),
       NULL::text
UNION ALL
SELECT 'sign-off guard keeps SURF-13 and the RG-2 own-signature rail',
       (SELECT prosrc LIKE '%A signature can only be attached to a review row by signing it%'
           AND prosrc LIKE '%Only the named reviewer can sign their own review row%'
          FROM pg_proc WHERE proname = 'enforce_review_signoff_guard'),
       NULL::text
UNION ALL
SELECT 'publish guard counts per slot group and keeps the bound-signature join',
       (SELECT prosrc LIKE '%GROUP BY COALESCE(s.slot_group, '''')%'
           AND prosrc LIKE '%sum(LEAST(g.reqs, g.filled))%'
           AND prosrc LIKE '%(s.slot = ''primary'' OR s.activated)%'
           AND prosrc LIKE '%e.signer_user_id = s.reviewer_user_id%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL::text
UNION ALL
SELECT 'publish guard: an in-review draft with no roster, and a required-review Major direct publish, are refused',
       (SELECT prosrc LIKE '%has no reviewer roster%'
           AND prosrc LIKE '%requires reviewer sign-off for a Major revision%'
           AND prosrc LIKE '%review_control_mode_for(NEW.review_control, NEW.collection_id, NEW.library_id)%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL::text
UNION ALL
SELECT 'authority order intact: review gate, then is_org_controller, then publisher-or-owner, then hold (20261060 survives)',
       (SELECT position('is_org_controller(NEW.org_id)' IN prosrc) > position('outstanding review sign-offs' IN prosrc)
           AND position('user_can_publish_on_library(NEW.library_id' IN prosrc) > position('is_org_controller(NEW.org_id)' IN prosrc)
           AND position('Document has an active hold' IN prosrc) > position('user_can_publish_on_library(NEW.library_id' IN prosrc)
           AND prosrc LIKE '%(NEW.status = ''Archived'' AND COALESCE(OLD.status, '''') <> ''Archived'')%'
           AND prosrc LIKE '%Reviewer independence%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL::text
UNION ALL
SELECT 'review_control_mode_for walks folder → ancestors (path_ids, nearest first) → library',
       (SELECT prosrc LIKE '%unnest(c.path_ids) WITH ORDINALITY%'
           AND prosrc LIKE '%ORDER BY p.ord DESC%'
           AND prosrc LIKE '%FROM libraries l%'
          FROM pg_proc WHERE proname = 'review_control_mode_for'),
       NULL::text
UNION ALL
SELECT 'both guards are SECURITY DEFINER with search_path pinned; review_control_mode_for is SECURITY INVOKER (no cross-org probe) and pinned',
       (SELECT bool_and(prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%')
          FROM pg_proc WHERE proname IN ('enforce_document_publish_guard', 'enforce_review_signoff_guard'))
       AND (SELECT NOT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'review_control_mode_for'),
       NULL::text
UNION ALL
SELECT 'inventory (after apply): pending intake drafts with NO recorded base on a document with a current revision (REV-5; expect 0)', NULL::boolean,
       (SELECT COUNT(*) FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
         WHERE v.review_state = 'in_review' AND v.intake_link_id IS NOT NULL
           AND v.supersedes_version_id IS NULL AND d.current_version_id IS NOT NULL)::text
UNION ALL
SELECT 'inventory (after apply): REVIEW_BASE_BACKFILLED audit rows written by this paste', NULL::boolean,
       (SELECT COUNT(*) FROM audit_logs WHERE action = 'REVIEW_BASE_BACKFILLED' AND details->>'migration' = '20261070')::text
UNION ALL
SELECT 'inventory (before apply): ' || what, NULL::boolean, n::text FROM _dc_f70_before
UNION ALL
SELECT 'inventory (after apply): roster rows with a slot_group (new rosters only; expect 0 right after apply)', NULL::boolean,
       (SELECT COUNT(*) FROM document_review_signoffs WHERE slot_group IS NOT NULL)::text;
