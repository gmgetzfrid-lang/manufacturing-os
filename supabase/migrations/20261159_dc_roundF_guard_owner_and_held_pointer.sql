-- ─────────────────────────────────────────────────────────────────────────────
-- 20261159_dc_roundF_guard_owner_and_held_pointer.sql
--
-- document-control Round F wave 3 — P17 GUARD & EDITOR FOLLOW-UPS: the
-- controller hold pass REV-20 left open (REV-22), and the owner-must-approve
-- rule at the database's review completion gate (RG-14).
--
--   REV-22  After 20261151 a controller passes an active hold only through a
--           recorded force (publish_revision's, or the review promote's —
--           finalize_reviewed_promote's p_force_hold — each setting the
--           transaction-local flag app.publish_hold_override around its own
--           promote and recording REV_HOLD_OVERRIDDEN) when ONE write moves
--           the pointer AND makes the status an issue. Two controller writes
--           still passed a hold unrecorded:
--           (1) a bare pointer move on a held document ALREADY in an issue
--               status (Issued, IFC, a library's own) with a current
--               revision — a direct PATCH of current_version_id, or the
--               review promote of a held Issued document. Now judged by the
--               SAME recorded-force rule: without the flag naming the
--               document it is refused over an active hold, in REV-20 (b)'s
--               sentence ("…release the hold before issuing it, or publish
--               over it with Document Control's recorded override."), which
--               the inspector recognises — it then offers Document Control
--               the review promote's recorded force (P14). DECIDED here: the
--               review promote of a held Issued document takes its recorded
--               force, as a held Draft's does since 20261151. The intake
--               approve (components/projects/IntakePanel.tsx) offers no force
--               yet, so this takes away a flow that works today — a
--               controller's intake approve of a submission revising a held
--               Issued document (the only way through: release the hold,
--               approve, re-place it by hand) — until the integrator's J10b
--               follow-up gives it the force; hence the PASTE PRECONDITION
--               below (or the user's ratification of the interim loss,
--               recorded on DEC-63's P17 line). A first pointer write (no
--               current revision) is a creation's (REV-17) and is not this;
--           (2) the un-supersede of a Superseded document carrying NO
--               retirement stamp (superseded before 20261144, or by the
--               service role) into an issue status. KEPT SPARED, as
--               20261151 spared it: that exit is how the legacy reversal
--               (lib/documentLifecycle/reverse.ts reverseSplit /
--               reverseMerge → restoreStatus) puts a source back over the
--               hold HLD-2 carries onto it first, and the put-back is a bare
--               PostgREST UPDATE that cannot carry a transaction-local flag —
--               binding it by the flag rule refuses the reversal at the
--               restore and the saga rolls it back (P14's review blocker,
--               shown on PostgreSQL 16 against 20261151's first version).
--               It stays open (REV-22) until that put-back has a recorded
--               door the guard honours; the inventory counts the spared
--               documents under a hold now.
--           (1) binds a controller only: below a controller nothing changes
--           (the publisher tier's own hold check, the guard's last, still
--           refuses every pointer move over a hold in its own words).
--
--   RG-14   GAP-4 (P14) rosters the effective owner as a REQUIRED primary in
--           a slot of their own ('owner:<uid>') when the effective review
--           policy sets ownerMustApprove — in the app (openReviewRoster →
--           placeOwnerSlot). The database counted the owner's row once it
--           existed but could not tell a roster that should carry it from
--           one that should not, so a roster opened through PostgREST
--           without the owner completed without them. Now (DEC-44 (P17),
--           provisional number — the roster carries the rule it was opened
--           under):
--           * document_review_signoffs.opened_owner_slot (new, nullable): the
--             rule the roster was opened under — 'owner:<uid>' (the policy
--             set ownerMustApprove; the effective owner must approve),
--             'none' (it did not), 'no_owner' (it did; no active owner
--             resolved), 'author' (it did; the owner authored the revision
--             and DEC-21 skips an author where the library requires an
--             independent reviewer) — exactly placeOwnerSlot's outcomes.
--             NULL: opened before this paste (never retrofitted — GAP-4's
--             "Reviews already in progress keep the roster they opened
--             with") or written unstamped by the service role.
--           * trg_review_signoff_owner_stamp (new, BEFORE INSERT OR UPDATE):
--             a signed-in INSERT is stamped — whatever the caller sent is
--             overwritten. The roster's FIRST row takes the policy and owner
--             read AT THAT MOMENT for the draft's own document (the version's
--             record, not the row's claimed document_id); 'author' only when
--             the owner is the person OPENING the roster and the version
--             names no other author (created_by NULL — an external
--             submission — or the opener): created_by is writable by a
--             library publisher through PostgREST, so it never makes the
--             owner the author of a roster someone else opens (P17 review
--             fix). Every roster the app opens is one of these
--             (submitForReview opens as the version's creator; the intake
--             approve, an external submission's). A row added to a roster
--             already open takes that roster's stamp (NULL for one opened
--             before this paste), so a policy or owner change mid-review
--             never reaches it. A signed-in UPDATE keeps the stamp. The
--             service role is trusted, as the sign-off guard trusts it (a
--             restore replays the stamp it exported).
--           * review_control_owner_must_approve_for (new): the effective
--             ownerMustApprove along the container chain — the twin of
--             review_control_mode_for (20261070), the nearest DEFINED level
--             deciding, true only for JSON true (the app's === true).
--           * the review completion gate (the per-slot count in
--             enforce_document_publish_guard) refuses a pointer move onto a
--             revision whose roster is stamped 'owner:<uid>' unless that slot
--             group is filled by THAT owner's own bound signature.
--           The effective owner is the candidate (the document's, its
--           folder's, its library's owner, the owning team's supervisor)
--           user_is_effective_owner names — the one SQL chain (OWN-16,
--           inactive members skipped, GAP-5), the chain the app's
--           readOwnerForApproval resolves through resolveEffectiveOwner.
--
--   RE-CREATED FROM THE NEWEST BODY (found by scanning; lineDiff-pinned —
--   every line of the base is kept, the lines added are exactly the P17
--   blocks): enforce_document_publish_guard from 20261151 (P14), REV-20's
--   rules (the unstamped Archived / Void exit, the pointer-and-issue force,
--   publish_revision's and finalize_reviewed_promote's flag) and 20261144's
--   all kept. Nothing else is re-created: review_control_owner_must_approve_for,
--   review_signoff_owner_stamp and its trigger are new. Grants (DRLS-16): the
--   guard and the stamp are trigger functions executable by no client role;
--   the policy helper is called only by the stamp (as its owner) and is
--   executable by no client role either.
--
-- NOT a widening: every change refuses something that was allowed (a
-- controller's unforced pointer move over a hold on an issued document; the
-- publish of a roster opened under an owner-must-approve policy without the
-- owner's signature). DEC-30 inventories (aggregate counts only, captured
-- BEFORE the transaction): the issued documents with a current revision under
-- an active hold, and those of them with a review draft pending (a
-- controller's promote of these now needs the inspector's recorded force, or
-- the hold released); the unstamped Superseded documents under a hold now
-- (unchanged — REV-22's open half); the drafts in review whose effective
-- policy sets ownerMustApprove, and those of them with no owner slot row
-- (unstamped: they complete as before); the roster rows on drafts in review;
-- whether the stamp column existed.
-- HOW TO APPLY: after 20261151 (required — it re-creates 20261151's guard,
-- and the first statement refuses to run, changing nothing, without it; so
-- after 20261144 and 20261130 too) and after 20261070. ⚠ Never re-paste
-- 20261151, 20261144, 20261139, 20261105 or any earlier guard migration after
-- this one: each would drop the REV-22 and RG-14 rules (and an earlier one
-- the REV-20 rules). Independent of 20261131, 20261143, 20261149, 20261150
-- and 20261152. P16 (REV-21) re-creates this guard next, from this body.
-- ⚠ PASTE PRECONDITION (REV-22, P17 review fix): paste this only once the app
-- deployed offers the intake approve's recorded force (IntakePanel calling
-- finalizeReviewedRevision with forceHold for Document Control on the hold
-- refusal, as the inspector does — the integrator's J10b follow-up), OR once
-- the user has ratified the interim loss (DEC-63's P17 Landed line, awaiting
-- ratification). Until then a controller's intake approve of a submission
-- revising a held Issued document is refused with no way through but
-- releasing the hold. Deploy otherwise: the app carrying P14 offers the
-- review promote's recorded force in the inspector when the hold refuses it,
-- and openReviewRoster already writes the owner's slot.
-- Single paste: prerequisite check → temp-table inventory →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the bases) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_document_publish_guard'
                  AND prosrc LIKE '%v_unforced_issue := COALESCE(v_issuing%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'finalize_reviewed_promote' AND pronargs = 7) THEN
    RAISE EXCEPTION '20261159 needs 20261151 (the REV-20 publish guard and the review promote''s recorded force) pasted first; nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'document_review_signoffs' AND column_name = 'slot_group') THEN
    RAISE EXCEPTION '20261159 needs 20261070 (the review gate''s slot groups) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_159_before;
CREATE TEMP TABLE dc_round_f_159_before AS
WITH in_review AS (
  -- drafts in review, with their effective review policy object (the
  -- nearest DEFINED level: document → folder → ancestors → library)
  SELECT d.pending_version_id,
         COALESCE(
           CASE WHEN jsonb_typeof(d.review_control) = 'object' THEN d.review_control END,
           (SELECT c.review_control FROM collections c
             WHERE c.id = d.collection_id AND jsonb_typeof(c.review_control) = 'object'),
           (SELECT a.review_control
              FROM collections c
              CROSS JOIN LATERAL unnest(c.path_ids) WITH ORDINALITY AS p(id, ord)
              JOIN collections a ON a.id = p.id
             WHERE c.id = d.collection_id AND jsonb_typeof(a.review_control) = 'object'
             ORDER BY p.ord DESC
             LIMIT 1),
           (SELECT l.review_control FROM libraries l
             WHERE l.id = d.library_id AND jsonb_typeof(l.review_control) = 'object')
         ) AS policy
    FROM documents d
   WHERE d.pending_version_id IS NOT NULL
)
SELECT 'inventory (before apply): documents in an issue status with a current revision and an active hold (REV-22: Document Control''s pointer move on these — a direct PATCH, or the review promote — now passes the hold only with a recorded force: publish_revision''s, or the review promote''s offered in the inspector)' AS inventory,
       COUNT(*)::text AS n
  FROM documents d
 WHERE d.current_version_id IS NOT NULL
   AND is_controlled_issue_status(d.status)
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
UNION ALL
SELECT 'inventory (before apply): of those, with a review draft pending (a controller''s promote of it is refused until forced from the inspector — recorded — or the hold is released; the intake approve offers no force)',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL
   AND d.pending_version_id IS NOT NULL
   AND is_controlled_issue_status(d.status)
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
UNION ALL
SELECT 'inventory (before apply): documents in Superseded with no retirement stamp and a current revision, under an active hold now (UNCHANGED by this paste — REV-22''s open half: the legacy reversal''s put-back over a carried hold stays spared for Document Control, unrecorded)',
       COUNT(*)::text
  FROM documents d
 WHERE d.current_version_id IS NOT NULL
   AND d.status = 'Superseded'
   AND d.retired_issue_status IS NULL
   AND EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = d.id AND h.released_at IS NULL)
UNION ALL
SELECT 'inventory (before apply): drafts in review whose effective review policy sets ownerMustApprove (RG-14: a roster already open on one was opened before this paste — unstamped, never retrofitted, it completes as before; a roster opened on one after the paste carries the rule)',
       COUNT(*)::text
  FROM in_review r
 WHERE r.policy->'ownerMustApprove' = 'true'::jsonb
UNION ALL
SELECT 'inventory (before apply): of those, whose roster has no owner slot row (slot_group owner:<uid>) — they complete on the per-slot count as before (counted, not repaired)',
       COUNT(*)::text
  FROM in_review r
 WHERE r.policy->'ownerMustApprove' = 'true'::jsonb
   AND NOT EXISTS (SELECT 1 FROM document_review_signoffs s
                    WHERE s.document_version_id = r.pending_version_id
                      AND left(COALESCE(s.slot_group, ''), 6) = 'owner:')
UNION ALL
SELECT 'inventory (before apply): roster rows on drafts in review (each stays unstamped — opened_owner_slot NULL — and a row added to one of these rosters takes NULL too, so no roster opened before this paste is retrofitted)',
       COUNT(*)::text
  FROM document_review_signoffs s
  JOIN in_review r ON r.pending_version_id = s.document_version_id
UNION ALL
SELECT 'inventory (before apply): document_review_signoffs.opened_owner_slot already existed (1) or is added by this paste (0)',
       COUNT(*)::text
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'document_review_signoffs' AND column_name = 'opened_owner_slot';

BEGIN;

-- ── 1. RG-14: the opened-under stamp column ─────────────────────────────────
ALTER TABLE document_review_signoffs ADD COLUMN IF NOT EXISTS opened_owner_slot TEXT;
COMMENT ON COLUMN document_review_signoffs.opened_owner_slot IS
  'RG-14: the owner-must-approve rule this roster was opened under, stamped by trg_review_signoff_owner_stamp on a signed-in INSERT (a row added to an open roster takes its stamp) and never changed by a signed-in UPDATE: owner:<uid> (the effective owner''s slot must be filled by their own bound signature before the draft publishes), none (the policy did not require the owner), no_owner (it did; no active owner resolved), author (it did; the owner authored the revision and DEC-21 skips an author). NULL = opened before 20261159, or written unstamped by the service role: never retrofitted.';

-- ── 2. RG-14: the effective ownerMustApprove along the container chain ─────
-- The twin of review_control_mode_for (20261070 — the SQL twin of
-- lib/containerChain.ts): document → folder → its ancestors nearest first →
-- library; the nearest DEFINED level (a stored policy object) decides, as
-- lib/reviewControl.ts resolveReviewControlChain does, and the rule holds
-- only when that object's ownerMustApprove is JSON true (the app's
-- `ownerMustApprove === true`). SECURITY INVOKER, as its twin: called from
-- the SECURITY DEFINER stamp below, it reads as the stamp's owner.
CREATE OR REPLACE FUNCTION review_control_owner_must_approve_for(p_doc_control jsonb, p_collection_id uuid, p_library_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    CASE WHEN jsonb_typeof(p_doc_control) = 'object' THEN COALESCE(p_doc_control->'ownerMustApprove' = 'true'::jsonb, false) END,
    (SELECT COALESCE(c.review_control->'ownerMustApprove' = 'true'::jsonb, false)
       FROM collections c
      WHERE c.id = p_collection_id AND jsonb_typeof(c.review_control) = 'object'),
    (SELECT COALESCE(a.review_control->'ownerMustApprove' = 'true'::jsonb, false)
       FROM collections c
       CROSS JOIN LATERAL unnest(c.path_ids) WITH ORDINALITY AS p(id, ord)
       JOIN collections a ON a.id = p.id
      WHERE c.id = p_collection_id AND jsonb_typeof(a.review_control) = 'object'
      ORDER BY p.ord DESC
      LIMIT 1),
    (SELECT COALESCE(l.review_control->'ownerMustApprove' = 'true'::jsonb, false)
       FROM libraries l
      WHERE l.id = p_library_id AND jsonb_typeof(l.review_control) = 'object'),
    false);
$$;
-- Called only by the stamp (as its owner): no client role needs it (DRLS-16).
REVOKE ALL ON FUNCTION review_control_owner_must_approve_for(jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. RG-14: the stamp, on every roster row as it is inserted ──────────────
CREATE OR REPLACE FUNCTION review_signoff_owner_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_open        boolean;
  v_inherited   text;
  v_doc_id      uuid;
  v_created_by  uuid;
  v_found       boolean;
  v_doc_owner   uuid;
  v_collection  uuid;
  v_library     uuid;
  v_control     jsonb;
  v_owner       uuid;
  v_independent boolean;
BEGIN
  -- Service-role / cron / restore writes carry no JWT and are trusted, as
  -- the sign-off guard trusts them: a restore replays the stamp it exported.
  -- (RLS gives anon no roster row to insert or update.)
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  -- A signed-in UPDATE never changes it: a roster keeps the rule it was
  -- opened under (GAP-4: reviews already in progress keep their roster).
  IF TG_OP = 'UPDATE' THEN
    NEW.opened_owner_slot := OLD.opened_owner_slot;
    RETURN NEW;
  END IF;
  -- A signed-in INSERT: whatever the caller sent is overwritten. A row added
  -- to a roster that is already open takes the rule that roster was opened
  -- under — its rows' stamp (an owner rule over any other when they differ),
  -- or NULL when they carry none (a roster opened before 20261159 is never
  -- retrofitted) — so a policy or owner change mid-review never reaches it.
  SELECT count(*) > 0, max(s.opened_owner_slot) INTO v_open, v_inherited
    FROM document_review_signoffs s
   WHERE s.document_version_id = NEW.document_version_id;
  IF v_open THEN
    NEW.opened_owner_slot := v_inherited;
    RETURN NEW;
  END IF;
  -- The roster's first row: the rule read NOW for the DRAFT's own document
  -- (the version's record, not the row's claimed document_id), and the
  -- author the version records, kept raw for the author rule below.
  SELECT v.record_id, v.created_by INTO v_doc_id, v_created_by
    FROM document_versions v WHERE v.id = NEW.document_version_id;
  SELECT true, d.owner_user_id, d.collection_id, d.library_id, d.review_control
    INTO v_found, v_doc_owner, v_collection, v_library, v_control
    FROM documents d WHERE d.id = COALESCE(v_doc_id, NEW.document_id);
  IF v_found IS NULL
     OR NOT review_control_owner_must_approve_for(v_control, v_collection, v_library) THEN
    NEW.opened_owner_slot := 'none';
    RETURN NEW;
  END IF;
  -- The effective owner: the candidate the one SQL chain names
  -- (user_is_effective_owner — document → folder → library → the owning
  -- team's supervisor, an inactive member skipped: OWN-16 / GAP-5).
  SELECT c.uid INTO v_owner
    FROM (VALUES (1, v_doc_owner),
                 (2, (SELECT col.owner_user_id FROM collections col WHERE col.id = v_collection)),
                 (3, (SELECT l.owner_user_id FROM libraries l WHERE l.id = v_library)),
                 (4, (SELECT t.supervisor_user_id FROM libraries l JOIN teams t ON t.id = l.owner_team_id
                       WHERE l.id = v_library))) AS c(ord, uid)
   WHERE c.uid IS NOT NULL
     AND user_is_effective_owner(v_doc_owner, v_collection, v_library, c.uid)
   ORDER BY c.ord
   LIMIT 1;
  IF v_owner IS NULL THEN
    NEW.opened_owner_slot := 'no_owner';
    RETURN NEW;
  END IF;
  -- DEC-21: an owner who authored the revision is skipped where the library
  -- requires an independent reviewer — anything but
  -- requireIndependentReviewer = false (lib/reviewControl.ts). The author
  -- exception holds only when the owner is the person OPENING the roster
  -- and the version names no other author (P17 review fix): created_by is a
  -- column a library publisher can write through PostgREST (20261037's
  -- version policies admit any value for a publisher; no trigger keeps it),
  -- so an author read from it alone let a publisher who is not the owner
  -- name the owner as author and open a roster without them. Every roster
  -- the app opens is one of these: submitForReview opens it as the
  -- version's creator, and the intake approve opens an external
  -- submission's (no created_by — openReviewRoster's author is then its
  -- actor). A version naming the owner as author on a roster someone else
  -- opens is stamped owner:<uid>: the owner approves it.
  SELECT NOT COALESCE(l.review_control->'requireIndependentReviewer' = 'false'::jsonb, false)
    INTO v_independent
    FROM libraries l WHERE l.id = v_library;
  IF COALESCE(v_independent, true)
     AND v_owner = auth.uid()
     AND (v_created_by IS NULL OR v_created_by = auth.uid()) THEN
    NEW.opened_owner_slot := 'author';
    RETURN NEW;
  END IF;
  NEW.opened_owner_slot := 'owner:' || v_owner::text;
  RETURN NEW;
END;
$$;
-- A trigger function is never called by a client (DRLS-16).
REVOKE ALL ON FUNCTION review_signoff_owner_stamp() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_review_signoff_owner_stamp ON document_review_signoffs;
CREATE TRIGGER trg_review_signoff_owner_stamp
  BEFORE INSERT OR UPDATE ON document_review_signoffs
  FOR EACH ROW EXECUTE FUNCTION review_signoff_owner_stamp();

-- ── 4. REV-22 + RG-14: the publish guard — 20261151 body + the P17 blocks ──
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
-- Probes: ok = true × 8. Inventory rows: n = the aggregate count.
-- pg_proc.prosrc is verbatim (an apostrophe inside a body's string literal is
-- '''' here).
SELECT 'REV-22: a controller''s bare pointer move on a document already in an issue status is refused over an active hold unless the recorded-force flag names it (publish_revision''s or the review promote''s)' AS check,
       (SELECT prosrc LIKE '%v_unforced_move := COALESCE(OLD.current_version_id IS NOT NULL%'
           AND prosrc LIKE '%AND is_controlled_issue_status(OLD.status)%'
           AND prosrc LIKE '%AND is_controlled_issue_status(NEW.status)%'
           AND prosrc LIKE '%IF v_unforced_move AND EXISTS (%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'REV-20 survives the re-create (20261151: the unstamped Archived / Void exit is the new door for a controller, an unstamped Superseded one spared; a controller''s pointer-and-issue write needs the flag)',
       (SELECT prosrc LIKE '%v_new_door := v_new_door%'
           AND prosrc LIKE '%AND OLD.status IN (''Archived'', ''Void'')%'
           AND prosrc LIKE '%AND OLD.retired_issue_status IS NULL%'
           AND prosrc LIKE '%v_unforced_issue := COALESCE(v_issuing%'
           AND prosrc LIKE '%current_setting(''app.publish_hold_override'', true) IS DISTINCT FROM NEW.id%'
           AND prosrc LIKE '%IF v_unforced_issue AND EXISTS (%'
           AND prosrc LIKE '%or publish over it with Document Control''''s recorded override.%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL
UNION ALL
SELECT 'the 20261144 rules survive the re-create (the issue transition, the new door, the stamp, the require limb, the publisher tier, the hold)',
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
SELECT 'RG-14: the review completion gate refuses a roster stamped owner:<uid> unless that slot group is filled by that owner''s own bound signature (the per-slot count kept)',
       (SELECT prosrc LIKE '%count(*) FILTER (WHERE s.slot = ''primary'') AS reqs%'
           AND prosrc LIKE '%complete the review before publishing.%'
           AND prosrc LIKE '%AND s.slot_group = o.opened_owner_slot%'
           AND prosrc LIKE '%AND ''owner:'' || s.reviewer_user_id%'
           AND prosrc LIKE '%requires the document owner''''s approval, and the owner has not signed it%'
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
SELECT 'RG-14: the stamp column exists and trg_review_signoff_owner_stamp fires review_signoff_owner_stamp BEFORE INSERT OR UPDATE on every roster row; the stamp overwrites a signed-in INSERT''s value (a row added to an open roster takes its stamp; the author exception only for the owner opening the roster on a version naming no other author) and keeps it on a signed-in UPDATE',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'document_review_signoffs' AND column_name = 'opened_owner_slot')
       AND EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgname = 'trg_review_signoff_owner_stamp' AND NOT t.tgisinternal
                      AND t.tgrelid = 'document_review_signoffs'::regclass
                      AND pg_get_triggerdef(t.oid) LIKE 'CREATE TRIGGER trg_review_signoff_owner_stamp BEFORE INSERT OR UPDATE ON public.document_review_signoffs FOR EACH ROW%')
       AND (SELECT prosrc LIKE '%NEW.opened_owner_slot := OLD.opened_owner_slot;%'
               AND prosrc LIKE '%NEW.opened_owner_slot := v_inherited;%'
               AND prosrc LIKE '%SELECT v.record_id, v.created_by INTO v_doc_id, v_created_by%'
               AND prosrc LIKE '%AND v_owner = auth.uid()%'
               AND prosrc LIKE '%AND (v_created_by IS NULL OR v_created_by = auth.uid()) THEN%'
               AND prosrc LIKE '%user_is_effective_owner(v_doc_owner, v_collection, v_library, c.uid)%'
               AND prosrc LIKE '%NEW.opened_owner_slot := ''owner:'' || v_owner%'
              FROM pg_proc WHERE proname = 'review_signoff_owner_stamp'),
       NULL
UNION ALL
SELECT 'RG-14: the stamp is SECURITY DEFINER with search_path pinned and the policy helper''s search_path is pinned; no client role may execute either; the stamp''s owner may execute user_is_effective_owner and the helper',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'review_signoff_owner_stamp'
                AND prosecdef AND proconfig @> ARRAY['search_path=public'])
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'review_control_owner_must_approve_for'
                    AND NOT prosecdef AND proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'review_signoff_owner_stamp()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'review_signoff_owner_stamp()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'review_control_owner_must_approve_for(jsonb, uuid, uuid)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'review_control_owner_must_approve_for(jsonb, uuid, uuid)', 'EXECUTE')
       AND COALESCE(has_function_privilege((SELECT proowner FROM pg_proc WHERE proname = 'review_signoff_owner_stamp'),
                                           'user_is_effective_owner(uuid, uuid, uuid, uuid)', 'EXECUTE'), false)
       AND COALESCE(has_function_privilege((SELECT proowner FROM pg_proc WHERE proname = 'review_signoff_owner_stamp'),
                                           'review_control_owner_must_approve_for(jsonb, uuid, uuid)', 'EXECUTE'), false),
       NULL
UNION ALL
SELECT 'RG-14: review_control_owner_must_approve_for is true only for a policy object whose ownerMustApprove is JSON true (not a string, not absent, not no policy)',
       review_control_owner_must_approve_for('{"mode": "require", "ownerMustApprove": true}'::jsonb, NULL, NULL)
       AND NOT review_control_owner_must_approve_for('{"mode": "require"}'::jsonb, NULL, NULL)
       AND NOT review_control_owner_must_approve_for('{"mode": "require", "ownerMustApprove": "true"}'::jsonb, NULL, NULL)
       AND NOT review_control_owner_must_approve_for(NULL, NULL, NULL),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM dc_round_f_159_before;
