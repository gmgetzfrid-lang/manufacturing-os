-- 20260828_integrity_hardening.sql
--
-- INTEGRITY HARDENING — closes four holes the implementation audit found:
--
--   1. publish_revision v2: the checkout-override path ("publish over
--      someone's lock, with a note to them") could ALSO silently bypass an
--      active HOLD when the actor was a controller, and didn't work at all
--      for non-controller publishers (effective owners / granted
--      supervisors). A new p_override_lock parameter now carries the
--      override: it passes the LOCK check for any authorized publisher and
--      NEVER passes a hold. p_force keeps its old meaning (controller-only
--      emergency bypass of everything) and is no longer conflated with the
--      polite override.
--
--   2. document_review_signoffs RLS: the old member-ALL policy let ANY org
--      member update ANY sign-off row — i.e. sign a review on someone
--      else's behalf, defeating the publish-completion guard. Updates are
--      now limited to the reviewer's own row, controllers, and the
--      document's effective owner (who legitimately voids rows on
--      resubmit/finalize). The daily scans run service-role and are
--      unaffected.
--
--   3. document_acknowledgments RLS: same hole, same fix — an assignee can
--      only sign their OWN read-&-understood row.
--
--   4. work_package_documents: had no UPDATE policy at all, so "Refresh
--      pack" (which re-pins every drawing to the current revision) silently
--      matched zero rows from the browser. Org members can now update.
--
-- Additive + idempotent. Apply in the Supabase SQL editor.

-- ─── 1. publish_revision v2 ──────────────────────────────────────────────
-- The old signature must be dropped first: adding a defaulted parameter via
-- CREATE OR REPLACE would create an OVERLOAD, and PostgREST rpc calls with
-- named args would then match both and fail as ambiguous.

DROP FUNCTION IF EXISTS publish_revision(UUID, UUID, TEXT, JSONB, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT, TEXT);

CREATE OR REPLACE FUNCTION publish_revision(
  p_doc UUID,
  p_expected_base UUID,          -- may be NULL: "document had no current version"
  p_op_class TEXT,               -- 'content' enforces the base check; 'metadata' skips it
  p_version JSONB,               -- new document_versions row fields (already-uploaded file)
  p_actor UUID,
  p_actor_name TEXT DEFAULT NULL,
  p_actor_role TEXT DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE, -- controllers only: emergency bypass of lock AND hold
  p_as_branch BOOLEAN DEFAULT FALSE,
  p_branch_reason TEXT DEFAULT NULL,
  p_new_status TEXT DEFAULT 'Issued',
  p_override_lock BOOLEAN DEFAULT FALSE -- authorized publisher's checkout-override: passes the LOCK, never a hold
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
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

-- ─── 2. document_review_signoffs: sign your OWN row only ─────────────────

DROP POLICY IF EXISTS "doc_review_signoff_member_all" ON document_review_signoffs;
DROP POLICY IF EXISTS doc_review_signoff_select ON document_review_signoffs;
DROP POLICY IF EXISTS doc_review_signoff_insert ON document_review_signoffs;
DROP POLICY IF EXISTS doc_review_signoff_update ON document_review_signoffs;
DROP POLICY IF EXISTS doc_review_signoff_delete ON document_review_signoffs;

CREATE POLICY doc_review_signoff_select ON document_review_signoffs FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
);
-- Roster creation: any active member may open a roster (publish authority is
-- enforced app-side + by the publish guard trigger at promote time).
CREATE POLICY doc_review_signoff_insert ON document_review_signoffs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
);
-- Updates: the reviewer signs their OWN row; controllers and the document's
-- effective owner may manage rows (activate alternates, void on resubmit).
CREATE POLICY doc_review_signoff_update ON document_review_signoffs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (
    reviewer_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
               AND uid = auth.uid() AND status = 'active' AND role IN ('Admin','DocCtrl'))
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_review_signoffs.document_id
               AND user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid()))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
);
CREATE POLICY doc_review_signoff_delete ON document_review_signoffs FOR DELETE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active' AND role IN ('Admin','DocCtrl'))
);

-- ─── 3. document_acknowledgments: acknowledge your OWN row only ──────────

DROP POLICY IF EXISTS "doc_ack_member_all" ON document_acknowledgments;
DROP POLICY IF EXISTS doc_ack_select ON document_acknowledgments;
DROP POLICY IF EXISTS doc_ack_insert ON document_acknowledgments;
DROP POLICY IF EXISTS doc_ack_update ON document_acknowledgments;
DROP POLICY IF EXISTS doc_ack_delete ON document_acknowledgments;

CREATE POLICY doc_ack_select ON document_acknowledgments FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
);
CREATE POLICY doc_ack_insert ON document_acknowledgments FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
);
CREATE POLICY doc_ack_update ON document_acknowledgments FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (
    assignee_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
               AND uid = auth.uid() AND status = 'active' AND role IN ('Admin','DocCtrl'))
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_acknowledgments.document_id
               AND user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid()))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
);
CREATE POLICY doc_ack_delete ON document_acknowledgments FOR DELETE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active' AND role IN ('Admin','DocCtrl'))
);

-- ─── 4. work_package_documents: allow pin refresh ────────────────────────

DROP POLICY IF EXISTS work_package_documents_org_update ON work_package_documents;
CREATE POLICY work_package_documents_org_update ON work_package_documents FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
