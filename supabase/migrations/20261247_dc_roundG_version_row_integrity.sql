-- ─────────────────────────────────────────────────────────────────────────────
-- 20261247_dc_roundG_version_row_integrity.sql
--
-- document-control Round G — P33 VERSION ROW INTEGRITY: a signed-in session
-- cannot forge a reviewed or an intake-shaped revision row (document-control
-- DCK-16, DCK-17; drafting-flow HAND-13 done-when 2's remainder; assigned by
-- the integrator at the P32 merge, 2026-10-21, DEC-31; ruled under DEC-90:
-- fail-safe, no regression).
--
--   The publish guard's lock leg (20261245) admits, over another person's
--   checkout, the reviewed promote of the pending draft still in review
--   (door (b), ratified under DEC-90 at the P32 merge): a draft with a bound
--   roster the review gate proved complete, or an external submission shaped
--   as the intake door writes it. The guard reads the version row and cannot
--   see who wrote it, and every column it reads was writable by a library
--   publisher:
--
--   DCK-16  document_versions_insert_integrity's publisher limb admitted a
--           row whatever its provenance, intake link or creator, and
--           document_versions_update_integrity (20261037) any change to any
--           column — so a publisher could INSERT, or re-shape by UPDATE, a
--           member-less 'external' draft naming the link that scopes an
--           intake-born or link-assigned document, and promote it over the
--           holder's checkout as if the contractor had submitted it.
--   DCK-17  no trigger kept review_state, released_at, superseded_at or
--           supersedes_version_id — so an earlier reviewed revision
--           (approved, released, superseded; its signed roster still bound)
--           could be relabelled 'in_review', pointed at and promoted over a
--           live checkout: an unrecorded revert.
--
-- This file:
--   §1 document_versions_insert_integrity re-created from its NEWEST body
--      (20261214, found by scanning; lineDiff-pinned) with ONE limb ANDed in
--      front: a signed-in session's row names no intake link, is not
--      'external' and is created by the session itself — or it is the
--      contractor door's own role (CURRENT_USER = 'intake_door', whose limb
--      below is kept byte for byte). The service role bypasses row-level
--      security and is not judged by it.
--   §2 ONE column guard on document_versions, BEFORE INSERT OR UPDATE —
--      enforce_document_version_row_integrity() — judging a signed-in session
--      only (auth.uid() set, and not the contractor door's bound identity),
--      whichever door the write comes through (a PostgREST request, a
--      SECURITY INVOKER function such as finalize_reviewed_promote, a
--      SECURITY DEFINER one such as publish_revision):
--        DCK-16  an INSERT carrying provenance 'external', an intake link, or
--                a creator other than the session is refused; an UPDATE that
--                changes intake_link_id or created_by, or moves provenance to
--                or from 'external', is refused;
--        DCK-17  an UPDATE that moves review_state INTO 'in_review' from any
--                other state (approved, rejected, superseded — or none), that
--                clears released_at or superseded_at once set, that changes
--                supersedes_version_id once set, or that moves the revision
--                to another document or organization (record_id / org_id —
--                a reviewed draft moved carries its signed roster with it)
--                is refused.
--      SECURITY INVOKER (it reads no table: NEW, OLD, auth.uid() and the
--      request's claims only — DRLS-16: definer rights are not needed),
--      search_path pinned, EXECUTE revoked from PUBLIC and anon.
--
-- What keeps working, exactly as today (enumerated; pinned on the I-17
-- harness, lib/__tests__/rls/dcP33VersionRowIntegrity.test.ts, before and
-- after this file):
--   * submit for review (the author's INSERT of an in-review draft, created
--     by itself, superseding the live revision) and its race-loser retire;
--   * a new document's first version, bulk upload, split / merge targets
--     (created by the session);
--   * finalize_reviewed_promote and promoteThreeStep's bookkeeping
--     (in_review → approved, released_at stamped, supersedes_version_id
--     written with the value submit / the door already gave it — the app
--     refuses a draft whose recorded base moved, REV-5 — and the prior's
--     superseded_at stamped);
--   * the Intake tab's approve (the same promote) and reject (in_review →
--     rejected, with its reason) and its MOC note;
--   * void a pending draft (superseded_at stamped), provenance declared on a
--     promote (NULL → 'declared'), Document Control's provenance verification
--     ('unverified' → 'declared'), a label correction, the effective date,
--     the shed / archive stamps;
--   * publish_revision (its INSERT is created by the session — p_actor is
--     auth.uid() for a signed-in caller — and its UPDATE stamps the prior's
--     superseded_at);
--   * the contractor door — not judged: intake_door_submit_version (the
--     role intake_door, or, where that role cannot be assumed, the door's
--     bound claims), intake_door_promote (a trusted link's auto-publish:
--     bound as the link's creator, publish_revision writes an 'external' row
--     created by that member and the door stamps its intake_link_id) and
--     intake_door_housekeep 'retire', 'restore' (superseded_at cleared and
--     superseded → in_review, both refused to a signed-in session) and
--     'withdraw' — each pinned on the harness on both sides. Promote and
--     housekeep run as the function's owner with the door's identity bound
--     in the request claims (intake_door_bind), so the guard's claims branch
--     is what exempts them; on the harness submit_version takes the same
--     bound-claims path. Dropping that branch fails the submit, promote and
--     restore cases (withdraw and retire only move forward);
--     intake_door_point_pending writes documents, not this table;
--   * the intake route's service-role writes (its legacy INSERT, the
--     withdrawal and its restore, the provenance stamp after a trusted
--     publish) — not judged;
--   * the org restore and the shed routes (service role).
--   Newly refused, by design: a signed-in session's publish_revision whose
--   p_version names provenance 'external' (no app path sends it), and
--   revup_rollback_orphan's clear of superseded_at on a sibling (no app
--   caller since REV-8).
--
-- The app works before and after this paste: no app path writes a row or a
-- change this file refuses (lib/reviewControl.ts reads no new column; the
-- DCK-15 notice is app-side). Nothing is deployed with it.
--
-- PASTE ORDER: AFTER 20261245 (required — the prerequisite below refuses,
-- changing nothing, without 20261245's lock leg or 20261214's door limb);
-- 20261245 is HOLD behind 20261193 (paste guide row 150), so this file waits
-- with them. Never re-paste 20261214 or 20261205 after this one: each would
-- re-create document_versions_insert_integrity without the §1 limb (the
-- §2 trigger would still refuse the same rows).
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the bases) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'
                  AND prosrc LIKE '%IF OLD.checked_out_by IS NOT NULL%This document is checked out by %') THEN
    RAISE EXCEPTION '20261247 needs 20261245 (the checkout lock leg in the publish guard) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE tablename = 'document_versions' AND policyname = 'document_versions_insert_integrity'
                    AND with_check LIKE '%intake_door%') THEN
    RAISE EXCEPTION '20261247 needs 20261214 (the intake door limb of document_versions_insert_integrity) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- Rows 2-4 count the forgery SIGNATURES only, so legitimate data reads 0:
