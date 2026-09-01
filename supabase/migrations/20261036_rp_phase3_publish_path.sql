-- Roles-and-permissions Phase 3 — close the publish path (OWN-1, OWN-2/DEC-6,
-- OWN-5).
--
--   · OWN-1 — `libraries` had ONE policy: FOR ALL USING (org membership), no
--     WITH CHECK, no trigger. Any member could take ownership of any library,
--     rewrite its ACL, change its review-control/retention policy, or DELETE
--     it. Rails: a BEFORE UPDATE guard on the SENSITIVE columns (ownership,
--     access, compliance policy) — cosmetic columns (names, layouts, widths)
--     stay member-writable so seventeen shipped call sites keep working —
--     plus a RESTRICTIVE controllers-only DELETE policy. The app half
--     (OWN-14, on the branch) makes every affected write fail loudly.
--   · OWN-2 / DEC-6 — documents_guard_access_change guarded visibility/acl
--     but NOT owner_user_id/owner_name: any member could PATCH themselves in
--     as owner and collect the owner's publish authority. The guard now
--     covers ownership: controller, ACL manage-grant, or the CURRENT owner
--     may reassign; an unowned, unrestricted document may still be claimed
--     (first assignment keeps working); takeover is refused.
--   · OWN-5 — publish_revision trusted a caller-supplied p_actor (forgeable
--     attribution + borrowed authority) and its BRANCH path skipped the
--     publish-authority evaluation entirely (the promote path's trigger never
--     fires — no documents write). The actor is now derived from auth.uid()
--     (p_actor honored only on service-role paths), the branch insert
--     requires the same authority as a promote, and EXECUTE is revoked from
--     PUBLIC. The app half retires the v1 retry that upgraded a checkout
--     override into a controller force.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

-- ── OWN-1: library sensitive-column guard ───────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_library_sensitive_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF (NEW.owner_user_id   IS DISTINCT FROM OLD.owner_user_id
      OR NEW.owner_name   IS DISTINCT FROM OLD.owner_name
      OR NEW.owner_team_id IS DISTINCT FROM OLD.owner_team_id
      OR NEW.acl          IS DISTINCT FROM OLD.acl
      OR NEW.acl_index    IS DISTINCT FROM OLD.acl_index
      OR NEW.write_access  IS DISTINCT FROM OLD.write_access
      OR NEW.admin_access  IS DISTINCT FROM OLD.admin_access
      OR NEW.read_access   IS DISTINCT FROM OLD.read_access
      OR NEW.visible_to    IS DISTINCT FROM OLD.visible_to
      OR NEW.folder_security IS DISTINCT FROM OLD.folder_security
      OR NEW.default_new_acl IS DISTINCT FROM OLD.default_new_acl
      OR NEW.default_new_visibility IS DISTINCT FROM OLD.default_new_visibility
      OR NEW.review_control  IS DISTINCT FROM OLD.review_control
      OR NEW.review_policy   IS DISTINCT FROM OLD.review_policy
      OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy
      OR NEW.ack_policy      IS DISTINCT FROM OLD.ack_policy
      OR NEW.recert_policy   IS DISTINCT FROM OLD.recert_policy) THEN
    IF NOT is_org_controller(OLD.org_id)
       AND OLD.owner_user_id::text IS DISTINCT FROM auth.uid()::text
       AND NOT can_manage_node(OLD.acl_index, OLD.org_id) THEN
      RAISE EXCEPTION 'Not permitted to change this library''s ownership, access control, or compliance policy.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_library_sensitive_columns ON libraries;
CREATE TRIGGER trg_library_sensitive_columns
BEFORE UPDATE ON libraries
FOR EACH ROW EXECUTE FUNCTION enforce_library_sensitive_columns();

-- DELETE: controllers only (both app delete sites check their errors).
DROP POLICY IF EXISTS libraries_delete_controllers ON libraries;
CREATE POLICY libraries_delete_controllers ON libraries
AS RESTRICTIVE FOR DELETE USING (is_org_controller(org_id));

