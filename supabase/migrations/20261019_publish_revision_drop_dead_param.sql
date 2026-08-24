-- ─────────────────────────────────────────────────────────────────────────────
-- Retire publish_revision's dead p_actor_role parameter (DEC-11 / OWN-5 partial)
-- and pin search_path on the recreated function (DB-6).
--
-- p_actor_role is referenced NOWHERE in the function body (verified against
-- both the 20260823 and 20260828 definitions): the function derives authority
-- from org_members by p_actor, never from the caller-asserted role string.
-- On a SECURITY DEFINER publish RPC, a parameter that looks like an authority
-- input but is ignored reads as a check that does not exist — remove it.
--
-- Postgres keys functions by (name, argument types): dropping a parameter
-- creates a NEW signature rather than replacing the old one, so the old
-- signatures are dropped explicitly. Two defensive drops:
--   * the 20260823 v1 shape (11 args) — already dropped by 20260828, repeated
--     IF EXISTS here in case a deployment applied 20260823 only;
--   * the 20260828 v2 shape (12 args, with p_actor_role) — the live one.
--
-- ⚠ APPLY ORDER: deploy the application code that stops sending p_actor_role
-- (lib/revisions.ts) BEFORE applying this migration. The old function accepts
-- calls without p_actor_role (DEFAULT NULL), so new code works against the old
-- function; old code sending p_actor_role against the new function would not.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS publish_revision(UUID, UUID, TEXT, JSONB, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT);
DROP FUNCTION IF EXISTS publish_revision(UUID, UUID, TEXT, JSONB, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION publish_revision(
  p_doc UUID,
  p_expected_base UUID,          -- may be NULL: "document had no current version"
  p_op_class TEXT,               -- 'content' enforces the base check; 'metadata' skips it
  p_version JSONB,               -- new document_versions row fields (already-uploaded file)
  p_actor UUID,
  p_actor_name TEXT DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE, -- controllers only: emergency bypass of lock AND hold
  p_as_branch BOOLEAN DEFAULT FALSE,
  p_branch_reason TEXT DEFAULT NULL,
  p_new_status TEXT DEFAULT 'Issued',
  p_override_lock BOOLEAN DEFAULT FALSE -- authorized publisher's checkout-override: passes the LOCK, never a hold
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
BEGIN
  IF p_op_class NOT IN ('content','metadata') THEN
    RAISE EXCEPTION 'publish_revision: unknown op_class %', p_op_class;
  END IF;

  -- Serialize per document. Everything below happens with the doc row locked.
  SELECT * INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publish_revision: document % not found', p_doc;
  END IF;

  -- Caller must be an active member of the document's org (definer bypasses
  -- RLS, so enforce membership explicitly).
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

  -- LOCK: someone else's active checkout blocks a publish UNLESS the caller
  -- is overriding-with-a-note (p_override_lock — the app requires a reason
  -- and notifies the holder) or a controller is forcing.
  IF v_doc.checked_out_by IS NOT NULL
     AND v_doc.checked_out_by::text <> p_actor::text
     AND NOT (p_override_lock OR (p_force AND v_is_controller)) THEN
    RETURN jsonb_build_object(
      'status', 'locked_by_other',
      'holder_name', v_doc.checked_out_by_name
    );
  END IF;

  -- HOLD: deliberately stricter than the lock. A checkout-override NEVER
  -- passes a hold — only a controller's explicit force does. A hold is a
  -- "do not advance" safety flag, not a coordination courtesy.
  IF EXISTS (
    SELECT 1 FROM document_holds
    WHERE document_id = p_doc AND released_at IS NULL
  ) AND NOT (p_force AND v_is_controller) THEN
    RETURN jsonb_build_object('status', 'on_hold');
  END IF;

  -- THE core check: a content publish (not branching) must be built on the
  -- revision that is still current. Nothing has been written yet, so a stale
  -- base costs nothing and corrupts nothing.
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

  v_label := COALESCE(p_version->>'revision_label', '');
  IF btrim(v_label) = '' THEN
    RAISE EXCEPTION 'publish_revision: revision_label is required';
  END IF;

  -- Insert the version row.
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
    -- Branch: written but never promoted; open debt row instead.
    INSERT INTO revision_branches (
      org_id, document_id, branch_version_id, diverged_from_version_id,
      reason, created_by, created_by_name
    ) VALUES (
      v_doc.org_id, p_doc, v_new_id, v_doc.current_version_id,
      btrim(p_branch_reason), p_actor::text, p_actor_name
    ) RETURNING id INTO v_branch_id;
  ELSE
    -- Promote: stamp the old row, flip the pointer, roll the label — all in
    -- this same transaction, under the same row lock.
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
  'Transactional, per-document-serialized revision publish. content op_class enforces the expected-base check (returns stale_base instead of clobbering); metadata skips it; as_branch publishes without promoting and opens a revision_branches debt row. p_override_lock = authorized publisher''s checkout-override (passes the lock, never a hold); p_force = controller-only emergency bypass.';