--   * a trusted link's auto-publish (intake_door_promote / the route's
--     service-role publish_revision) is 'external', names its link and is
--     created by the link's creator (a member) — but it is PUBLISHED, never
--     in review (publish_revision writes no review_state), so it is not
--     counted; the door's in-review submission has no creator (or, in an
--     older shape, the link's id), so it is not counted either;
--   * a draft retired while in review — voided, replaced by a resubmission,
--     a race loser, a withdrawn or displaced submission — keeps 'in_review'
--     with superseded_at stamped; that is a legitimate retire and is not
--     counted. A draft in review is never RELEASED, so a released revision
--     marked in review is the relabel's signature.
--   A relabel of a revision that was never released (a rejected draft put
--   back into review) leaves no signature in the row and is not counted.
DROP TABLE IF EXISTS dc_round_g_247_before;
CREATE TEMP TABLE dc_round_g_247_before AS
WITH v AS (
  SELECT v.id,
         COALESCE(v.provenance, '') = 'external' AS is_external,
         (v.review_state = 'in_review'
          AND (COALESCE(v.provenance, '') = 'external' OR v.intake_link_id IS NOT NULL)
          AND v.created_by IS NOT NULL AND v.created_by IS DISTINCT FROM v.intake_link_id) AS forged_submission_look,
         (v.review_state = 'in_review' AND v.released_at IS NOT NULL) AS relabelled_look
    FROM document_versions v
)
SELECT 'inventory (before apply): revisions recorded as external submissions (informational — the door''s in-review submissions and a trusted link''s auto-publishes; unchanged, and from now on only the door and the intake route write one)' AS inventory,
       COUNT(*)::text AS n
  FROM v WHERE is_external
UNION ALL
SELECT 'inventory (before apply): revisions IN REVIEW recorded as external or naming an intake link whose creator is a member (the door files its submissions with no creator; a trusted auto-publish is published, not in review, and is not counted) — written by a signed-in session before this file; left as they are, expected 0',
       COUNT(*)::text
  FROM v WHERE forged_submission_look
UNION ALL
SELECT 'inventory (before apply): revisions marked in review that are already RELEASED (a draft in review is never released — a relabelled look; a draft voided, replaced or withdrawn in review keeps in_review with superseded_at set and is not counted) — left as they are, expected 0',
       COUNT(*)::text
  FROM v WHERE relabelled_look
UNION ALL
SELECT 'inventory (before apply): documents whose pending pointer names such a released in-review revision (expected 0)',
       COUNT(*)::text
  FROM documents d JOIN v ON v.id = d.pending_version_id
 WHERE v.relabelled_look;

