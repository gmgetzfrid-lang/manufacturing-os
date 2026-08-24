-- ============================================================================
-- COMBINED APPLY SCRIPT — roles-and-permissions audit remediation (2026-08-24)
-- ============================================================================
-- The SIX safe migrations from this session, in dependency order, as one file.
-- Every statement is idempotent (IF EXISTS / IF NOT EXISTS / CREATE OR REPLACE /
-- guarded ALTER / WHERE-filtered UPDATE), so this is safe to RE-RUN.
--
-- Wrapped in one transaction: if any statement fails, nothing is applied.
-- The application code for all six is ALREADY on the branch, so deploy order
-- (code first) is already satisfied — just run this.
--
-- Covers:
--   1) 20261019  publish_revision: drop the dead p_actor_role param  (DEC-11/DB-6)
--   2) 20261020  pin search_path on SECURITY DEFINER functions       (DB-6)
--   3) 20261021  owner lookup indexes on libraries/collections       (DEC-11)
--   4) 20261022  document_shares: per-verb ACL-scoped policies        (EGRESS-1)
--   5) 20261023  access_requests: org scope + close anon insert       (EGRESS-5/DEC-19)
--   6) 20261024  backfill org_members.roles from role                 (DB-3/DEC-1)
--
-- After it runs, scroll to the bottom: two VERIFICATION queries should each
-- return ZERO rows. If either returns rows, tell me before relying on the fix.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1) 20261019 — publish_revision: retire the dead p_actor_role parameter.
--    p_actor_role was never read (authority comes from org_members by p_actor).
--    Postgres keys functions by (name, arg types): the old signatures are
--    dropped explicitly, then the parameter-free version is (re)created with
--    search_path pinned.
-- ============================================================================

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

-- ============================================================================
-- 2) 20261020 — pin search_path on every SECURITY DEFINER function that lacks
--    it. ALTER (not re-CREATE) so whatever body is deployed keeps running; the
--    to_regprocedure() guard skips any signature that does not exist.
-- ============================================================================

DO $$
DECLARE
  sig TEXT;
  sigs TEXT[] := ARRAY[
    'my_org_ids()',
    'my_team_ids()',
    'my_project_ids()',
    'node_visible(text, jsonb, uuid)',
    'doc_is_visible(uuid)',
    'is_org_admin(uuid)',
    'is_org_admin_or_manager(uuid)',
    'is_org_controller(uuid)',
    'is_org_assign_drafters(uuid)',
    'can_manage_node(jsonb, uuid)',
    'can_manage_project(uuid)',
    'documents_guard_access_change()',
    'bump_share_access(uuid)',
    'revup_rollback_orphan(uuid, uuid)',
    'enforce_document_publish_guard()',
    'enforce_legal_hold_delete_guard()',
    'enforce_legal_hold_version_delete_guard()',
    'enforce_document_move_guard()',
    'publish_revision(uuid, uuid, text, jsonb, uuid, text, text, boolean, boolean, text, text)',
    'publish_revision(uuid, uuid, text, jsonb, uuid, text, text, boolean, boolean, text, text, boolean)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', sig);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 3) 20261021 — owner lookup indexes (libraries + collections), matching the
--    existing documents/projects owner indexes.
-- ============================================================================

CREATE INDEX IF NOT EXISTS libraries_owner_idx
  ON libraries (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS collections_owner_idx
  ON collections (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

-- ============================================================================
-- 4) 20261022 — document_shares: replace the single FOR ALL policy with
--    per-verb policies. INSERT requires the document be IN THE SAME ORG and
--    readable to the creator; UPDATE/DELETE are creator-or-controller only.
-- ============================================================================

DROP POLICY IF EXISTS document_shares_org_member ON document_shares;
DROP POLICY IF EXISTS document_shares_org_select ON document_shares;
DROP POLICY IF EXISTS document_shares_insert ON document_shares;
DROP POLICY IF EXISTS document_shares_update ON document_shares;
DROP POLICY IF EXISTS document_shares_delete ON document_shares;

CREATE POLICY document_shares_org_select ON document_shares FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = document_shares.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
);

CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = document_shares.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_shares.document_id
      AND d.org_id = document_shares.org_id
      AND node_visible(d.visibility, d.acl_index, d.org_id)
  )
);

CREATE POLICY document_shares_update ON document_shares FOR UPDATE USING (
  document_shares.created_by = auth.uid()
  OR is_org_controller(document_shares.org_id)
);

CREATE POLICY document_shares_delete ON document_shares FOR DELETE USING (
  document_shares.created_by = auth.uid()
  OR is_org_controller(document_shares.org_id)
);

-- ============================================================================
-- 5) 20261023 — access_requests: add org_id, org-correlate the admin SELECT,
--    close the anonymous insert door, and index the hot query.
-- ============================================================================

ALTER TABLE access_requests ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES orgs(id) ON DELETE CASCADE;

UPDATE access_requests ar
   SET org_id = o.id
  FROM orgs o
 WHERE ar.org_id IS NULL
   AND lower(btrim(o.name)) = lower(btrim(ar.org_name));

DROP POLICY IF EXISTS access_requests_admin_select ON access_requests;
CREATE POLICY access_requests_admin_select ON access_requests FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM org_members m
      WHERE m.org_id = access_requests.org_id
        AND m.uid = auth.uid()
        AND m.status = 'active'
        AND (m.role = 'Admin' OR m.roles && ARRAY['Admin']::text[])
    )
  );

DROP POLICY IF EXISTS access_requests_anyone_insert ON access_requests;

CREATE INDEX IF NOT EXISTS access_requests_org_status_idx ON access_requests (org_id, status);

-- ============================================================================
-- 6) 20261024 — backfill org_members.roles from role, so the additive-roles
--    checks stop evaluating members against an empty array.
-- ============================================================================

UPDATE org_members
   SET roles = ARRAY[role]
 WHERE role IS NOT NULL
   AND role <> ''
   AND (roles IS NULL OR roles = '{}' OR NOT (role = ANY(roles)));

COMMIT;

-- ============================================================================
-- VERIFICATION (read-only) — each of these should return ZERO rows.
-- Run them after the COMMIT above. Rows here mean the fix did not fully take.
-- ============================================================================

-- (a) No SECURITY DEFINER function in the app schema still lacks search_path:
SELECT p.oid::regprocedure AS still_unpinned
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND NOT EXISTS (
    SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS c
    WHERE c LIKE 'search_path=%'
  );

-- (b) Every member's roles array carries its headline role:
SELECT uid, org_id, role, roles
FROM org_members
WHERE role IS NOT NULL AND role <> '' AND NOT (role = ANY(roles));
