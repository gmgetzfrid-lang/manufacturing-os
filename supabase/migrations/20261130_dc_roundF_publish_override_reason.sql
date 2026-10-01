-- ─────────────────────────────────────────────────────────────────────────────
-- 20261130_dc_roundF_publish_override_reason.sql
--
-- document-control Round F wave 2 — P3 LIFECYCLE: DCK-8. The transactional
-- publish's lock check was switched off by a client-supplied boolean.
--
-- publish_revision is the last server-side place the checkout lock is
-- checked. Its test was `NOT (p_override_lock OR (p_force AND
-- v_is_controller))`: p_force is re-derived against org_members, but
-- p_override_lock was a plain DEFAULT FALSE parameter nobody validated — no
-- reason, no eligibility test, no record. A direct POST /rpc/publish_revision
-- with p_override_lock:true published over another user's checkout and left
-- no trace (the app's reason rule and holder notification live in the
-- browser).
--
-- WHAT (one function, re-created from its NEWEST body — 20261105, projects
-- Round G J1, which carries the 'superseded' revert-target word; everything
-- else in the body is byte-identical, proven by
-- lib/__tests__/dcRoundFLifecycleMigration.test.ts's lineDiff):
--   · a new trailing parameter p_override_reason TEXT DEFAULT NULL. An
--     override (p_override_lock) now REQUIRES it (>= 5 characters after
--     trim) — the override cannot be asserted without stating why;
--   · override eligibility is RE-DERIVED here: the controller tier (already
--     read from org_members), publish authority on the document's library
--     (user_can_publish_on_library) or effective ownership
--     (user_is_effective_owner) — the same population the publish guard
--     admits. A caller's boolean is no longer the decision;
--   · the function RECORDS every pass of a foreign lock (override or
--     controller force) itself: one audit_logs row, REV_LOCK_OVERRIDDEN, in
--     the same transaction as the publish, carrying the holder, the reason,
--     the new version and whether it went in as a branch;
--   · the 11-argument signature is DROPPED before the 12-argument one is
--     created (CREATE OR REPLACE with a new parameter would leave an
--     overload that PostgREST cannot choose between). Grants are restated
--     for the new signature: authenticated + service_role, never PUBLIC —
--     and never anon, revoked explicitly: a freshly CREATEd function picks
--     up the schema's default grants, and an anon caller has no auth.uid(),
--     which this function reads as a service-role call that may NAME its
--     actor.
--
-- Callers: lib/revisions.ts (revUpDocument, revertToVersion) name
-- p_override_reason ONLY when they pass p_override_lock, so an ordinary
-- publish is the same call on either side of this paste; the intake door
-- (app/api/intake/upload/route.ts) never overrides a lock (a checked-out
-- document demotes its submission to review) and is unchanged.
--
-- DEPLOY ORDER: paste this BEFORE the wave-2 app deploys. Until it is
-- pasted, a publish over another user's checkout is refused by the app with
-- "needs migration 20261130" (the named argument does not exist yet) —
-- nothing is published unguarded. ⚠ Do not re-paste 20261105 or an earlier
-- publish_revision migration after this one: it would re-create the
-- 11-argument overload. If that happens, re-run THIS file (its DROP removes
-- it).
--
-- NOT a widening: every change refuses something that was allowed. The
-- inventory (DEC-30, aggregate counts, before the transaction) is the
-- population a publish-over-checkout now needs a stated reason for.
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
DROP TABLE IF EXISTS dc_round_f_130_before;
CREATE TEMP TABLE dc_round_f_130_before AS
SELECT 'inventory (before apply): documents checked out right now (publishing over one of these now takes a stated reason, recorded by the database)' AS inventory,
       COUNT(*)::text AS n
  FROM documents WHERE checked_out_by IS NOT NULL
UNION ALL
SELECT 'inventory (before apply): publish_revision signatures present (expect 1 — the 11-argument form this paste replaces)',
       COUNT(*)::text
  FROM pg_proc WHERE proname = 'publish_revision';

BEGIN;

-- The 11-argument form (20261049 → 20261105) goes first: the new trailing
-- parameter would otherwise create an overload beside it.
DROP FUNCTION IF EXISTS publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean);

