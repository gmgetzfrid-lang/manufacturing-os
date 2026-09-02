-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 — SURF-1 / DEC-20 + GAP-5 / OWN-12 together:
-- a member can actually be revoked, and revocation carries owner succession.
--
-- Before: org_members had NO DELETE policy (20260817 replaced the FOR ALL
-- policy with INSERT + UPDATE only), so the admin UI's delete matched zero
-- rows and returned success — the ex-employee kept full access. Nothing ever
-- wrote status = 'suspended'. Both revocation doors were shut. Ownership,
-- meanwhile, was a dangling uuid: user_is_effective_owner never checked
-- membership, so a departed owner stayed the effective owner and every
-- "owner OR controllers" notification router suppressed the controller
-- fallback because it keyed on the owner EXISTING, not being reachable.
--
-- DEC-20: both paths — suspend (non-destructive, the UI default) and remove
-- (destructive, behind confirmation). GAP-5: ownership resolution requires an
-- ACTIVE membership at every level (fall-through, never silent reassignment);
-- removal clears what they owned, audits each scope, and the UI notifies the
-- controllers with the list. Also DEC-20's `my_team_ids` fix: a suspended
-- member's team-derived grants stop applying.
--
--   1. org_members DELETE policy — Admin (by collection) only.
--   2. my_team_ids() — only ACTIVE memberships contribute team ids.
--   3. user_is_effective_owner — membership-aware fall-through (mirrors the
--      app's resolveEffectiveOwner(…, activeUids)).
--   4. revoke_member(p_member_id, p_mode) — the ONE revocation entry point:
--      authority, self-guard, the status write or delete (the last-admin
--      trigger still fires: auth.uid() is set), and on REMOVE the succession
--      sweep with one audit row per cleared scope. Returns a JSON summary.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. hard removal is an Admin action ──────────────────────────────────────
DROP POLICY IF EXISTS org_members_delete ON org_members;
CREATE POLICY org_members_delete ON org_members
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM org_members me
      WHERE me.uid = auth.uid() AND me.org_id = org_members.org_id AND me.status = 'active'
        AND (me.role = 'Admin' OR me.roles && ARRAY['Admin']::text[])
    )
    AND org_members.uid <> auth.uid()
  );

-- ── 2. team grants follow ACTIVE membership ─────────────────────────────────
CREATE OR REPLACE FUNCTION my_team_ids()
RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT tm.team_id
  FROM team_members tm
  JOIN org_members m ON m.uid = tm.uid AND m.org_id = tm.org_id AND m.status = 'active'
  WHERE tm.uid = auth.uid();
$$;

-- ── 3. ownership requires an active membership at every level ───────────────
CREATE OR REPLACE FUNCTION user_is_effective_owner(p_doc_owner uuid, p_collection uuid, p_library uuid, p_uid uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_team  uuid;
  v_org   uuid;
BEGIN
  IF p_uid IS NULL THEN RETURN false; END IF;

  -- The org is the library's (documents and folders inherit it).
  IF p_library IS NOT NULL THEN
    SELECT org_id INTO v_org FROM libraries WHERE id = p_library;
  END IF;

  -- GAP-5 / OWN-12: an owner who is not an ACTIVE member of the org is
  -- skipped and resolution falls through to the next level — never a silent
  -- reassignment, never a departed owner keeping authority.
  IF p_doc_owner IS NOT NULL AND member_is_active(v_org, p_doc_owner) THEN
    RETURN p_doc_owner = p_uid;
  END IF;
  IF p_collection IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner FROM collections WHERE id = p_collection;
    IF v_owner IS NOT NULL AND member_is_active(v_org, v_owner) THEN RETURN v_owner = p_uid; END IF;
  END IF;
  IF p_library IS NOT NULL THEN
    SELECT owner_user_id, owner_team_id INTO v_owner, v_team FROM libraries WHERE id = p_library;
    IF v_owner IS NOT NULL AND member_is_active(v_org, v_owner) THEN RETURN v_owner = p_uid; END IF;
    IF v_team IS NOT NULL THEN                         -- team-owned library → its supervisor
      SELECT supervisor_user_id INTO v_owner FROM teams WHERE id = v_team;
      IF v_owner IS NOT NULL AND member_is_active(v_org, v_owner) THEN RETURN v_owner = p_uid; END IF;
    END IF;
  END IF;
  RETURN false;
END;
$$;

-- Helper: is p_uid an active member of p_org? When the org is unknown (a
-- caller that passed no library), membership is checked across orgs — the
-- owner columns are bare uuids, so this is the safest available test.
CREATE OR REPLACE FUNCTION member_is_active(p_org uuid, p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = p_uid AND status = 'active' AND (p_org IS NULL OR org_id = p_org)
  );
$$;

-- ── 4. the revocation entry point ───────────────────────────────────────────
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
         checkout_note = NULL, current_lock_id = NULL, active_collaborators = '[]'::jsonb
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

REVOKE ALL ON FUNCTION revoke_member(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_member(uuid, text) TO authenticated;

COMMIT;

-- ── Verification (read-only) — expect true × 7 ──────────────────────────────
SELECT 'org_members has a DELETE policy (Admin, by collection)' AS check,
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'org_members' AND policyname = 'org_members_delete'
                AND cmd = 'DELETE' AND qual LIKE '%ARRAY[''Admin'']%') AS ok
UNION ALL
SELECT 'my_team_ids requires an active membership',
       (SELECT prosrc LIKE '%m.status = ''active''%' FROM pg_proc WHERE proname = 'my_team_ids')
UNION ALL
SELECT 'user_is_effective_owner is membership-aware at every level',
       (SELECT (LENGTH(prosrc) - LENGTH(REPLACE(prosrc, 'member_is_active(', ''))) / LENGTH('member_is_active(') = 4
          FROM pg_proc WHERE proname = 'user_is_effective_owner')
UNION ALL
SELECT 'revoke_member exists, executes as definer, PUBLIC revoked',
       EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'revoke_member' AND p.prosecdef
                AND NOT has_function_privilege('public', p.oid, 'EXECUTE'))