-- ── OWN-2 / DEC-6: ownership joins the documents access-change guard ───────
CREATE OR REPLACE FUNCTION documents_guard_access_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.visibility IS DISTINCT FROM OLD.visibility
      OR NEW.acl IS DISTINCT FROM OLD.acl
      OR NEW.acl_index IS DISTINCT FROM OLD.acl_index) THEN
    -- Only real end users are gated; service-role/superuser have a null uid.
    IF auth.uid() IS NOT NULL
       AND NOT can_manage_node(OLD.acl_index, OLD.org_id)
       AND NOT (OLD.acl_index IS NULL AND COALESCE(OLD.visibility, 'normal') = 'normal') THEN
      RAISE EXCEPTION 'Not permitted to change document visibility or access control on this document';
    END IF;
  END IF;

  -- OWN-2: ownership is authority (the effective owner may publish), so the
  -- owner columns get the same discipline: a controller, an ACL
  -- manage-grant, or the CURRENT owner may reassign. First assignment on an
  -- unowned, unrestricted document stays open (DEC-6: the Inspector's
  -- "Assign owner" must keep working on default-open libraries); a TAKEOVER
  -- of an owned document is refused.
  IF (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.owner_name IS DISTINCT FROM OLD.owner_name) THEN
    IF auth.uid() IS NOT NULL
       AND NOT is_org_controller(OLD.org_id)
       AND NOT can_manage_node(OLD.acl_index, OLD.org_id)
       AND OLD.owner_user_id::text IS DISTINCT FROM auth.uid()::text
       AND NOT (OLD.owner_user_id IS NULL
                AND OLD.acl_index IS NULL
                AND COALESCE(OLD.visibility, 'normal') = 'normal') THEN
      RAISE EXCEPTION 'Not permitted to change this document''s owner.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- (Trigger documents_guard_access keeps its BEFORE UPDATE binding.)

-- ── OWN-5: publish_revision — session-derived actor + gated branch path ─────
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

  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_doc.org_id AND uid = p_actor AND status = 'active'
      AND role IN ('Admin','DocCtrl')
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

COMMIT;

-- ── Verification (read-only) — expect true / true / true / true / true ──────
SELECT 'library sensitive-column guard installed' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_library_sensitive_columns' AND NOT tgisinternal) AS ok
UNION ALL
SELECT 'libraries DELETE is controllers-only (restrictive)',
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'libraries'
                AND policyname = 'libraries_delete_controllers' AND permissive = 'RESTRICTIVE')
UNION ALL
SELECT 'documents guard covers ownership',
       (SELECT prosrc LIKE '%owner_user_id IS DISTINCT FROM OLD.owner_user_id%'
          FROM pg_proc WHERE proname = 'documents_guard_access_change')
UNION ALL
SELECT 'publish_revision derives the actor from the session',
       (SELECT prosrc LIKE '%p_actor does not match the calling session%'
          FROM pg_proc WHERE proname = 'publish_revision')
UNION ALL
SELECT 'branch path carries the publish-authority bar',
       (SELECT prosrc LIKE '%branches included%' FROM pg_proc WHERE proname = 'publish_revision')
UNION ALL
-- Every column the library guard references must EXIST (plpgsql binds them at
-- run time — a missing one would break every library update). Expect true.
SELECT 'all guarded library columns exist',
       (SELECT COUNT(*) = 17 FROM information_schema.columns
         WHERE table_name = 'libraries'
           AND column_name IN ('owner_user_id','owner_name','owner_team_id','acl','acl_index',
                               'write_access','admin_access','read_access','visible_to',
                               'folder_security','default_new_acl','default_new_visibility',
                               'review_control','review_policy','retention_policy',
                               'ack_policy','recert_policy'));

-- ── Inventory (read-only, paste results back) — what the new rails will
-- start refusing. Expect SMALL numbers; a large count means live workflows
-- depend on the hole and we should look before anyone hits the guard.
-- (a) libraries whose owner is NOT a controller (their owner keeps sensitive-
--     column access through the owner arm — listed so the count is known):
SELECT 'non-controller library owners' AS inventory, COUNT(*)::text AS n
FROM libraries l
WHERE l.owner_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = l.org_id
                  AND m.uid = l.owner_user_id AND m.status = 'active'
                  AND m.role IN ('Admin','DocCtrl'))
UNION ALL
-- (b) documents already owned by someone (takeover now refused for these):
SELECT 'owned documents (takeover now refused)', COUNT(*)::text
FROM documents WHERE owner_user_id IS NOT NULL
UNION ALL
-- (c) unreconciled branch rows (existing branches are untouched; new ones
--     now need publish authority):
SELECT 'existing unreconciled branch versions', COUNT(*)::text
FROM document_versions WHERE COALESCE(is_branch, FALSE) = TRUE AND superseded_at IS NULL;