-- ── publish_revision: 20261105 body + the DCK-8 override rules ─────────────
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
  p_override_lock BOOLEAN DEFAULT FALSE,
  p_override_reason TEXT DEFAULT NULL
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
  v_lock_via TEXT;
  v_lock_holder TEXT;
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

  -- DCK-8: passing another user's checkout is an ACT — asserted with its
  -- reason, by someone eligible, and recorded below. A controller's explicit
  -- force (p_force, the controller tier re-derived from org_members above)
  -- passes the lock as before. Any other override must carry
  -- p_override_reason (at least 5 characters) and publish authority on this
  -- library or effective ownership of the document — re-derived here, never
  -- trusted from the caller's boolean.
  IF v_doc.checked_out_by IS NOT NULL
     AND v_doc.checked_out_by::text <> p_actor::text THEN
    IF p_force AND v_is_controller THEN
      v_lock_via := 'force';
    ELSIF p_override_lock THEN
      IF length(btrim(COALESCE(p_override_reason, ''))) < 5 THEN
        RAISE EXCEPTION 'publish_revision: publishing over another user''s checkout needs a reason (at least 5 characters); it is shown to them and recorded.'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NOT v_is_controller
         AND NOT user_can_publish_on_library(v_doc.library_id, p_actor::text, v_doc.org_id)
         AND NOT user_is_effective_owner(v_doc.owner_user_id, v_doc.collection_id, v_doc.library_id, p_actor) THEN
        RAISE EXCEPTION 'publish_revision: only a publisher on this library (or the document''s owner) may publish over another user''s checkout.'
          USING ERRCODE = 'check_violation';
      END IF;
      v_lock_via := 'override';
    ELSE
      RETURN jsonb_build_object(
        'status', 'locked_by_other',
        'holder_name', v_doc.checked_out_by_name
      );
    END IF;
    v_lock_holder := v_doc.checked_out_by::text;
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
          AND (COALESCE(t.review_state, '') IN ('in_review', 'rejected', 'superseded')
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

  -- DCK-8: the override is on the document's record in the same
  -- transaction, whether or not the caller went through the app (which also
  -- tells the holder on their episode thread).
  IF v_lock_via IS NOT NULL THEN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('REV_LOCK_OVERRIDDEN', p_doc::text, 'document', v_doc.org_id, p_actor,
            (SELECT m.email FROM org_members m WHERE m.org_id = v_doc.org_id AND m.uid = p_actor LIMIT 1),
            jsonb_build_object(
              'via', v_lock_via,
              'holder', v_lock_holder,
              'holderName', v_doc.checked_out_by_name,
              'reason', NULLIF(btrim(COALESCE(p_override_reason, '')), ''),
              'versionId', v_new_id,
              'revisionLabel', btrim(v_label),
              'branch', p_as_branch
            ));
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
  'Transactional, per-document-serialized revision publish. The acting identity is derived from auth.uid() (p_actor honored only on service-role calls). content op_class enforces the expected-base check, the drawing-class MOC gate (DCK-1) and the revert-target gate (REV-2; in-review, rejected and superseded submissions are never targets); a branch insert carries the same publish-authority bar as a promote (OWN-5). p_override_lock = a publisher''s checkout-override: passes the lock, never a hold, and only with p_override_reason (>= 5 chars) from an actor with publish authority or effective ownership, recorded as REV_LOCK_OVERRIDDEN (DCK-8); p_force = controller-only emergency bypass, also recorded when it passes a lock.';

REVOKE ALL ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
-- Probes: ok = true × 6. Inventory rows: n = the aggregate count.
SELECT 'publish_revision has exactly one signature: the 12-argument form with p_override_reason (the 11-argument overload is gone)' AS check,
       (SELECT COUNT(*) = 1 FROM pg_proc WHERE proname = 'publish_revision')
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'publish_revision' AND pronargs = 12
                    AND 'p_override_reason' = ANY (proargnames)) AS ok,
       NULL::text AS n
UNION ALL SELECT 'an override needs a stated reason and an eligible actor (publish authority or effective ownership), re-derived in the function',
       (SELECT prosrc LIKE '%ELSIF p_override_lock THEN%'
               AND prosrc LIKE '%length(btrim(COALESCE(p_override_reason, ''''))) < 5%'
               AND prosrc LIKE '%AND NOT user_can_publish_on_library(v_doc.library_id, p_actor::text, v_doc.org_id)%'
               AND prosrc LIKE '%AND NOT user_is_effective_owner(v_doc.owner_user_id, v_doc.collection_id, v_doc.library_id, p_actor) THEN%'
               AND prosrc NOT LIKE '%NOT (p_override_lock OR (p_force AND v_is_controller))%'
          FROM pg_proc WHERE proname = 'publish_revision'), NULL
UNION ALL SELECT 'every pass of a foreign lock is recorded by the function itself (REV_LOCK_OVERRIDDEN, same transaction)',
       (SELECT prosrc LIKE '%INSERT INTO audit_logs%'
               AND prosrc LIKE '%REV_LOCK_OVERRIDDEN%'
               AND prosrc LIKE '%IF v_lock_via IS NOT NULL THEN%'
          FROM pg_proc WHERE proname = 'publish_revision'), NULL
UNION ALL SELECT 'the rest of the contract survived the re-create (stale base, MOC gate, revert-target gate with superseded, branch authority, session-derived actor)',
       (SELECT prosrc LIKE '%''status'', ''stale_base''%'
               AND prosrc LIKE '%PSM requires an MOC reference%'
               AND prosrc LIKE '%IN (''in_review'', ''rejected'', ''superseded'')%'
               AND prosrc LIKE '%branches included%'
               AND prosrc LIKE '%p_actor does not match the calling session%'
               AND prosrc LIKE '%NULLIF(p_version->>''related_ticket_id'','''')::uuid%'
          FROM pg_proc WHERE proname = 'publish_revision'), NULL
UNION ALL SELECT 'publish_revision is SECURITY DEFINER with search_path pinned',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'publish_revision'), NULL
UNION ALL SELECT 'authenticated and service_role may execute publish_revision; PUBLIC and anon may not',
       has_function_privilege('authenticated', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE')
       AND NOT has_function_privilege('public', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'publish_revision(uuid, uuid, text, jsonb, uuid, text, boolean, boolean, text, text, boolean, text)', 'EXECUTE'), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM dc_round_f_130_before;
