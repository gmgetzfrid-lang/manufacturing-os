-- 20260708_acl_rls_enforcement.sql
-- Enforce per-document / per-folder ACLs at the DATABASE layer.
--
-- Before this, RLS only checked org membership, so a direct API/DB call
-- could read a "private" document the UI would have hidden. The granular
-- model already lived in lib/acl.ts and was flattened into each node's
-- acl_index (chain-merged, so it already reflects inherited permissions).
-- This migration mirrors that decision in SQL.
--
-- FAIL-SAFE by design (chosen to avoid lockouts):
--   * visibility 'normal' / NULL  -> always visible to org members
--   * Admin / DocCtrl             -> always visible
--   * visibility 'private'/'hidden' -> visible only with an explicit grant
--     (user, role, or team) in acl_index.allow, and not explicitly denied.
-- Added as RESTRICTIVE SELECT policies so they AND with the existing
-- permissive org policies (a row must pass BOTH). Writes are unchanged.

-- Does a subject (uid / role / any team) appear anywhere in an allow/deny
-- bucket's action lists?  acl_index bucket shape:
--   { users: {action: [uid,...]}, roles: {...}, teams: {...}, orgs: {...} }
CREATE OR REPLACE FUNCTION acl_subject_in_bucket(
  p_bucket   jsonb,
  p_uid      text,
  p_role     text,
  p_team_ids text[]
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT
    -- user named in any action list
    COALESCE((SELECT bool_or(e.value ? p_uid)
              FROM jsonb_each(COALESCE(p_bucket->'users', '{}'::jsonb)) e), false)
    -- role named in any action list
    OR (p_role IS NOT NULL AND COALESCE((SELECT bool_or(e.value ? p_role)
              FROM jsonb_each(COALESCE(p_bucket->'roles', '{}'::jsonb)) e), false))
    -- any of the user's teams named in any action list
    OR (p_team_ids IS NOT NULL AND array_length(p_team_ids, 1) > 0
        AND COALESCE((SELECT bool_or(EXISTS (
              SELECT 1 FROM unnest(p_team_ids) t WHERE e.value ? t))
              FROM jsonb_each(COALESCE(p_bucket->'teams', '{}'::jsonb)) e), false));
$$;

-- Is a node visible to the current user given its visibility + acl_index?
CREATE OR REPLACE FUNCTION node_visible(
  p_visibility text,
  p_acl_index  jsonb,
  p_org        uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_uid   text := auth.uid()::text;
  v_role  text;
  v_teams text[];
BEGIN
  -- Fail-safe: normal/unset visibility is open to org members.
  IF p_visibility IS NULL OR p_visibility = 'normal' THEN
    RETURN true;
  END IF;

  -- Controllers always see everything.
  SELECT role INTO v_role FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;
  IF v_role IN ('Admin', 'DocCtrl') THEN
    RETURN true;
  END IF;

  -- Restricted with no grant table -> only controllers (already returned).
  IF p_acl_index IS NULL THEN
    RETURN false;
  END IF;

  -- Explicit deny of read/discover wins.
  IF (p_acl_index->'deny'->'users'->'read') ? v_uid
     OR (p_acl_index->'deny'->'users'->'discover') ? v_uid THEN
    RETURN false;
  END IF;

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid = auth.uid();

  -- Any allow grant (any action) lets the row through; finer read-vs-
  -- discover distinctions stay in the app layer.
  RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams);
END;
$$;

-- Restrictive SELECT policies (AND with the permissive org policies).
DROP POLICY IF EXISTS documents_acl_select ON documents;
CREATE POLICY documents_acl_select ON documents AS RESTRICTIVE FOR SELECT
  USING (node_visible(visibility, acl_index, org_id));

DROP POLICY IF EXISTS collections_acl_select ON collections;
CREATE POLICY collections_acl_select ON collections AS RESTRICTIVE FOR SELECT
  USING (node_visible(visibility, acl_index, org_id));
