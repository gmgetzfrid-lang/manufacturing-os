-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 5 — OWN-3 / DEC-2, the LAST of the five sites:
-- node_visible, which gates ALL document read visibility. Landed separately
-- from 20261040 on the decision's instruction ("land it last and separately").
--
-- Body from 20261037 (the 6-arg ownership form) with two changes:
--   · the controller short-circuit routes through is_org_controller (the
--     additive helper) instead of the headline `role`;
--   · the allow-bucket role match evaluates EVERY held role (CHAIN-1/ADD-1),
--     not only the headline — an allow naming an additively-held role grants.
-- The ownership branch, the deny-of-read/discover check, the team match and
-- the 3-arg delegating wrapper are untouched (the wrapper needs no change: it
-- delegates to this body). Fail-safe ordering is preserved: normal/unset
-- visibility still returns true first.
--
-- WIDENS read visibility for the same inventory population as 20261040
-- (members holding Admin/DocCtrl additively) plus members whose read grant
-- names an additively-held role.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION node_visible(
  p_visibility text,
  p_acl_index  jsonb,
  p_org        uuid,
  p_owner      uuid,
  p_collection uuid,
  p_library    uuid
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   text := auth.uid()::text;
  v_role  text;
  v_roles text[];
  v_teams text[];
BEGIN
  -- Fail-safe: normal/unset visibility is open to org members.
  IF p_visibility IS NULL OR p_visibility = 'normal' THEN
    RETURN true;
  END IF;

  -- Controllers always see everything. OWN-3/DEC-2: the controller tier is a
  -- property of the role COLLECTION (is_org_controller: role IN (...) OR
  -- roles && ARRAY[...]), so an additively-held DocCtrl sees a private library.
  IF is_org_controller(p_org) THEN
    RETURN true;
  END IF;
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles FROM org_members
    WHERE uid = auth.uid() AND org_id = p_org AND status = 'active' LIMIT 1;
  IF v_role IS NOT NULL AND NOT (v_role = ANY(COALESCE(v_roles, '{}'::text[]))) THEN
    v_roles := array_append(v_roles, v_role);
  END IF;

  -- GAP-15/DEC-7: ownership carries read access. Placed after the controller
  -- short-circuit and before the acl_index check (the decision's ordering —
  -- an owner outranks a stray deny of their own document). The cascade
  -- (document → folder → library → team supervisor) is the same SECURITY
  -- DEFINER function the publish guard trusts, so no recursion.
  IF user_is_effective_owner(p_owner, p_collection, p_library, auth.uid()) THEN
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
  -- discover distinctions stay in the app layer. CHAIN-1/ADD-1: a role
  -- subject matches ANY held role, not only the headline.
  RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams)
      OR (v_roles IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(v_roles) r
             WHERE acl_subject_in_bucket(p_acl_index->'allow', v_uid, r, NULL::text[])));
END;
$$;


COMMIT;

-- ── Verification (read-only) — expect true × 4 ──────────────────────────────
SELECT 'node_visible (6-arg) controller tier is additive' AS check,
       (SELECT prosrc LIKE '%is_org_controller(p_org)%'
          AND prosrc NOT LIKE '%IF v_role IN (''Admin'', ''DocCtrl'')%'
          FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6) AS ok
UNION ALL
SELECT 'ownership branch still present, still after the controller check',
       (SELECT position('is_org_controller(p_org)' in prosrc) < position('user_is_effective_owner(p_owner' in prosrc)
          FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6)
UNION ALL
SELECT 'allow-bucket role match evaluates every held role',
       (SELECT prosrc LIKE '%FROM unnest(v_roles) r%'
          FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6)
UNION ALL
SELECT 'search_path pinned on both node_visible forms',
       (SELECT COUNT(*) = 2 FROM pg_proc
         WHERE proname = 'node_visible' AND pronargs IN (3, 6)
           AND array_to_string(proconfig, ',') LIKE '%search_path=public%');
