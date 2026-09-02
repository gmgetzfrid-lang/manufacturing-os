-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 — SURF-3 (legal hold / retention at the
-- database) and SURF-4 done-when 2 (force-release is one transaction).
--
-- SURF-3: `documents.legal_hold` — the flag the BEFORE DELETE guards read —
-- was writable by every active member (documents_org_access FOR ALL, and the
-- access-change guard covers only visibility/acl/owner). A member could
-- PATCH legal_hold=false, disarming the delete guard, with no audit row
-- because logEvent lives only on the bypassed app path. retention_until /
-- disposition_state were likewise rewritable, so a record could be aged into
-- 'eligible' on demand, and disposition is an UPDATE the delete guards never
-- see. The hold-event log was member-writable too.
--
--   0. revoke_member repair — the REMOVE path's lock clear assigned jsonb to
--      a TEXT[] column (found in pre-flight after 20261042 went live).
--   1. documents retention/hold guard (BEFORE UPDATE):
--        · legal_hold, legal_hold_matter/reason/by/at — controllers only
--          (spoliation liability; the "do not destroy" flag is a controller
--          decision, as the finding's done-when states);
--        · retention_policy, retention_until, disposition_state, disposed_at
--          — controller, the document's effective owner, or a library
--          publisher (the same population that manages the record; the
--          publish-time re-clock runs under a publisher);
--        · under legal hold: disposition_state may not become 'disposed' and
--          status may not become 'Archived' — the two UPDATE-shaped
--          destructions the DELETE guards could not see;
--        · service role passes (cron re-clock, admin routes).
--   2. document_disposition_events: append-only, and an INSERT needs the same
--      authority as the hold write it records.
--   3. force_release_document(p_doc, p_reason): the session close and the
--      lock clear in ONE transaction. The existing guards (release guard,
--      DCK-2, DCK-3) still fire — auth.uid() is the caller — so authority
--      is unchanged; only atomicity is added.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. repair: revoke_member's lock clear assigns text[], not jsonb ─────────
-- 20261042 shipped `active_collaborators = '[]'::jsonb`; the column is
-- TEXT[] (schema.sql). plpgsql plans that UPDATE on every REMOVE call, so
-- every removal raised 42804 datatype_mismatch — loudly and atomically (one
-- transaction, nothing partial; suspend/restore were unaffected). Same body
-- as 20261042, one line changed; the line-diff is pinned in
-- lib/__tests__/rpPhase6Migration.test.ts. Grants persist across REPLACE.
CREATE OR REPLACE FUNCTION revoke_member(p_member_id uuid, p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member  org_members%ROWTYPE;
  v_actor   uuid := auth.uid();
  v_actor_email text;
  v_libs    jsonb := '[]'::jsonb;
  v_cols    jsonb := '[]'::jsonb;
  v_docs    jsonb := '[]'::jsonb;
  v_teams   jsonb := '[]'::jsonb;
  v_checkouts int := 0;
  v_grants  int := 0;
  r         record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'revoke_member: must be called by a signed-in member';
  END IF;
  IF p_mode NOT IN ('suspend', 'remove', 'restore') THEN
    RAISE EXCEPTION 'revoke_member: unknown mode %', p_mode;
  END IF;

  SELECT * INTO v_member FROM org_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke_member: member not found';
  END IF;
  IF v_member.uid = v_actor THEN
    RAISE EXCEPTION 'You can''t suspend or remove yourself.';
  END IF;

  -- Authority: suspend/restore = Admin or Manager (the existing UPDATE bar,
  -- and a Manager may not touch an Admin row — same rule as that policy);
  -- remove = Admin only. Both by the role COLLECTION.
  IF p_mode = 'remove' THEN
    IF NOT EXISTS (SELECT 1 FROM org_members me WHERE me.uid = v_actor AND me.org_id = v_member.org_id
                     AND me.status = 'active' AND (me.role = 'Admin' OR me.roles && ARRAY['Admin']::text[])) THEN
      RAISE EXCEPTION 'Only an Admin can remove a member from the workspace.';
    END IF;
  ELSE
    IF NOT is_org_admin_or_manager(v_member.org_id) THEN
      RAISE EXCEPTION 'Only an Admin or Manager can suspend or restore a member.';
    END IF;
    IF (v_member.role = 'Admin' OR v_member.roles && ARRAY['Admin']::text[])
       AND NOT EXISTS (SELECT 1 FROM org_members me WHERE me.uid = v_actor AND me.org_id = v_member.org_id
                         AND me.status = 'active' AND (me.role = 'Admin' OR me.roles && ARRAY['Admin']::text[])) THEN
      RAISE EXCEPTION 'Only an Admin can suspend or restore an Admin.';
    END IF;
  END IF;

  SELECT email INTO v_actor_email FROM org_members WHERE uid = v_actor AND org_id = v_member.org_id LIMIT 1;

  IF p_mode = 'restore' THEN
    UPDATE org_members SET status = 'active' WHERE id = p_member_id;
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('MEMBER_RESTORED', v_member.uid::text, 'member', v_member.org_id, v_actor, v_actor_email,
            jsonb_build_object('memberId', p_member_id, 'memberEmail', v_member.email));
    RETURN jsonb_build_object('mode', 'restore', 'uid', v_member.uid);
  END IF;

  IF p_mode = 'suspend' THEN
    -- The last-admin trigger fires here (auth.uid() is set) and refuses if
    -- this is the org's last active Admin.
    UPDATE org_members SET status = 'suspended' WHERE id = p_member_id;
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('MEMBER_SUSPENDED', v_member.uid::text, 'member', v_member.org_id, v_actor, v_actor_email,
            jsonb_build_object('memberId', p_member_id, 'memberEmail', v_member.email));
    RETURN jsonb_build_object('mode', 'suspend', 'uid', v_member.uid);
  END IF;

  -- ── remove: succession sweep FIRST (while the row still exists for the
  --    last-admin trigger to evaluate), then the delete ─────────────────────
  FOR r IN SELECT id, name FROM libraries WHERE org_id = v_member.org_id AND owner_user_id = v_member.uid LOOP
    UPDATE libraries SET owner_user_id = NULL, owner_name = NULL WHERE id = r.id;
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('OWNER_CLEARED', r.id::text, 'library', v_member.org_id, v_actor, v_actor_email,
            jsonb_build_object('reason', 'member_removed', 'formerOwner', v_member.uid, 'name', r.name));
    v_libs := v_libs || jsonb_build_object('id', r.id, 'name', r.name);
  END LOOP;
  FOR r IN SELECT id, name FROM collections WHERE org_id = v_member.org_id AND owner_user_id = v_member.uid LOOP
    UPDATE collections SET owner_user_id = NULL, owner_name = NULL WHERE id = r.id;
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('OWNER_CLEARED', r.id::text, 'collection', v_member.org_id, v_actor, v_actor_email,
            jsonb_build_object('reason', 'member_removed', 'formerOwner', v_member.uid, 'name', r.name));
    v_cols := v_cols || jsonb_build_object('id', r.id, 'name', r.name);
  END LOOP;
  FOR r IN SELECT id, COALESCE(document_number, title, name) AS name, library_id
             FROM documents WHERE org_id = v_member.org_id AND owner_user_id = v_member.uid LOOP
    UPDATE documents SET owner_user_id = NULL, owner_name = NULL WHERE id = r.id;
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('OWNER_CLEARED', r.id::text, 'document', v_member.org_id, v_actor, v_actor_email,
            jsonb_build_object('reason', 'member_removed', 'formerOwner', v_member.uid, 'name', r.name));
    v_docs := v_docs || jsonb_build_object('id', r.id, 'name', r.name, 'libraryId', r.library_id);
  END LOOP;
  FOR r IN SELECT id, name FROM teams WHERE org_id = v_member.org_id AND supervisor_user_id = v_member.uid LOOP
    UPDATE teams SET supervisor_user_id = NULL WHERE id = r.id;
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('TEAM_SUPERVISOR_CLEARED', r.id::text, 'team', v_member.org_id, v_actor, v_actor_email,
            jsonb_build_object('reason', 'member_removed', 'formerSupervisor', v_member.uid, 'name', r.name));
    v_teams := v_teams || jsonb_build_object('id', r.id, 'name', r.name);
  END LOOP;

  -- Open checkouts: end the sessions and clear the locks (the lock-column
  -- guard admits the caller — an Admin holds checkout.force_release).
  WITH ended AS (
    UPDATE checkout_sessions
       SET status = 'checked_in', ended_at = NOW(), released_at = NOW(),
           released_by = v_actor, released_reason = 'member removed from workspace'
     WHERE org_id = v_member.org_id AND user_id = v_member.uid AND status = 'active'
     RETURNING document_id
  )
  SELECT COUNT(*) INTO v_checkouts FROM ended;
  UPDATE documents
     SET checked_out_by = NULL, checked_out_by_name = NULL, checked_out_at = NULL,
         checkout_note = NULL, current_lock_id = NULL, active_collaborators = '{}'::text[]
   WHERE org_id = v_member.org_id AND checked_out_by = v_member.uid;

  -- Per-person capability grants die with the membership.
  UPDATE org_configurations
     SET data = jsonb_set(data, '{grants}',
           COALESCE((SELECT jsonb_agg(g) FROM jsonb_array_elements(data->'grants') g
                      WHERE g->>'uid' <> v_member.uid::text), '[]'::jsonb))
   WHERE org_id = v_member.org_id AND key = 'capability_policy'
     AND jsonb_typeof(data->'grants') = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'grants') g WHERE g->>'uid' = v_member.uid::text);
  GET DIAGNOSTICS v_grants = ROW_COUNT;

  -- Team and project rosters (team_members has no FK to org_members), and
  -- the member's follow subscriptions (their RLS is self-only, so only this
  -- definer path can clear them; otherwise fan-out keeps writing to a dead uid).
  DELETE FROM subscriptions WHERE org_id = v_member.org_id AND user_id = v_member.uid;
  DELETE FROM team_members WHERE org_id = v_member.org_id AND uid = v_member.uid;
  DELETE FROM project_members pm USING projects p
   WHERE pm.project_id = p.id AND p.org_id = v_member.org_id AND pm.user_id = v_member.uid;

  -- The membership itself. The last-admin trigger fires here.
  DELETE FROM org_members WHERE id = p_member_id;

  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
  VALUES ('MEMBER_REMOVED', v_member.uid::text, 'member', v_member.org_id, v_actor, v_actor_email,
          jsonb_build_object('memberId', p_member_id, 'memberEmail', v_member.email,
                             'clearedLibraries', v_libs, 'clearedCollections', v_cols,
                             'clearedDocuments', v_docs, 'clearedTeams', v_teams,
                             'endedCheckouts', v_checkouts, 'revokedGrants', v_grants));

  RETURN jsonb_build_object(
    'mode', 'remove', 'uid', v_member.uid,
    'cleared', jsonb_build_object('libraries', v_libs, 'collections', v_cols, 'documents', v_docs, 'teams', v_teams),
    'endedCheckouts', v_checkouts, 'revokedGrants', v_grants
  );
