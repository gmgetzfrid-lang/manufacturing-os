-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 5 — OWN-3 / DEC-2 (+ CHAIN-1, ADD-1 on the SQL
-- side): the publish path reads the ROLE COLLECTION, not the headline.
--
-- A member who holds DocCtrl AND Manager has org_members.role = 'Manager'
-- (Manager outranks DocCtrl in ROLE_RANK, and the headline is the max), so
-- every check that read the singular `role` said "not a controller" while
-- is_org_controller() — already additive, already used by the DELETE
-- policies — said "controller". Net effect: that person could DELETE a
-- document but not PUBLISH a revision of it. DEC-2 settles the shape: route
-- the headline-only checks through the collection; do NOT reorder ROLE_RANK.
--
-- Four of DEC-2's five sites land here; node_visible (all document read
-- visibility) lands LAST and separately in 20261041, per the decision.
--
--   1. enforce_document_publish_guard  → is_org_controller(NEW.org_id)
--   2. user_can_publish_on_library     → additive controller check, and the
--                                        ACL role-subject match (allow AND
--                                        deny) evaluates EVERY held role
--                                        (CHAIN-1: a deny naming an additive
--                                        role binds; ADD-1: an allow naming
--                                        one grants)
--   3. publish_revision v_is_controller → additive (inline: p_actor may be a
--                                        service-role caller's named actor)
--   4. sign-off / ack row policies      → is_org_controller(org_id)
--
-- THIS WIDENS AUTHORITY for members holding Admin/DocCtrl additively under a
-- higher headline. The inventory below counts them (aggregate only); the
-- operator's count is recorded in the OWN-3 resolution before this ships.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. the live publish/supersede guard (body from 20261030, controller
--       block substituted; everything else byte-identical) ──────────────────
CREATE OR REPLACE FUNCTION enforce_document_publish_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor        uuid    := auth.uid();   -- NULL for service-role / SQL console
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


-- ── 2. per-library publish authority — collection-aware throughout ─────────
CREATE OR REPLACE FUNCTION user_can_publish_on_library(p_library uuid, p_uid text, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role  text;
  v_roles text[];
  v_teams text[];
  v_idx   jsonb;
BEGIN
  IF p_library IS NULL OR p_uid IS NULL OR p_org IS NULL THEN
    RETURN false;
  END IF;

  -- The member's FULL role collection (headline ∪ additive), never empty
  -- for an active member.
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
    FROM org_members
   WHERE org_id = p_org AND uid::text = p_uid AND status = 'active'
   LIMIT 1;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  IF NOT (v_role = ANY(v_roles)) THEN
    v_roles := array_append(v_roles, v_role);
  END IF;

  -- OWN-3/DEC-2: the broad controller tier follows the COLLECTION.
  IF v_roles && ARRAY['Admin','DocCtrl']::text[] THEN
    RETURN true;
  END IF;

  SELECT acl_index INTO v_idx FROM libraries WHERE id = p_library;
  IF v_idx IS NULL THEN
    RETURN false;   -- no grants recorded -> only controllers publish
  END IF;

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid::text = p_uid AND org_id = p_org;

  -- Explicit deny of publish wins (user / ANY held role / team).
  IF COALESCE((v_idx->'deny'->'users'->'publish') ? p_uid, false)
     OR EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE (v_idx->'deny'->'roles'->'publish') ? r)
     OR COALESCE(v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'publish') ? t), false)
  THEN
    RETURN false;
  END IF;

  -- Allowed if granted "publish" OR "admin" to the user, ANY held role, or a team.
  RETURN COALESCE(
       (v_idx->'allow'->'users'->'publish') ? p_uid
    OR (v_idx->'allow'->'users'->'admin')   ? p_uid
    OR EXISTS (SELECT 1 FROM unnest(v_roles) r
                WHERE (v_idx->'allow'->'roles'->'publish') ? r
                   OR (v_idx->'allow'->'roles'->'admin')   ? r)
    OR (v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t
           WHERE (v_idx->'allow'->'teams'->'publish') ? t
              OR (v_idx->'allow'->'teams'->'admin')   ? t)),
    false);
END;
$$;

-- ── 3. publish_revision — body from 20261036 with the controller SELECT
--       made additive; everything else byte-identical ────────────────────────
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
  p_override_lock BOOLEAN DEFAULT FALSE
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

  IF v_doc.checked_out_by IS NOT NULL
     AND v_doc.checked_out_by::text <> p_actor::text
     AND NOT (p_override_lock OR (p_force AND v_is_controller)) THEN
    RETURN jsonb_build_object(
      'status', 'locked_by_other',
      'holder_name', v_doc.checked_out_by_name
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM document_holds
    WHERE document_id = p_doc AND released_at IS NULL
  ) AND NOT (p_force AND v_is_controller) THEN
    RETURN jsonb_build_object('status', 'on_hold');
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
          AND (COALESCE(t.review_state, '') IN ('in_review', 'rejected')
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
      is_branch, published_base_version_id, provenance
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
      p_as_branch, p_expected_base, NULLIF(p_version->>'provenance','')
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
    UPDATE documents SET
      current_version_id = v_new_id,
      rev = btrim(v_label),
      revision = btrim(v_label),
      status = COALESCE(NULLIF(p_new_status,''), 'Issued'),
      updated_at = v_now,
      updated_by = p_actor
    WHERE id = p_doc;
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
  'Transactional, per-document-serialized revision publish. The acting identity is derived from auth.uid() (p_actor honored only on service-role calls). content op_class enforces the expected-base check, the drawing-class MOC gate (DCK-1) and the revert-target gate (REV-2); a branch insert carries the same publish-authority bar as a promote (OWN-5). p_override_lock = authorized publisher''s checkout-override (passes the lock, never a hold); p_force = controller-only emergency bypass.';

REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean) TO authenticated, service_role;

