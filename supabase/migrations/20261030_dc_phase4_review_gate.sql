-- Document-control Phase 4 — the review gate can no longer be forged.
--
-- Two CRITICALs (RG-1, RG-2). The review gate is the product's central safety
-- claim, and both its write paths accepted forgeries:
--
--   · RG-1 — doc_review_signoff_insert checked org membership ONLY, so any
--     active member could INSERT a roster row born `status='signed'` (slot
--     'alternate', their own uid) and both completion counts — the DB publish
--     guard and the app — counted it. One INSERT made an unreviewed draft
--     publishable, and the auto-finalize promoted it on the next genuine
--     signature.
--   · RG-2 — the 20260830 UPDATE policy grants publishers/owners UPDATE on
--     EVERY roster row with a WITH CHECK of membership only, and nothing bound
--     "status='signed'" to the row's own reviewer or to a real e-signature —
--     so the publisher the gate exists to constrain could mark the Piping
--     Lead's row signed, and the roster rendered it as the Lead's approval.
--
-- Three rails, at the layers that cannot be bypassed:
--   1. INSERT may not create approval: WITH CHECK requires status='pending'
--      with no signature. (Roster creation — openReviewRoster — inserts
--      exactly that shape; service-role restore bypasses RLS and is unaffected.)
--   2. A BEFORE UPDATE trigger makes the row's identity immutable and allows
--      the transition TO 'signed' only by the row's own reviewer, carrying
--      their OWN e-signature bound to this draft. Publishers keep their
--      legitimate bulk work (→ 'invalidated' / 'void'), the daily scan keeps
--      its notified_at touches, alternate activation keeps flipping
--      `activated` — none of those touch the guarded transition.
--   3. The publish guard counts a sign-off only when it carries a bound
--      e-signature signed by the row's own reviewer for that same draft —
--      so a row that somehow reads 'signed' without a real signature can
--      never satisfy the gate.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

-- Defensive re-drop (Phase 3): if 20260819's policy loop is ever replayed it
-- would re-create these permissive FOR ALL policies and re-open the
-- OR-together bypass. Re-dropping here makes the ordering harmless.
DROP POLICY IF EXISTS document_acknowledgments_member_all ON document_acknowledgments;
DROP POLICY IF EXISTS document_review_signoffs_member_all ON document_review_signoffs;

-- ── Rail 1 (RG-1): roster creation may not create approval ──────────────────
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
);

-- ── Rail 2 (RG-2): signing is the reviewer's own act, with their signature ──
CREATE OR REPLACE FUNCTION enforce_review_signoff_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service-role / cron / restore writes carry no JWT and are trusted.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  -- The row's identity is immutable — repointing an approval at a different
  -- reviewer, slot, draft or document is never a legitimate edit.
  IF NEW.reviewer_user_id     IS DISTINCT FROM OLD.reviewer_user_id
     OR NEW.slot               IS DISTINCT FROM OLD.slot
     OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
     OR NEW.document_id        IS DISTINCT FROM OLD.document_id
     OR NEW.org_id             IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'Review sign-off rows are immutable in identity — void it and open a new roster instead.'
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

DROP TRIGGER IF EXISTS trg_review_signoff_guard ON document_review_signoffs;
CREATE TRIGGER trg_review_signoff_guard
BEFORE UPDATE ON document_review_signoffs
FOR EACH ROW EXECUTE FUNCTION enforce_review_signoff_guard();

-- ── Rail 3 (RG-1): completion counts only signature-backed sign-offs ────────
-- The 20260822 guard body, with ONE change: the signed count requires a bound
-- e-signature from the row's own reviewer for this draft. Everything else —
-- the service-role bypass, the advancing predicate, the authority branch, the
-- hold check — is byte-identical to the live definition. search_path is
-- restated because CREATE OR REPLACE would otherwise drop the 20261020 pin.
CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor        uuid    := auth.uid();   -- NULL for service-role / SQL console
  v_role         text;
  v_advancing    boolean;
  v_can_publish  boolean;
  v_has_hold     boolean;
  v_primary_reqs integer;
  v_signed       integer;
BEGIN
  IF v_actor IS NULL THEN
    RETURN NEW;
  END IF;

  v_advancing :=
       (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)
    OR (NEW.status = 'Superseded' AND COALESCE(OLD.status, '') <> 'Superseded');
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
    SELECT count(*) FILTER (WHERE s.slot = 'primary'),
           count(*) FILTER (WHERE s.status = 'signed'
                              AND s.signature_id IS NOT NULL
                              AND EXISTS (
                                SELECT 1 FROM e_signatures e
                                WHERE e.id = s.signature_id
                                  AND e.signer_user_id = s.reviewer_user_id
                                  AND e.org_id = s.org_id
                                  AND (e.document_version_id = s.document_version_id
                                       OR e.document_version_id IS NULL)
                              ))
      INTO v_primary_reqs, v_signed
      FROM document_review_signoffs s
     WHERE s.document_version_id = NEW.current_version_id;
    IF COALESCE(v_primary_reqs, 0) > 0 AND COALESCE(v_signed, 0) < v_primary_reqs THEN
      RAISE EXCEPTION
        'This revision still has outstanding review sign-offs; complete the review before publishing.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT role INTO v_role
    FROM org_members
   WHERE org_id = NEW.org_id AND uid::text = v_actor::text AND status = 'active'
   LIMIT 1;
  IF v_role IN ('Admin', 'DocCtrl') THEN
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

-- ── Verification (read-only) ────────────────────────────────────────────────
-- (a) RECONCILIATION + the Phase-3 leftover check, folded in as promised:
--     every 'signed' roster row must carry a matching e-signature by its own
--     reviewer, and no *_member_all policy may remain on the hardened tables.
--     EXPECT ZERO ROWS from this query:
SELECT 'unbacked signed sign-off' AS problem, s.id::text AS detail
FROM document_review_signoffs s
WHERE s.status = 'signed'
  AND NOT EXISTS (
    SELECT 1 FROM e_signatures e
    WHERE e.id = s.signature_id
      AND e.signer_user_id = s.reviewer_user_id
      AND e.org_id = s.org_id
      AND (e.document_version_id = s.document_version_id
           OR e.document_version_id IS NULL)
  )
UNION ALL
SELECT 'leftover member_all policy', tablename || '.' || policyname
FROM pg_policies
WHERE tablename IN ('document_acknowledgments', 'document_review_signoffs')
  AND policyname LIKE '%member_all%';

-- (b) The rails are installed — EXPECT true / true / true:
SELECT 'insert policy requires pending+unsigned' AS check,
       (SELECT with_check LIKE '%pending%' AND with_check LIKE '%signature_id IS NULL%'
          FROM pg_policies
         WHERE tablename = 'document_review_signoffs' AND policyname = 'doc_review_signoff_insert') AS ok
UNION ALL
SELECT 'signing guard installed',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_review_signoff_guard' AND NOT tgisinternal)
UNION ALL
SELECT 'publish guard requires bound signatures',
       (SELECT pg_get_functiondef(oid) LIKE '%e.signer_user_id = s.reviewer_user_id%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard');