END;
$$;

-- ── 1. documents retention / legal-hold guard ───────────────────────────────
CREATE OR REPLACE FUNCTION enforce_document_retention_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hold_change boolean;
  v_ret_change  boolean;
  v_controller  boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  v_hold_change :=
       NEW.legal_hold        IS DISTINCT FROM OLD.legal_hold
    OR NEW.legal_hold_matter IS DISTINCT FROM OLD.legal_hold_matter
    OR NEW.legal_hold_reason IS DISTINCT FROM OLD.legal_hold_reason
    OR NEW.legal_hold_by     IS DISTINCT FROM OLD.legal_hold_by
    OR NEW.legal_hold_at     IS DISTINCT FROM OLD.legal_hold_at;
  v_ret_change :=
       NEW.retention_policy  IS DISTINCT FROM OLD.retention_policy
    OR NEW.retention_until   IS DISTINCT FROM OLD.retention_until
    OR NEW.disposition_state IS DISTINCT FROM OLD.disposition_state
    OR NEW.disposed_at       IS DISTINCT FROM OLD.disposed_at;

  IF NOT v_hold_change AND NOT v_ret_change
     AND NOT (OLD.legal_hold AND NEW.status IS DISTINCT FROM OLD.status) THEN
    RETURN NEW;
  END IF;

  v_controller := is_org_controller(OLD.org_id);

  IF v_hold_change AND NOT v_controller THEN
    RAISE EXCEPTION 'Legal hold can only be placed or released by an Admin or Document Controller.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_ret_change AND NOT v_controller
     AND NOT user_is_effective_owner(OLD.owner_user_id, OLD.collection_id, OLD.library_id, auth.uid())
     AND NOT user_can_publish_on_library(OLD.library_id, auth.uid()::text, OLD.org_id) THEN
    RAISE EXCEPTION 'Retention settings can only be changed by a controller, the document''s owner, or a publisher of its library.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Under a legal hold nothing is destroyed by any verb: no disposition, no
  -- archive. Release the hold first (a controller action, audited).
  IF OLD.legal_hold AND NOT (NEW.legal_hold IS DISTINCT FROM OLD.legal_hold AND NOT NEW.legal_hold) THEN
    IF NEW.disposition_state = 'disposed' AND OLD.disposition_state IS DISTINCT FROM 'disposed' THEN
      RAISE EXCEPTION 'This document is under legal hold and cannot be disposed.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'Archived' AND OLD.status IS DISTINCT FROM 'Archived' THEN
      RAISE EXCEPTION 'This document is under legal hold and cannot be archived.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_retention_guard ON documents;