-- ── 4. sign-off / acknowledgment row management — controllers by collection ─
DROP POLICY IF EXISTS doc_review_signoff_update ON document_review_signoffs;
CREATE POLICY doc_review_signoff_update ON document_review_signoffs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (
    reviewer_user_id = auth.uid()
    OR is_org_controller(document_review_signoffs.org_id)
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_review_signoffs.document_id
               AND (
                 user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
                 OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)
               ))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
);

DROP POLICY IF EXISTS doc_review_signoff_delete ON document_review_signoffs;
CREATE POLICY doc_review_signoff_delete ON document_review_signoffs FOR DELETE USING (
  is_org_controller(document_review_signoffs.org_id)
);

DROP POLICY IF EXISTS doc_ack_update ON document_acknowledgments;
CREATE POLICY doc_ack_update ON document_acknowledgments FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (
    assignee_user_id = auth.uid()
    OR is_org_controller(document_acknowledgments.org_id)
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_acknowledgments.document_id
               AND (
                 user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
                 OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)
               ))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
);

DROP POLICY IF EXISTS doc_ack_delete ON document_acknowledgments;
CREATE POLICY doc_ack_delete ON document_acknowledgments FOR DELETE USING (
  is_org_controller(document_acknowledgments.org_id)
);

COMMIT;

-- ── Verification (read-only) — expect true × 6 ──────────────────────────────
SELECT 'publish guard routes through is_org_controller' AS check,
       (SELECT prosrc LIKE '%is_org_controller(NEW.org_id)%'
          AND prosrc NOT LIKE '%v_role IN (''Admin'', ''DocCtrl'')%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard') AS ok
UNION ALL
SELECT 'publish guard keeps the signature-backed review gate',
       (SELECT prosrc LIKE '%e.signer_user_id = s.reviewer_user_id%'
          FROM pg_proc WHERE proname = 'enforce_document_publish_guard')
UNION ALL
SELECT 'user_can_publish_on_library evaluates the role collection',
       (SELECT prosrc LIKE '%v_roles && ARRAY[''Admin'',''DocCtrl'']%'
          AND prosrc LIKE '%FROM unnest(v_roles) r WHERE (v_idx->''deny''->''roles''->''publish'') ? r%'
          FROM pg_proc WHERE proname = 'user_can_publish_on_library')
UNION ALL
SELECT 'publish_revision controller tier is additive',
       (SELECT prosrc LIKE '%roles && ARRAY[''Admin'',''DocCtrl'']::text[]%'
          AND prosrc LIKE '%p_actor does not match the calling session%'
          FROM pg_proc WHERE proname = 'publish_revision')
UNION ALL
SELECT 'sign-off and ack row policies use is_org_controller',
       (SELECT COUNT(*) = 4 FROM pg_policies
         WHERE policyname IN ('doc_review_signoff_update','doc_review_signoff_delete','doc_ack_update','doc_ack_delete')
           AND (COALESCE(qual,'') LIKE '%is_org_controller%'))
UNION ALL
SELECT 'search_path pinned on the three re-created functions',
       (SELECT COUNT(*) = 3 FROM pg_proc
         WHERE proname IN ('enforce_document_publish_guard','user_can_publish_on_library','publish_revision')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');

-- ── Inventory (read-only, aggregate) — the DEC-2 inventory. These members
--    GAIN controller powers on the publish path (they already had them on
--    delete/ownership/policy writes). Counts only, never rows.
SELECT 'members holding Admin/DocCtrl additively under a higher headline' AS inventory,
       COUNT(*)::text AS n
FROM org_members
WHERE status = 'active'
  AND roles && ARRAY['Admin','DocCtrl']::text[]
  AND role NOT IN ('Admin','DocCtrl')
UNION ALL
SELECT 'of which headline = ' || role, COUNT(*)::text
FROM org_members
WHERE status = 'active'
  AND roles && ARRAY['Admin','DocCtrl']::text[]
  AND role NOT IN ('Admin','DocCtrl')
GROUP BY role
UNION ALL
-- OWN-6: team publish grants that become LIVE on the app's mutator path
-- (the database already honored them) — libraries whose index carries any.
SELECT 'libraries with team publish/admin grants (OWN-6, now live app-side)', COUNT(*)::text
FROM libraries
WHERE jsonb_array_length(COALESCE(acl_index->'allow'->'teams'->'publish', '[]'::jsonb)) > 0
   OR jsonb_array_length(COALESCE(acl_index->'allow'->'teams'->'admin', '[]'::jsonb)) > 0;
