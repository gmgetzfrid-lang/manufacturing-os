-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — OWN-19: the lifecycle acts a granted
-- publisher may perform are the same at the Inspector, in the mutators and
-- at the database.
--
-- The authority model says PUBLISH authority (controller, per-library grant,
-- or the effective owner) covers rev-up, revert and supersede — and split /
-- merge reach the database as a supersede (the source row → 'Superseded'),
-- so enforce_document_publish_guard already admits a granted publisher to
-- all of them. Archive was the odd one out: no app-side check, and the
-- guard did not treat → 'Archived' as advancing, so any active member could
-- archive at the database while the Inspector hid the button from granted
-- publishers and showed it to owners. The Inspector now follows publish
-- authority for every lifecycle act (same commit); here the guard gains the
-- one disjunct that makes archiving take publish authority too — the body
-- is the live 20261046 one plus that disjunct (line-diffed by a shape test).
--
-- Note: for a non-controller the guard's existing hold check now also
-- applies to an archive (a held record cannot be retired past its hold);
-- controllers, and the service role (auth.uid() IS NULL — restores, cron),
-- pass exactly as before.
--
-- WIDENING at the surface (granted publishers gain supersede / archive /
-- split / merge affordances the mutators already allowed) and fail-closed at
-- the database (archive now needs the publisher tier). Pre-apply inventory
-- is captured into a temp table BEFORE the DDL (DEC-2).
--
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _rp_e60_before AS
SELECT 'libraries carrying any publish or admin allow grant (users/roles/teams/orgs) — publishers gaining lifecycle affordances' AS what, COUNT(*) AS n
  FROM libraries l
 WHERE EXISTS (SELECT 1 FROM jsonb_each(COALESCE(l.acl_index->'allow', '{}'::jsonb)) b
                WHERE (jsonb_typeof(b.value->'publish') = 'array' AND jsonb_array_length(b.value->'publish') > 0)
                   OR (jsonb_typeof(b.value->'admin') = 'array' AND jsonb_array_length(b.value->'admin') > 0))
UNION ALL
SELECT 'documents currently Archived (unarchive already guarded; archive now guarded)', COUNT(*)
  FROM documents WHERE status = 'Archived'
UNION ALL
SELECT 'documents not Archived (their archive now takes publish authority)', COUNT(*)
  FROM documents WHERE status IS DISTINCT FROM 'Archived'
UNION ALL
SELECT 'documents under an active hold (a non-controller archive is now refused until release)', COUNT(DISTINCT h.document_id)
  FROM document_holds h WHERE h.released_at IS NULL;

BEGIN;

-- ── OWN-19: archiving takes publish authority (body from 20261046) ──────────
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
-- Probes: ok = true × 4. Inventory rows: n = the aggregate count.
SELECT 'publish guard treats entering Archived as advancing' AS check,
       (SELECT prosrc LIKE '%(NEW.status = ''Archived'' AND COALESCE(OLD.status, '''') <> ''Archived'')%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the supersede, version-promote and terminal-exit disjuncts survive',
       (SELECT prosrc LIKE '%(NEW.status = ''Superseded'' AND COALESCE(OLD.status, '''') <> ''Superseded'')%'
              AND prosrc LIKE '%(NEW.current_version_id IS DISTINCT FROM OLD.current_version_id)%'
              AND prosrc LIKE '%OLD.status IN (''Superseded'', ''Archived'', ''Void'')%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL::text
UNION ALL
SELECT 'authority order intact: review gate, then is_org_controller, then publisher-or-owner, then hold',
       (SELECT position('is_org_controller(NEW.org_id)' IN prosrc) > position('outstanding review sign-offs' IN prosrc)
              AND position('user_can_publish_on_library(NEW.library_id' IN prosrc) > position('is_org_controller(NEW.org_id)' IN prosrc)
              AND position('Document has an active hold' IN prosrc) > position('user_can_publish_on_library(NEW.library_id' IN prosrc)
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL::text
UNION ALL
SELECT 'enforce_document_publish_guard is SECURITY DEFINER with search_path pinned',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard'),
       NULL::text
UNION ALL
SELECT 'inventory (before apply): ' || what, NULL::boolean, n::text FROM _rp_e60_before
UNION ALL
SELECT 'inventory (after apply): documents Archived', NULL::boolean, COUNT(*)::text FROM documents WHERE status = 'Archived';