CREATE TRIGGER trg_document_retention_guard
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION enforce_document_retention_guard();

-- ── 2. the hold/disposition event log is append-only and authority-gated ────
DROP POLICY IF EXISTS doc_disposition_events_insert_authority ON document_disposition_events;
CREATE POLICY doc_disposition_events_insert_authority ON document_disposition_events
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (
    is_org_controller(org_id)
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_disposition_events.document_id
               AND (user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
                    OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)))
  );
DROP POLICY IF EXISTS doc_disposition_events_no_update ON document_disposition_events;
CREATE POLICY doc_disposition_events_no_update ON document_disposition_events
  AS RESTRICTIVE FOR UPDATE USING (false);
DROP POLICY IF EXISTS doc_disposition_events_no_delete ON document_disposition_events;
CREATE POLICY doc_disposition_events_no_delete ON document_disposition_events
  AS RESTRICTIVE FOR DELETE USING (is_org_controller(org_id));

-- ── 3. force-release: one transaction ───────────────────────────────────────
CREATE OR REPLACE FUNCTION force_release_document(p_doc uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_doc      documents%ROWTYPE;
  v_actor    uuid := auth.uid();
  v_sessions int := 0;
  v_holder   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'force_release_document: must be called by a signed-in member';
  END IF;
  SELECT * INTO v_doc FROM documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'force_release_document: document % not found', p_doc;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = v_doc.org_id AND uid = v_actor AND status = 'active') THEN
    RAISE EXCEPTION 'force_release_document: not an active member of this workspace';
  END IF;
  v_holder := v_doc.checked_out_by;

  -- Authority is enforced by the existing triggers (checkout release guard,
  -- DCK-2, DCK-3): a non-holder without checkout.force_release raises here,
  -- and because this is ONE transaction, a refusal leaves BOTH the session
  -- and the lock exactly as they were.
  WITH ended AS (
    UPDATE checkout_sessions
       SET status = 'checked_in', ended_at = NOW(), released_at = NOW(),
           released_by = v_actor,
           released_reason = COALESCE(NULLIF(btrim(p_reason), ''), 'force released')
     WHERE document_id = p_doc AND status = 'active'
     RETURNING id
  )
  SELECT COUNT(*) INTO v_sessions FROM ended;

  UPDATE documents
     SET checked_out_by = NULL, checked_out_by_name = NULL, checked_out_at = NULL,
         checkout_note = NULL, current_lock_id = NULL, active_collaborators = '{}'::text[]
   WHERE id = p_doc;

  RETURN jsonb_build_object('documentId', p_doc, 'previousHolder', v_holder, 'endedSessions', v_sessions);