BEGIN;

-- ── §1 DCK-16: document_versions_insert_integrity — 20261214 body + ONE limb ─
-- 20261214's body (the newest, found by scanning) + ONE limb ANDed in front
-- (DCK-16, P33): a signed-in session's row names no intake link, is not
-- 'external' and is created by the session itself — only the contractor
-- door's role (its limb below, unchanged) writes those. The service role
-- bypasses row-level security; enforce_document_version_row_integrity (§2)
-- judges the same columns on every door, UPDATE included.
-- INSERT: publisher-grade for anything, OR the author's own row when it is
-- either an unreleased in-review draft (submit-for-review) or the document's
-- FIRST version (the creation flows: upload-and-link, bulk upload,
-- split/merge targets). A released-looking row against a document with
-- history requires publish authority — the exact EGRESS-6 hole.
DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;
CREATE POLICY document_versions_insert_integrity ON document_versions
AS RESTRICTIVE FOR INSERT WITH CHECK (
  (
    CURRENT_USER = 'intake_door'
    OR (provenance IS DISTINCT FROM 'external' AND intake_link_id IS NULL AND created_by = auth.uid())
  )
  AND (
  user_can_publish_doc(record_id, org_id)
  OR (
    created_by = auth.uid()
    AND doc_is_visible(record_id)
    AND (
      (review_state = 'in_review' AND released_at IS NULL)
      OR NOT document_has_versions(document_versions.record_id)
    )
  )
  OR (
    CURRENT_USER = 'intake_door'
    AND review_state = 'in_review' AND released_at IS NULL
    AND provenance = 'external' AND intake_link_id IS NOT NULL AND created_by IS NULL
  )
  )
);

-- ── §2 DCK-16 + DCK-17: the column guard on document_versions ───────────────
CREATE OR REPLACE FUNCTION enforce_document_version_row_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Not a signed-in session: the service role (the intake route, the org
  -- restore, the shed routes), the SQL editor.
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  -- The contractor door's own identity: the role intake_door, or the bound
  -- claims the intake_door_* functions (service key only) set for one link
  -- (20261184 / 20261214). Its rows are judged by its own policies.
  IF CURRENT_USER = 'intake_door'
     OR COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'intake_door' THEN
    RETURN NEW;
  END IF;

  -- DCK-16: who submitted a revision, and through which link, is the door's
  -- record — a signed-in session never writes it, and files as itself.
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.provenance, '') = 'external' OR NEW.intake_link_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only the contractor door records a revision as an external submission through an intake link — a revision filed here is the organization''s. Nothing was changed. DCK-16, 20261247'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'A revision is recorded as created by the person who files it. Nothing was changed. DCK-16, 20261247'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.intake_link_id IS DISTINCT FROM OLD.intake_link_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR (NEW.provenance IS DISTINCT FROM OLD.provenance
         AND (COALESCE(NEW.provenance, '') = 'external' OR COALESCE(OLD.provenance, '') = 'external')) THEN
    RAISE EXCEPTION 'Who created a revision, whether it came through an intake link and which link are fixed when it is filed — they are not changed afterwards. Nothing was changed. DCK-16, 20261247'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- DCK-17: a revision's lifecycle moves forward only. Nothing a session
  -- does puts a revision back into review (submit a new one instead), and a
  -- release, a supersession or the revision it superseded, once recorded,
  -- is history.
  IF NEW.review_state = 'in_review' AND OLD.review_state IS DISTINCT FROM 'in_review' THEN
    RAISE EXCEPTION 'A revision that is not in review (approved, rejected, superseded, or never submitted) cannot be put back into review — submit a new revision for review instead. Nothing was changed. DCK-17, 20261247'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.released_at IS NOT NULL AND NEW.released_at IS NULL)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)
     OR (OLD.supersedes_version_id IS NOT NULL AND NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id) THEN
    RAISE EXCEPTION 'When a revision was released or superseded, and which revision it superseded, are its history — they are not cleared or rewritten. Nothing was changed. DCK-17, 20261247'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A revision belongs to the document (and organization) it was filed on:
  -- a reviewed draft moved onto another document would carry its signed
  -- roster — or a submission its link — to a document nobody reviewed it for.
  IF NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'A revision belongs to the document it was filed on — it is not moved to another document or organization. Nothing was changed. DCK-17, 20261247'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_document_version_row_integrity() IS
  'DCK-16 / DCK-17 (document-control P33, 20261247): a signed-in session (auth.uid() set, not the contractor door''s bound identity) cannot write a revision row as an external submission, through an intake link or as someone else, cannot change those columns afterwards, cannot move a revision back into review or onto another document, and cannot clear released_at / superseded_at or change supersedes_version_id once set — whichever door the write comes through. The service role and the door are not judged.';

