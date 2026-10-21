-- ─────────────────────────────────────────────────────────────────────────────
-- 20261252_dc_roundG_door_b_record.sql
--
-- document-control Round G — P35 DOOR B RECORD: a reviewed promote over
-- another person's checkout is recorded and the holder told by the database,
-- whichever caller ran it (document-control DCK-18; assigned by the
-- integrator at the P33 merge, 2026-10-21, DEC-31; ruled under DEC-90:
-- fail-safe, no regression).
--
--   DCK-18  The publish guard's lock leg (20261245) admits, over another
--           person's checkout, the reviewed promote of the pending draft
--           still in review — door (b), ratified under DEC-90 so a review
--           stays finishable while the drafter keeps the checkout. P33
--           (DCK-15) tells the holder and records the pass from the APP,
--           after the promote (lib/reviewControl.ts notePromoteOverCheckout).
--           A promote made outside the app — someone with publish authority
--           calling finalize_reviewed_promote through PostgREST (it is
--           granted to authenticated), or the service role — was neither
--           told nor recorded, and a notice or a row the app failed to write
--           was only logged.
--
-- This file re-creates finalize_reviewed_promote from its NEWEST body
-- (20261151, found by scanning; lineDiff-pinned — every line of the base is
-- kept but the last parameter's, which gains a comma) with:
--   * in the promote's own transaction, when the document was checked out by
--     someone OTHER than the actor (COALESCE(auth.uid(), p_actor); the
--     checkout read after the promote, which writes no checkout column, so
--     the row's values before it): a queued notice to the holder of the
--     EXISTING kind revision_published_over_checkout (no new kind;
--     notification_kinds() untouched) and a REVIEW_PROMOTED_OVER_CHECKOUT
--     audit row naming them (the action the app writes, details.via
--     'database'). Each write is its own sub-block: one that cannot be
--     written is a WARNING and the promote stands — never a refusal, door
--     (b) stays finishable. Both are written as the caller, exactly as the
--     app's own notice and record are (SECURITY INVOKER is kept: the publish
--     guard and the row-level policies still decide the promote as the
--     caller's own UPDATE): the notice passes the notification insert rails
--     (20261160 — the signed-in member is its actor, a declared kind, an
--     app-relative link; a recipient who is not an active member is
--     skipped), the record is the session's own row in its own org
--     (audit_logs_insert); the service role names p_actor;
--   * one DEFAULTed argument, p_report_over_checkout (false): asked, the
--     answer says whether a checkout was passed and which write landed —
--     'promoted_clear' (nobody else held it), or 'promoted_over_checkout'
--     followed by '_recorded' and / or '_told' — so the app skips the record
--     and the notice the database wrote and writes what it did not (no
--     double row, no dropped one). Not asked, the answer is exactly
--     'promoted' / 'no_match' as before (a direct caller, the app before
--     P35). The signature changes, which CREATE OR REPLACE cannot do: the
--     seven-argument form is dropped first, so the database ends with ONE
--     signature (PostgREST's call by name is never ambiguous); a call with
--     five or seven named arguments resolves to it unchanged. Nothing else
--     references the function (no view, trigger, policy or function).
-- Grants restated (DRLS-16 practice, though the function is SECURITY
-- INVOKER): search_path pinned; EXECUTE revoked from PUBLIC and anon, granted
-- to authenticated and service_role, as 20261151 left it.
--
-- NOT re-created, by design (DEC-90 ruling (3) for this package): the
-- publish guard. The hand-made three-step PATCH (promoteThreeStep's writes
-- sent by hand through PostgREST) is a direct pointer write the guard admits
-- as door (b); recording it there would re-create the 1000-line guard for a
-- remainder, and a trigger that writes rows can break a legitimate write.
-- It stays untold and unrecorded — the explicit remainder on DCK-18 with its
-- owner (document-control, at the next re-creation of
-- enforce_document_publish_guard). The app takes the three-step path only on
-- a database without finalize_reviewed_promote (before 20261151) and records
-- it itself, as since P33.
--
-- APP BEFORE AND AFTER THIS PASTE: the app carrying P35 calls with
-- p_report_over_checkout; before this paste PostgREST answers PGRST202 (no
-- such argument), the app re-calls exactly as before (five or seven named
-- arguments) and keeps P33's app-side notice and record — today's behaviour
-- exactly; a database without the function at all (before 20261151) answers
-- PGRST202 again and the app takes its three-step promote, as before. After
-- the paste, the database records and tells and the app writes only what the
-- answer says is missing. DEPLOY ORDER: deploy the app carrying P35 BEFORE or
-- WITH this paste. An app before P35 keeps working after the paste (its
-- calls answer 'promoted' as always) but writes its own notice and row too,
-- so a reviewed promote over a foreign checkout is recorded and told twice
-- until the deploy — over-recording, never under (fail-safe). The same double
-- can happen with the app carrying P35 in the moments right after this paste,
-- until PostgREST reloads its schema cache: a cache that still lists only the
-- seven-argument form answers PGRST202 to the call with
-- p_report_over_checkout, the app's plain re-call then reaches the new
-- function (which records and tells, and answers plain 'promoted'), and the
-- app writes its own notice and record as well. This file ends its
-- transaction with NOTIFY pgrst, 'reload schema' (delivered at COMMIT) to
-- shorten that window; until the reload lands, a promote over a checkout may
-- be recorded and told twice — again more, never fewer.
--
-- DCK-18 done-when 3 — the door-shaped submissions pending at 20261247's
-- paste (its inventory row 2, informational). A door-shaped in-review row a
-- signed-in session wrote BEFORE 20261247 ('external', a link, no creator or
-- the link's id) cannot be told from the contractor door's genuine
-- submission by its columns, and door (b) can still promote it over a
-- checkout until it is decided. This file changes no row. Rows 3-5 of the
-- result set count them (counts only); to see WHICH, run the two read-only
-- queries below yourself in the SQL editor (they read, never write; run them
-- any time, before or after this paste). A pending submission the intake
-- route recorded — its INTAKE_SUBMISSION audit row, written by the server
-- with no person named (user_id NULL, which a signed-in session cannot write
-- since 20260813's audit_logs_insert), names the version — came through the
-- route. Of the others, the ones on a project's Intake tab are the ones to
-- look over (the tab lists only DOCUMENT links — purpose 'documents' — so a
-- submission filed against a quote link, a link that no longer exists, or no
-- link at all is NOT listed there; query 3 lists those separately).
--
--   1. How many:
--      WITH s AS (
--        SELECT d.id AS document_id, v.id AS version_id,
--               EXISTS (SELECT 1 FROM audit_logs a
--                        WHERE a.resource_type = 'document' AND a.resource_id = d.id::text
--                          AND a.action = 'INTAKE_SUBMISSION' AND a.user_id IS NULL
--                          AND a.details->>'versionId' = v.id::text) AS route_recorded,
--               EXISTS (SELECT 1 FROM project_intake_links l
--                        WHERE l.id = v.intake_link_id
--                          AND COALESCE(l.purpose, 'documents') = 'documents') AS on_intake_tab
--          FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
--         WHERE v.review_state = 'in_review' AND COALESCE(v.provenance, '') = 'external'
--           AND (v.created_by IS NULL OR v.created_by = v.intake_link_id))
--      SELECT COUNT(*) AS pending_external_submissions,
--             COUNT(*) FILTER (WHERE route_recorded) AS recorded_by_the_intake_route,
--             COUNT(*) FILTER (WHERE NOT route_recorded AND on_intake_tab) AS to_look_over,
--             COUNT(*) FILTER (WHERE NOT route_recorded AND NOT on_intake_tab) AS not_on_any_intake_tab
--        FROM s;
--
--   2. Which (the ones to look over — on a project's Intake tab), oldest first:
--      SELECT p.name AS project, l.company_name AS company, d.document_number, d.title,
--             v.revision_label, v.created_at AS submitted_at, d.checked_out_by_name AS checked_out_by,
--             d.id AS document_id, v.id AS version_id
--        FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
--        JOIN project_intake_links l ON l.id = v.intake_link_id
--         AND COALESCE(l.purpose, 'documents') = 'documents'
--        LEFT JOIN projects p ON p.id = l.project_id
--       WHERE v.review_state = 'in_review' AND COALESCE(v.provenance, '') = 'external'
--         AND (v.created_by IS NULL OR v.created_by = v.intake_link_id)
--         AND NOT EXISTS (SELECT 1 FROM audit_logs a
--                          WHERE a.resource_type = 'document' AND a.resource_id = d.id::text
--                            AND a.action = 'INTAKE_SUBMISSION' AND a.user_id IS NULL
--                            AND a.details->>'versionId' = v.id::text)
--       ORDER BY v.created_at;
--
--   3. Which are NOT on any Intake tab (a quote link, a link gone, no link):
--      SELECT l.purpose AS link_purpose, p.name AS project, l.company_name AS company,
--             d.document_number, d.title, v.revision_label, v.created_at AS submitted_at,
--             d.checked_out_by_name AS checked_out_by, d.id AS document_id, v.id AS version_id
--        FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
--        LEFT JOIN project_intake_links l ON l.id = v.intake_link_id
--        LEFT JOIN projects p ON p.id = l.project_id
--       WHERE v.review_state = 'in_review' AND COALESCE(v.provenance, '') = 'external'
--         AND (v.created_by IS NULL OR v.created_by = v.intake_link_id)
--         AND (l.id IS NULL OR COALESCE(l.purpose, 'documents') <> 'documents')
--         AND NOT EXISTS (SELECT 1 FROM audit_logs a
--                          WHERE a.resource_type = 'document' AND a.resource_id = d.id::text
--                            AND a.action = 'INTAKE_SUBMISSION' AND a.user_id IS NULL
--                            AND a.details->>'versionId' = v.id::text)
--       ORDER BY v.created_at;
--
--   Then, for each row of query 2: open the project's Intake tab (the
--   submission is listed under its pending submissions — the tab lists every
--   in-review revision filed through one of the project's DOCUMENT links,
--   purpose 'documents'; a quote link's submissions are not there).
--   CONFIRM it as the company's by approving it there (a reviewed promote:
--   recorded, and the holder told, by this file), or RETIRE it with Reject
--   (the existing action, components/projects/IntakePanel.tsx: in_review →
--   rejected with your reason, the pending pointer cleared, any sign-offs
--   voided, INTAKE_REJECTED recorded — no new write path; the reason is shown
--   on the link's submission portal). Expected on legitimate data: 0 to look
--   over. For a row of query 3 there is no TARGETED app action — no Intake tab
--   lists it, so neither approve nor Reject reaches it (the existing
--   void-pending-draft path, lib/revisions.ts voidPendingDraft, retires it only
--   as a side effect of a controller's rev-up, revert or archive of that
--   document); door (b)'s intake limb can
--   promote one over a checkout only while its link still exists in the org
--   and authored or was assigned the document (a quote link so set up by
--   hand); a row whose link is gone or absent is not admitted by that limb.
--   Do not edit those rows by hand: give the integrator their count (row 6)
--   and their document and version ids, and the integrator assigns their
--   retirement. Expected on legitimate data: 0. Tell the integrator the
--   counts (rows 3-6) and what you decided.
--
-- PASTE ORDER: AFTER 20261247 (required — the prerequisite below refuses,
-- changing nothing, without 20261247's column guard or 20261151's
-- finalize_reviewed_promote); 20261247 is paste guide row 191, HOLD behind
-- 20261245 (row 187), itself HOLD behind 20261193 (row 150), so this file
-- waits with them. ⚠ Never re-paste 20261151 after this one: it would put
-- back the seven-argument function beside this one (two signatures —
-- PostgREST's call by name becomes ambiguous) and drop the record.
-- Single paste: prerequisite check → temp-table inventory (counts only, 6
-- rows, all informational) → BEGIN/DDL/NOTIFY pgrst/COMMIT → one SELECT
-- (check text, ok boolean, n text): 6 probes (ok = true) + the 6 rows.
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the bases) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'finalize_reviewed_promote' AND pronargs IN (7, 8)) THEN
    RAISE EXCEPTION '20261252 needs 20261151 (finalize_reviewed_promote with p_force_hold) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_version_row_integrity') THEN
    RAISE EXCEPTION '20261252 needs 20261247 (the version row column guard) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- Counts only, never a row. Rows 3-6 are DCK-18 done-when 3's: the
-- door-shaped submissions pending now (20261247's row 2, recounted), split
-- by whether the intake route's own record names them and, of those it does
-- not, whether a project's Intake tab lists them (a DOCUMENT link — the tab
-- reads only purpose 'documents'); the header's queries 2 and 3 list them.
DROP TABLE IF EXISTS dc_round_g_252_before;
CREATE TEMP TABLE dc_round_g_252_before AS
WITH s AS (
  SELECT d.id,
         EXISTS (SELECT 1 FROM audit_logs a
                  WHERE a.resource_type = 'document' AND a.resource_id = d.id::text
                    AND a.action = 'INTAKE_SUBMISSION' AND a.user_id IS NULL
                    AND a.details->>'versionId' = v.id::text) AS route_recorded,
         EXISTS (SELECT 1 FROM project_intake_links l
                  WHERE l.id = v.intake_link_id
                    AND COALESCE(l.purpose, 'documents') = 'documents') AS on_intake_tab
    FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
   WHERE v.review_state = 'in_review' AND COALESCE(v.provenance, '') = 'external'
     AND (v.created_by IS NULL OR v.created_by = v.intake_link_id)
)
SELECT 'inventory (before apply): documents checked out right now whose pending draft is in review (informational — a reviewed promote of one by anyone but the holder is, from this paste on, recorded and the holder told in the promote''s own transaction)' AS inventory,
       COUNT(*)::text AS n
  FROM documents d JOIN document_versions v ON v.id = d.pending_version_id
 WHERE d.checked_out_by IS NOT NULL AND v.review_state = 'in_review'
UNION ALL
SELECT 'inventory (before apply): finalize_reviewed_promote signatures (expect 1 — the seven-argument form of 20261151, or this file''s eight-argument form on a re-paste)',
       COUNT(*)::text
  FROM pg_proc WHERE proname = 'finalize_reviewed_promote'
UNION ALL
SELECT 'inventory (before apply): documents whose pending pointer names an in-review external submission with no creator (or the link''s id as creator) — 20261247''s row 2, recounted; informational (DCK-18 done-when 3)',
       COUNT(*)::text
  FROM s
UNION ALL
SELECT 'inventory (before apply): of those, named by the intake route''s own record (an INTAKE_SUBMISSION row written by the server with no person named — came through the route)',
       COUNT(*)::text
  FROM s WHERE route_recorded
UNION ALL
SELECT 'inventory (before apply): of those, with no such record and listed on a project''s Intake tab — look these over: the header''s query 2 lists them; confirm each from its project''s Intake tab (approve) or retire it there (Reject); expected 0 on legitimate data',
       COUNT(*)::text
  FROM s WHERE NOT route_recorded AND on_intake_tab
UNION ALL
SELECT 'inventory (before apply): of those, with no route record and NOT listed on any project''s Intake tab (a quote link, a link gone, or no link — no app action reaches them): the header''s query 3 lists them; do not edit them by hand — give the integrator this count and their ids; expected 0 on legitimate data',
       COUNT(*)::text
  FROM s WHERE NOT route_recorded AND NOT on_intake_tab;

BEGIN;

-- ── DCK-18: finalize_reviewed_promote — 20261151 body + the record ──────────
-- 20261151's body (the newest, found by scanning) + the over-checkout record
-- and notice (own sub-blocks, never a refusal) + p_report_over_checkout. The
-- seven-argument form is dropped first (one signature at the end); the
-- five-argument drop is 20261151's own, kept.
DROP FUNCTION IF EXISTS finalize_reviewed_promote(uuid, uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text);
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

-- PostgREST reloads its schema cache when this transaction commits (a NOTIFY
-- is delivered only at COMMIT, never on a rollback), so the window in which a
-- stale cache sends the app's call down its plain re-call — a promote over a
-- checkout recorded and told twice — is as short as the reload. No result set.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 6. Inventory rows (6): n = the aggregate count.
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here).
SELECT 'DCK-18 (P35): finalize_reviewed_promote has ONE signature — the eight-argument form — SECURITY INVOKER with search_path pinned' AS check,
       (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'finalize_reviewed_promote')
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'finalize_reviewed_promote' AND p.pronargs = 8
                      AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'DCK-18 (P35): authenticated and service_role may execute it; anon and PUBLIC may not',
       has_function_privilege('authenticated', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean)', 'EXECUTE')
       AND has_function_privilege('service_role', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean)', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
                        WHERE p.proname = 'finalize_reviewed_promote' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'RG-12 / REV-20 survive the re-create: the compare-and-set promote, the controller''s recorded force past a hold, the bookkeeping that rolls the promote back, and the plain answer ''promoted''',
       (SELECT prosrc LIKE '%IF p_force_hold THEN%v_hold_forced := TRUE;%PERFORM set_config(''app.publish_hold_override'', p_document_id::text, true);%SET current_version_id = p_pending_id,%AND current_version_id IS NOT DISTINCT FROM p_expected_current;%RETURN ''no_match'';%SET review_state = ''approved'',%UPDATE document_versions SET superseded_at = v_now WHERE id = p_expected_current;%''REV_HOLD_OVERRIDDEN''%RETURN ''promoted'';%'
          FROM pg_proc WHERE proname = 'finalize_reviewed_promote'),
       NULL
UNION ALL
SELECT 'DCK-18 (P35): over a checkout held by anyone but the actor, the holder''s notice (the existing kind revision_published_over_checkout) and a REVIEW_PROMOTED_OVER_CHECKOUT row (via database) are written in the promote''s transaction, each in its own sub-block (a WARNING, never a refusal)',
       (SELECT prosrc LIKE '%IF v_holder IS NOT NULL AND v_holder IS DISTINCT FROM COALESCE(auth.uid(), p_actor)::text THEN%INSERT INTO notifications%''revision_published_over_checkout''%EXCEPTION WHEN OTHERS THEN%RAISE WARNING%INSERT INTO audit_logs%''REVIEW_PROMOTED_OVER_CHECKOUT''%''via'', ''database''%EXCEPTION WHEN OTHERS THEN%RAISE WARNING%'
          FROM pg_proc WHERE proname = 'finalize_reviewed_promote'),
       NULL
UNION ALL
SELECT 'DCK-18 (P35): the report is given only when asked (p_report_over_checkout) — otherwise the answer is ''promoted'' / ''no_match'' exactly as before',
       (SELECT prosrc LIKE '%IF p_report_over_checkout THEN%''promoted_clear''%''promoted_over_checkout''%''_recorded''%''_told''%END IF;%RETURN ''promoted'';%'
          FROM pg_proc WHERE proname = 'finalize_reviewed_promote'),
       NULL
UNION ALL
SELECT 'the holder''s notice is of a declared kind (notification_kinds() lists revision_published_over_checkout, untouched here — or the registry is absent and the rail with it)',
       COALESCE((SELECT bool_or(prosrc LIKE '%(''revision_published_over_checkout'',%') FROM pg_proc WHERE proname = 'notification_kinds'), true),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_g_252_before;