UNION ALL
SELECT 'revoke_member sweeps ownership, supervision, checkouts, grants, rosters',
       (SELECT prosrc LIKE '%OWNER_CLEARED%' AND prosrc LIKE '%TEAM_SUPERVISOR_CLEARED%'
          AND prosrc LIKE '%checkout_sessions%' AND prosrc LIKE '%capability_policy%'
          AND prosrc LIKE '%DELETE FROM team_members%' AND prosrc LIKE '%DELETE FROM project_members%'
          AND prosrc LIKE '%DELETE FROM subscriptions%'
          FROM pg_proc WHERE proname = 'revoke_member')
UNION ALL
SELECT 'search_path pinned on all four functions',
       (SELECT COUNT(*) = 4 FROM pg_proc
         WHERE proname IN ('my_team_ids', 'user_is_effective_owner', 'member_is_active', 'revoke_member')
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%')
UNION ALL
-- plpgsql late-binds every column revoke_member and user_is_effective_owner
-- touch, so a column missing live would only surface as a runtime error on
-- the first revocation. Prove all 63 exist now (same lesson as 20261038).
SELECT 'every column the revocation sweep late-binds exists',
       (SELECT COUNT(*) = 63 FROM information_schema.columns c
          JOIN (VALUES
            ('org_members','id'), ('org_members','uid'), ('org_members','org_id'), ('org_members','status'),
            ('org_members','role'), ('org_members','roles'), ('org_members','email'),
            ('audit_logs','action'), ('audit_logs','resource_id'), ('audit_logs','resource_type'),
            ('audit_logs','org_id'), ('audit_logs','user_id'), ('audit_logs','user_email'), ('audit_logs','details'),
            ('libraries','id'), ('libraries','name'), ('libraries','org_id'), ('libraries','owner_user_id'),
            ('libraries','owner_name'), ('libraries','owner_team_id'),
            ('collections','id'), ('collections','name'), ('collections','org_id'), ('collections','owner_user_id'),
            ('collections','owner_name'),
            ('documents','id'), ('documents','document_number'), ('documents','title'), ('documents','name'),
            ('documents','library_id'), ('documents','org_id'), ('documents','owner_user_id'), ('documents','owner_name'),
            ('documents','checked_out_by'), ('documents','checked_out_by_name'), ('documents','checked_out_at'),
            ('documents','checkout_note'), ('documents','current_lock_id'), ('documents','active_collaborators'),
            ('teams','id'), ('teams','name'), ('teams','org_id'), ('teams','supervisor_user_id'),
            ('checkout_sessions','org_id'), ('checkout_sessions','user_id'), ('checkout_sessions','status'),
            ('checkout_sessions','ended_at'), ('checkout_sessions','released_at'), ('checkout_sessions','released_by'),
            ('checkout_sessions','released_reason'), ('checkout_sessions','document_id'),
            ('org_configurations','org_id'), ('org_configurations','key'), ('org_configurations','data'),
            ('subscriptions','org_id'), ('subscriptions','user_id'),
            ('team_members','org_id'), ('team_members','uid'), ('team_members','team_id'),
            ('project_members','project_id'), ('project_members','user_id'),
            ('projects','id'), ('projects','org_id')
          ) v(t, col) ON c.table_schema = 'public' AND c.table_name = v.t AND c.column_name = v.col);

-- ── Inventory (read-only, aggregate) — what the membership-aware resolver
--    starts routing to controllers, and what removal will have to sweep.
SELECT 'libraries owned by a non-active or non-member uid' AS inventory, COUNT(*)::text AS n
FROM libraries l WHERE l.owner_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = l.org_id AND m.uid = l.owner_user_id AND m.status = 'active')
UNION ALL
SELECT 'folders owned by a non-active or non-member uid', COUNT(*)::text
FROM collections c WHERE c.owner_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = c.org_id AND m.uid = c.owner_user_id AND m.status = 'active')
UNION ALL
SELECT 'documents owned by a non-active or non-member uid', COUNT(*)::text
FROM documents d WHERE d.owner_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = d.org_id AND m.uid = d.owner_user_id AND m.status = 'active')
UNION ALL
SELECT 'teams whose supervisor is not an active member', COUNT(*)::text
FROM teams t WHERE t.supervisor_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid = t.supervisor_user_id AND m.status = 'active')
UNION ALL
SELECT 'members currently suspended/inactive/invited', COUNT(*)::text
FROM org_members WHERE status <> 'active';
