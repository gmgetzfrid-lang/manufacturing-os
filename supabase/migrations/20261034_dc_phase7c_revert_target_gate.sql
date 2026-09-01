-- Document-control Phase 7c — the revert-target gate at the database (REV-2).
--
-- revertToVersion accepted an in-review draft or an unreconciled branch as
-- its target: unreviewed bytes became the controlled copy, and the DB
-- review-completion guard structurally could not see it (it examines the
-- incoming current version — the fresh revert row, which has no roster).
-- The app now refuses (assertRevertableTarget in lib/documentGuards.ts) and
-- the Version History panel no longer offers those rows — but publish_revision
-- is a SECURITY DEFINER RPC reachable directly, so the rule must live here too.
--
-- This re-creates publish_revision — byte-identical to the live 20261031
-- definition except ONE inserted block after the MOC gate: when the payload
-- names a reverted_from_version_id, that target must (a) be a revision of
-- THIS document, and (b) be previously issued — not an in-review/rejected
-- draft and not a branch. On a pre-review-schema database the state check
-- no-ops (DEC-30 two-worlds; the belongs-to-document check always applies).
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

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
  v_doc_class TEXT;
  v_is_revert BOOLEAN;
  v_minor_like BOOLEAN;
  v_revert_target UUID;
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

  -- MOC gate (DCK-1): a drawing-class CONTENT publish requires an MOC
  -- reference (OSHA 1910.119(l)). The Minor/Correction exemption is decided
  -- HERE, not in the client — and a REVERT is never minor-like, whatever
  -- change_type it declares (revertToVersion hardcodes 'Correction'):
  -- restoring older content to the field is exactly a real change.
  -- doc_class cascades document -> folder -> library; only a DECLARED drawing
  -- is gated (NULL/unclassified passes — activating a stricter rail against
  -- unclassified production data would block every legacy org's publishes).
  -- On a pre-20261012 database the doc_class columns do not exist; the gate
  -- must no-op there, not 42703 every content publish.
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

  -- Revert-target gate (REV-2): a revert must restore a previously-ISSUED
  -- revision of THIS document. An in-review or rejected draft never passed
  -- the review gate, and an unreconciled branch was explicitly parked — the
  -- review-completion guard cannot see either (the fresh revert row has no
  -- roster), so the refusal lives here. The review_state/is_branch check
  -- no-ops on a pre-review-schema database.
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
      NULL;  -- pre-review schema: no draft/branch states to gate
    END;
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
  'Transactional, per-document-serialized revision publish. content op_class enforces the expected-base check (returns stale_base instead of clobbering), the drawing-class MOC gate (DCK-1) and the revert-target gate (REV-2: a revert may only restore a previously-issued revision of this document); metadata skips them; as_branch publishes without promoting and opens a revision_branches debt row. p_override_lock = authorized publisher''s checkout-override (passes the lock, never a hold); p_force = controller-only emergency bypass.';

COMMIT;

-- ── Verification (read-only) — expect true / true / true ────────────────────
SELECT 'publish_revision carries the revert-target gate' AS check,
       (SELECT pg_get_functiondef(oid) LIKE '%only previously-issued revisions can be restored%'
          FROM pg_proc WHERE proname = 'publish_revision') AS ok
UNION ALL
SELECT 'the MOC gate survived the re-create',
       (SELECT pg_get_functiondef(oid) LIKE '%PSM requires an MOC reference%'
          FROM pg_proc WHERE proname = 'publish_revision')
UNION ALL
SELECT 'search_path still pinned on publish_revision',
       EXISTS (
         SELECT 1 FROM pg_proc p
         WHERE p.proname = 'publish_revision'
           AND EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c
                       WHERE c LIKE 'search_path=%')
       );