DROP TRIGGER IF EXISTS trg_document_version_row_integrity ON document_versions;
CREATE TRIGGER trg_document_version_row_integrity
  BEFORE INSERT OR UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_document_version_row_integrity();

REVOKE ALL ON FUNCTION enforce_document_version_row_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_document_version_row_integrity() FROM anon;
GRANT EXECUTE ON FUNCTION enforce_document_version_row_integrity() TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 7. Inventory rows: n = the aggregate count.
-- pg_policies.with_check is DEPARSED (casts appear — no bare cast in a LIKE);
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here).
SELECT 'DCK-16 (P33): document_versions_insert_integrity refuses a signed-in session''s row that is external, names an intake link or is created by someone else — the contractor door''s role is the one exception' AS check,
       (SELECT with_check LIKE '%CURRENT_USER = %intake_door%OR ((provenance IS DISTINCT FROM %external%) AND (intake_link_id IS NULL) AND (created_by = auth.uid()))%'
          FROM pg_policies WHERE tablename = 'document_versions' AND policyname = 'document_versions_insert_integrity'
                             AND permissive = 'RESTRICTIVE' AND cmd = 'INSERT') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'DCK-16 (P33): its earlier limbs survive the re-create — a publisher''s row, the author''s in-review draft or first version, and the contractor door''s submission (no creator, ''external'', a link)',
       (SELECT with_check LIKE '%user_can_publish_doc(record_id, org_id)%(created_by = auth.uid())%doc_is_visible(record_id)%document_has_versions(record_id)%CURRENT_USER = %intake_door%(provenance = %external%(intake_link_id IS NOT NULL)%(created_by IS NULL)%'
          FROM pg_policies WHERE tablename = 'document_versions' AND policyname = 'document_versions_insert_integrity'),
       NULL
UNION ALL
SELECT 'DCK-16 (P33): the column guard refuses a signed-in INSERT that is external, names an intake link or another creator, and a signed-in UPDATE that changes the link or the creator or moves provenance to or from ''external''',
       (SELECT prosrc LIKE '%IF TG_OP = ''INSERT'' THEN%IF COALESCE(NEW.provenance, '''') = ''external'' OR NEW.intake_link_id IS NOT NULL THEN%IF NEW.created_by IS DISTINCT FROM v_uid THEN%IF NEW.intake_link_id IS DISTINCT FROM OLD.intake_link_id%OR NEW.created_by IS DISTINCT FROM OLD.created_by%OR (NEW.provenance IS DISTINCT FROM OLD.provenance%'
          FROM pg_proc WHERE proname = 'enforce_document_version_row_integrity'),
       NULL
UNION ALL
SELECT 'DCK-17 (P33): the column guard refuses a signed-in UPDATE that moves a revision back into review, clears released_at or superseded_at, changes supersedes_version_id once set, or moves the revision to another document',
       (SELECT prosrc LIKE '%IF NEW.review_state = ''in_review'' AND OLD.review_state IS DISTINCT FROM ''in_review'' THEN%(OLD.released_at IS NOT NULL AND NEW.released_at IS NULL)%(OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)%(OLD.supersedes_version_id IS NOT NULL AND NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id)%IF NEW.record_id IS DISTINCT FROM OLD.record_id OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN%'
          FROM pg_proc WHERE proname = 'enforce_document_version_row_integrity'),
       NULL
UNION ALL
SELECT 'the column guard judges a signed-in session only: the service role / SQL editor (no auth.uid()) and the contractor door''s identity are not judged',
       (SELECT prosrc LIKE '%IF v_uid IS NULL THEN RETURN NEW; END IF;%IF CURRENT_USER = ''intake_door''%= ''intake_door'' THEN%RETURN NEW;%'
          FROM pg_proc WHERE proname = 'enforce_document_version_row_integrity'),
       NULL
UNION ALL
SELECT 'the column guard is SECURITY INVOKER with search_path pinned, neither PUBLIC nor anon may execute it, and trg_document_version_row_integrity fires it BEFORE INSERT OR UPDATE FOR EACH ROW on document_versions',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enforce_document_version_row_integrity'
                  AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'enforce_document_version_row_integrity()', 'EXECUTE')
       AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE t.tgname = 'trg_document_version_row_integrity' AND NOT t.tgisinternal
                      AND t.tgrelid = 'document_versions'::regclass AND p.proname = 'enforce_document_version_row_integrity'
                      AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16),
       NULL
UNION ALL
SELECT 'the contractor door''s own policies are untouched (document_versions_intake_door_insert and _scope, TO intake_door)',
       (SELECT count(*) = 2 FROM pg_policies
         WHERE tablename = 'document_versions' AND roles = ARRAY['intake_door']::name[]
           AND policyname IN ('document_versions_intake_door_insert', 'document_versions_intake_door_scope')),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_g_247_before;