END;
$$;

REVOKE ALL ON FUNCTION force_release_document(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION force_release_document(uuid, text) TO authenticated;

COMMIT;

-- ── Verification (read-only) — expect true × 7 ──────────────────────────────
SELECT 'documents retention/legal-hold guard installed (BEFORE UPDATE)' AS check,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_retention_guard'
                AND tgrelid = 'documents'::regclass AND NOT tgisinternal) AS ok
UNION ALL
SELECT 'guard covers every hold and retention column',
       (SELECT prosrc LIKE '%NEW.legal_hold_at     IS DISTINCT FROM OLD.legal_hold_at%'
          AND prosrc LIKE '%NEW.disposed_at       IS DISTINCT FROM OLD.disposed_at%'
          AND prosrc LIKE '%cannot be archived%'
          FROM pg_proc WHERE proname = 'enforce_document_retention_guard')
UNION ALL
SELECT 'every guarded column exists on documents (late-bound plpgsql safety)',
       (SELECT COUNT(*) = 10 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'documents' AND column_name IN
          ('legal_hold','legal_hold_matter','legal_hold_reason','legal_hold_by','legal_hold_at',
           'retention_policy','retention_until','disposition_state','disposed_at','status'))
UNION ALL
SELECT 'disposition event log is append-only and authority-gated',
       (SELECT COUNT(*) = 3 FROM pg_policies WHERE tablename = 'document_disposition_events'
          AND policyname IN ('doc_disposition_events_insert_authority','doc_disposition_events_no_update','doc_disposition_events_no_delete')
          AND permissive = 'RESTRICTIVE')
