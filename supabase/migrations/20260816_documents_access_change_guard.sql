-- 20260816_documents_access_change_guard.sql
--
-- Phase 2 (finding C2, the UPDATE "unhide" vector): stop a non-privileged
-- member from changing a document's visibility / acl / acl_index directly via
-- PostgREST to expose a private document. RLS's restrictive ACL overlay only
-- guards SELECT, and the permissive org policy allows any member to UPDATE, so
-- a member could flip a private doc to 'normal' (or grant themselves in
-- acl_index) even for a doc they cannot see.
--
-- This mirrors the app's own authorization (lib/permissions.ts + lib/acl.ts):
-- a visibility/ACL change is allowed for
--   * document controllers (Admin/DocCtrl), OR
--   * a member with a managePermissions/admin grant on the node's acl_index, OR
--   * any member when the node is currently un-restricted ('normal', no ACL) —
--     matching canWithAclChain's defaultAllow for nodes without an ACL.
-- Everything else (a member with no manage grant touching a restricted doc)
-- is rejected. Only real end users are checked; service-role / superuser
-- contexts (auth.uid() IS NULL) — restore, admin routes — are exempt.
--
-- NOTE: this is the most intricate policy in the remediation (it replicates
-- ACL-manage evaluation in SQL). It is written to match the code, but it is
-- the one change worth a quick in-app sanity check after applying: editing a
-- document's sharing as a controller / grant-holder still works; a plain
-- member cannot flip visibility via the API.
--
-- Rollback: DROP TRIGGER documents_guard_access ON documents;

-- Is the current user (uid/role/teams/org) named in a specific action list of
-- an acl_index bucket ('allow' or 'deny')? acl_index shape (lib/acl.ts):
--   { allow|deny: { users|roles|teams|orgs: { <action>: [ids...] } } }
CREATE OR REPLACE FUNCTION acl_subject_has_action(
  p_bucket jsonb, p_action text,
  p_uid text, p_role text, p_team_ids text[], p_org text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE((p_bucket->'users'->p_action) ? p_uid, false)
    OR (p_role IS NOT NULL AND COALESCE((p_bucket->'roles'->p_action) ? p_role, false))
    OR (p_team_ids IS NOT NULL AND array_length(p_team_ids, 1) > 0
        AND EXISTS (SELECT 1 FROM unnest(p_team_ids) t WHERE COALESCE((p_bucket->'teams'->p_action) ? t, false)))
    OR (p_org IS NOT NULL AND COALESCE((p_bucket->'orgs'->p_action) ? p_org, false));
$$;

-- Can the current user manage access on a node with this acl_index? Controller
-- OR an admin/managePermissions allow-grant not overridden by a matching deny.
-- Returns false for a NULL acl_index (the caller handles the default-open case).
CREATE OR REPLACE FUNCTION can_manage_node(p_acl_index jsonb, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_uid   text := auth.uid()::text;
  v_role  text;
  v_teams text[];
  v_allow jsonb;
  v_deny  jsonb;
  v_org   text := p_org::text;
BEGIN
  IF is_org_controller(p_org) THEN RETURN true; END IF;
  IF p_acl_index IS NULL THEN RETURN false; END IF;

  SELECT role INTO v_role FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;
  IF v_role IS NULL THEN RETURN false; END IF;  -- not an active member of this org
  SELECT array_agg(team_id::text) INTO v_teams FROM team_members WHERE uid = auth.uid();

  v_allow := p_acl_index->'allow';
  v_deny  := p_acl_index->'deny';

  -- 'admin' allow wins unless 'admin' denied (matches acl.ts can()).
  IF acl_subject_has_action(v_allow, 'admin', v_uid, v_role, v_teams, v_org)
     AND NOT acl_subject_has_action(v_deny, 'admin', v_uid, v_role, v_teams, v_org) THEN
    RETURN true;
  END IF;
  -- 'managePermissions' allow unless denied.
  IF acl_subject_has_action(v_allow, 'managePermissions', v_uid, v_role, v_teams, v_org)
     AND NOT acl_subject_has_action(v_deny, 'managePermissions', v_uid, v_role, v_teams, v_org) THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION documents_guard_access_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_guard_access ON documents;
CREATE TRIGGER documents_guard_access
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_guard_access_change();
