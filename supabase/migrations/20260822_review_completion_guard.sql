-- 20260822_review_completion_guard.sql
--
-- Hardening for review-before-publish (20260818): enforce review COMPLETION at
-- the database, not just in the app. A revision that went through pre-publish
-- review cannot become the controlled copy (current_version_id) until every
-- required sign-off is in. Today lib/reviewControl.finalizeReviewedRevision
-- checks this before promoting; this guard makes a direct/buggy write unable to
-- bypass it.
--
-- Recreates enforce_document_publish_guard() = the 20260816 definition PLUS the
-- completion check, placed before the role short-circuit so it applies to
-- everyone (it's a data-integrity gate, not an authority one). It only bites when
-- the version being published actually carries a reviewer roster, so normal
-- direct publishes (no roster) and brand-new documents are unaffected.
--
-- Completion mirrors the app: signed sign-offs (any slot — a primary OR an
-- activated alternate) must reach the number of PRIMARY reviewers.
--
-- Idempotent (CREATE OR REPLACE). Dated after 20260821.

CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
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
  -- off must be in. Only bites for review-flow revisions.
  IF NEW.current_version_id IS NOT NULL
     AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    SELECT count(*) FILTER (WHERE slot = 'primary'),
           count(*) FILTER (WHERE status = 'signed')
      INTO v_primary_reqs, v_signed
      FROM document_review_signoffs
     WHERE document_version_id = NEW.current_version_id;
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

DROP TRIGGER IF EXISTS trg_document_publish_guard ON documents;
CREATE TRIGGER trg_document_publish_guard
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_document_publish_guard();