UNION ALL
SELECT 'force_release_document exists, definer, PUBLIC revoked',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'force_release_document' AND p.prosecdef
                AND NOT has_function_privilege('public', p.oid, 'EXECUTE'))
UNION ALL
SELECT 'revoke_member repaired: lock clear assigns text[] (no jsonb into active_collaborators)',
       (SELECT prosrc LIKE '%active_collaborators = ''{}''::text[]%' AND prosrc NOT LIKE '%active_collaborators = ''[]''::jsonb%'
          FROM pg_proc WHERE proname = 'revoke_member')
UNION ALL
SELECT 'search_path pinned on both functions',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname IN ('enforce_document_retention_guard','force_release_document')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');

-- ── Inventory (read-only, aggregate) — expect small numbers ─────────────────
SELECT 'documents under legal hold' AS inventory, COUNT(*)::text AS n FROM documents WHERE legal_hold
UNION ALL
SELECT 'held documents already Archived or disposed (pre-guard residue)', COUNT(*)::text
FROM documents WHERE legal_hold AND (status = 'Archived' OR disposition_state = 'disposed')
UNION ALL
SELECT 'documents with an active checkout session but no lock (split-brain residue)', COUNT(*)::text
FROM documents d WHERE d.checked_out_by IS NULL
  AND EXISTS (SELECT 1 FROM checkout_sessions s WHERE s.document_id = d.id AND s.status = 'active');
