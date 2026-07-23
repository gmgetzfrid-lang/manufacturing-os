-- 20260823_publish_contract.sql
--
-- PUBLISH CONTRACT — make the lost update a database impossibility.
--
-- Problem this fixes: revUpDocument was three separate client calls
-- (insert version → stamp superseded_at → promote current_version_id) with
-- no transaction, no row lock, and no base-revision check. Two drafters who
-- both started from rev N could publish concurrently: the second silently
-- clobbered the first (both versions claiming supersedes = rev N, the first
-- publisher's work orphaned off the current chain, potentially both carrying
-- the same label) and NOBODY was told.
--
-- New model:
--   * publish_revision() runs the whole operation in ONE transaction,
--     serialized per-document by SELECT ... FOR UPDATE on the documents row.
--   * A 'content' publish must name the base version it built on
--     (expected_base). If the document has moved past that base, NOTHING is
--     written — the function returns status='stale_base' plus who moved it
--     and when, so the UI can show the conflict screen (diff / message /
--     branch), not an error string.
--   * "Publish anyway" is publish-as-BRANCH: the version row is written but
--     never promoted, and an open revision_branches row is created — visible
--     debt that must be explicitly resolved, never silently dismissed.
--   * op_class 'metadata' skips the base check (backfill/renumber-style
--     operations cannot lose drawing content and must never train users
--     that the conflict screen cries wolf).
--   * A partial unique index makes duplicate ACTIVE revision labels
--     impossible even if every other guard fails.
--
-- Additive + idempotent. Apply manually in the Supabase SQL editor, like the
-- rest of the migrations. The client keeps a pre-migration fallback path.

-- ─── document_versions: contract + provenance + custody columns ───────────
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS is_branch BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS published_base_version_id UUID REFERENCES document_versions(id);
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS provenance TEXT
  CHECK (provenance IN ('session','declared','unverified'));
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS provenance_verified_at TIMESTAMPTZ;
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS provenance_verified_by TEXT;
-- Phase 7 source custody: the native CAD file (DWG / zip of xrefs) stored
-- alongside the published PDF. source_file_name already exists.
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS source_file_key TEXT;

COMMENT ON COLUMN document_versions.is_branch IS
  'TRUE = published as an unreconciled branch (stale-base override); never promoted to current until resolved.';
COMMENT ON COLUMN document_versions.published_base_version_id IS
  'The version the publisher declared/was recorded as having started from. NULL on legacy rows.';
COMMENT ON COLUMN document_versions.provenance IS
  'session = published from an active checkout; declared = base picked manually, checks passed; unverified = no intent trail or heuristics contradict the declared base. NULL on legacy rows.';

-- ─── Duplicate-label backstop ─────────────────────────────────────────────
-- One ACTIVE (non-superseded, non-branch) row per (document, label). Wrapped
-- so pre-existing duplicate data downgrades to a loud notice instead of
-- failing the migration — the RPC still catches duplicates transactionally.
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS document_versions_active_label_uniq
    ON document_versions(record_id, revision_label)
    WHERE (superseded_at IS NULL AND is_branch = FALSE);
EXCEPTION WHEN unique_violation OR others THEN
  RAISE NOTICE 'document_versions_active_label_uniq NOT created (existing duplicate labels?): %', SQLERRM;
END$$;

-- ─── Branch debt ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revision_branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  branch_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  -- The version that was current when the branch author published — i.e. the
  -- revision their work does NOT include.
  diverged_from_version_id UUID REFERENCES document_versions(id),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolved_by_name TEXT,
  -- 'merged' = reconciled into a later revision; 'withdrawn' = branch work
  -- abandoned on the record.
  resolution TEXT CHECK (resolution IN ('merged','withdrawn')),
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS revision_branches_open_idx
  ON revision_branches(org_id, document_id) WHERE (resolved_at IS NULL);
CREATE INDEX IF NOT EXISTS revision_branches_doc_idx
  ON revision_branches(document_id, created_at DESC);

ALTER TABLE revision_branches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS revision_branches_org_select ON revision_branches;
CREATE POLICY revision_branches_org_select ON revision_branches FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = revision_branches.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

DROP POLICY IF EXISTS revision_branches_org_insert ON revision_branches;
CREATE POLICY revision_branches_org_insert ON revision_branches FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = revision_branches.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

-- Any active org member may resolve (author reconciles, DocCtrl closes out).
DROP POLICY IF EXISTS revision_branches_org_update ON revision_branches;
CREATE POLICY revision_branches_org_update ON revision_branches FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = revision_branches.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

-- ─── The contract itself ──────────────────────────────────────────────────
-- SECURITY DEFINER (same convention as revup_rollback_orphan) so the whole
-- write set commits or nothing does; caller identity and org membership are
-- validated explicitly below. The documents row lock serializes concurrent
-- publishes on the same document — the second caller waits, then sees the
-- first caller's promotion and gets stale_base instead of clobbering it.
CREATE OR REPLACE FUNCTION publish_revision(
  p_doc UUID,
  p_expected_base UUID,          -- may be NULL: "document had no current version"
  p_op_class TEXT,               -- 'content' enforces the base check; 'metadata' skips it
  p_version JSONB,               -- new document_versions row fields (already-uploaded file)
  p_actor UUID,
  p_actor_name TEXT DEFAULT NULL,
  p_actor_role TEXT DEFAULT NULL,
  p_force BOOLEAN DEFAULT FALSE, -- controllers only: bypass foreign lock / hold
  p_as_branch BOOLEAN DEFAULT FALSE,
  p_branch_reason TEXT DEFAULT NULL,
  p_new_status TEXT DEFAULT 'Issued'
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

  -- Same invariants as the app/trigger guard, now inside the transaction:
  -- no publishing over someone else's lock, no publishing past a hold.
  IF NOT (p_force AND v_is_controller) THEN
    IF v_doc.checked_out_by IS NOT NULL
       AND v_doc.checked_out_by::text <> p_actor::text THEN
      RETURN jsonb_build_object(
        'status', 'locked_by_other',
        'holder_name', v_doc.checked_out_by_name
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM document_holds
      WHERE document_id = p_doc AND released_at IS NULL
    ) THEN
      RETURN jsonb_build_object('status', 'on_hold');
    END IF;
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

-- The definer function's promote runs the enforce_document_publish_guard
-- trigger too (auth.uid() carries through) — belt and suspenders, and the
-- function has already applied the same rules, so it cannot deadlock with it.

COMMENT ON TABLE revision_branches IS
  'Open items created when a stale-base publish is deliberately overridden ("publish as branch"). The branch version exists but is not current; the row stays open until explicitly resolved (merged/withdrawn) with a note.';
COMMENT ON FUNCTION publish_revision IS
  'Transactional, per-document-serialized revision publish. content op_class enforces the expected-base check (returns stale_base instead of clobbering); metadata skips it; as_branch publishes without promoting and opens a revision_branches debt row.';
