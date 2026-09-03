-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 7 (build 4 of 99-fix-sequencing), Round C2: the
-- drafting → document-control hand-back (GAP-6 / DEC-22 / LIFE-1 / LIFE-5).
--
--   A revision published FROM a drafting ticket carries the ticket it delivers:
--   `document_versions.related_ticket_id` (present in the baseline schema, and
--   inert since DEC-23 deleted the review waiver that once read it) is now
--   written by the publish contract. `publish_revision` is re-created with the
--   body 20261040 left live plus ONE addition — the column in the INSERT list
--   and `NULLIF(p_version->>'related_ticket_id','')::uuid` in VALUES. Nothing
--   else in the function changes (the shape test line-diffs the two bodies).
--
--   Not a widening: the same actors publish under the same authority; a
--   provenance column is filled. The app half (`revUpDocument` carries
--   `relatedTicketId`, the ticket's "Publish as revision of DOC-xxx" action,
--   the close-time "deliverable not in the register" state) ships with this
--   migration and is inert until it is applied (an unknown JSON key is ignored).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. the provenance column (baseline has it; older databases may not) ─────
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS related_ticket_id UUID;
CREATE INDEX IF NOT EXISTS document_versions_related_ticket_idx
  ON document_versions(related_ticket_id) WHERE related_ticket_id IS NOT NULL;
COMMENT ON COLUMN document_versions.related_ticket_id IS
  'GAP-6 / DEC-22: the drafting ticket this revision delivered. Provenance only — never a review waiver (DEC-23).';

-- ── 2. publish_revision — 20261040 body + related_ticket_id in the INSERT ──
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
      is_branch, published_base_version_id, provenance, related_ticket_id
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
      p_as_branch, p_expected_base, NULLIF(p_version->>'provenance',''),
      NULLIF(p_version->>'related_ticket_id','')::uuid
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

-- ── Verification (read-only) — expect true × 4 ──────────────────────────────
SELECT 'document_versions.related_ticket_id exists (uuid)' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
               AND table_name = 'document_versions' AND column_name = 'related_ticket_id' AND data_type = 'uuid') AS ok
UNION ALL
SELECT 'publish_revision inserts related_ticket_id from p_version',
       (SELECT prosrc LIKE '%is_branch, published_base_version_id, provenance, related_ticket_id%'
          AND prosrc LIKE '%NULLIF(p_version->>''related_ticket_id'','''')::uuid%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'publish_revision')
UNION ALL
SELECT 'publish_revision keeps its authority body (additive controller SELECT, MOC gate, revert-target gate)',
       (SELECT prosrc LIKE '%PSM requires an MOC reference%' AND prosrc LIKE '%revert target is not a revision of this document%'
          AND prosrc LIKE '%roles && ARRAY[''Admin'',''DocCtrl'']%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'publish_revision')
UNION ALL
SELECT 'authenticated may execute publish_revision; PUBLIC may not',
       has_function_privilege('authenticated', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean)', 'EXECUTE')
       AND NOT has_function_privilege('public', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean)', 'EXECUTE');
