-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — OWN-18: an org-subject publish grant works
-- everywhere or nowhere. It now works everywhere.
--
-- The permission drawer offers "Org" as a subject type, lib/acl.ts matches it
-- (case "org"), buildAclIndexFromRules writes it into acl_index.allow.orgs,
-- and acl_subject_has_action / can_manage_node honour the bucket for admin
-- and managePermissions. Only the two PUBLISH evaluators ignored it:
-- canPublishViaIndex (app) and user_can_publish_on_library (here) — so
-- "grant publish to everyone in the org" lit the button and refused the
-- click. Per DEC-2's shape (route the strict checks onto the shared
-- semantics, inventory first), user_can_publish_on_library gains the org
-- arms — deny-publish, deny-admin and allow (publish | admin-unless-denied)
-- — keyed by p_org, mirroring the users / roles / teams arms line for line.
-- The app evaluator changes in the same commit; a shape test line-diffs this
-- body against the live 20261046 one (only the org lines differ).
--
-- WIDENING: a library that already carries an org-subject publish/admin
-- allow grant goes live for every active member of its org on apply. The
-- pre-apply inventory is captured into a temp table BEFORE the DDL (DEC-2)
-- and printed with the probes in the single final result set.
--
-- Single paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text): probes carry `ok`, inventory rows carry
-- `n`. The editor shows only that last result set.
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _rp_e59_before AS
SELECT 'libraries carrying an org-subject publish or admin allow grant (goes live)' AS what, COUNT(*) AS n
  FROM libraries
 WHERE (jsonb_typeof(acl_index->'allow'->'orgs'->'publish') = 'array' AND jsonb_array_length(acl_index->'allow'->'orgs'->'publish') > 0)
    OR (jsonb_typeof(acl_index->'allow'->'orgs'->'admin') = 'array' AND jsonb_array_length(acl_index->'allow'->'orgs'->'admin') > 0)
UNION ALL
SELECT 'active members of the orgs those libraries belong to (population gaining publish)', COUNT(*)
  FROM org_members m
 WHERE m.status = 'active'
   AND m.org_id IN (SELECT l.org_id FROM libraries l
                     WHERE (jsonb_typeof(l.acl_index->'allow'->'orgs'->'publish') = 'array' AND jsonb_array_length(l.acl_index->'allow'->'orgs'->'publish') > 0)
                        OR (jsonb_typeof(l.acl_index->'allow'->'orgs'->'admin') = 'array' AND jsonb_array_length(l.acl_index->'allow'->'orgs'->'admin') > 0))
UNION ALL
SELECT 'libraries carrying an org-subject publish or admin DENY (binds on apply)', COUNT(*)
  FROM libraries
 WHERE (jsonb_typeof(acl_index->'deny'->'orgs'->'publish') = 'array' AND jsonb_array_length(acl_index->'deny'->'orgs'->'publish') > 0)
    OR (jsonb_typeof(acl_index->'deny'->'orgs'->'admin') = 'array' AND jsonb_array_length(acl_index->'deny'->'orgs'->'admin') > 0);

BEGIN;

-- ── OWN-18: org arms on the publish evaluator (body from 20261046) ──────────
CREATE OR REPLACE FUNCTION user_can_publish_on_library(p_library uuid, p_uid text, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role  text;
  v_roles text[];
  v_teams text[];
  v_idx   jsonb;
  v_admin_denied boolean;
BEGIN
  IF p_library IS NULL OR p_uid IS NULL OR p_org IS NULL THEN
    RETURN false;
  END IF;

  -- The member's FULL role collection (headline ∪ additive), never empty
  -- for an active member.
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
    FROM org_members
   WHERE org_id = p_org AND uid::text = p_uid AND status = 'active'
   LIMIT 1;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  IF NOT (v_role = ANY(v_roles)) THEN
    v_roles := array_append(v_roles, v_role);
  END IF;

  -- OWN-3/DEC-2: the broad controller tier follows the COLLECTION.
  IF v_roles && ARRAY['Admin','DocCtrl']::text[] THEN
    RETURN true;
  END IF;

  SELECT acl_index INTO v_idx FROM libraries WHERE id = p_library;
  IF v_idx IS NULL THEN
    RETURN false;   -- no grants recorded -> only controllers publish
  END IF;

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid::text = p_uid AND org_id = p_org;

  -- Explicit deny of publish wins (user / ANY held role / team / org).
  IF COALESCE((v_idx->'deny'->'users'->'publish') ? p_uid, false)
     OR EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE (v_idx->'deny'->'roles'->'publish') ? r)
     OR COALESCE(v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'publish') ? t), false)
     OR COALESCE((v_idx->'deny'->'orgs'->'publish') ? p_org::text, false)
  THEN
    RETURN false;
  END IF;

  -- OWN-8 / DEC-8: an 'admin' allow grants publish only when 'admin' is not
  -- itself explicitly denied (user / ANY held role / team) — the app's
  -- evaluators apply the same order.
  v_admin_denied :=
       COALESCE((v_idx->'deny'->'users'->'admin') ? p_uid, false)
    OR EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE (v_idx->'deny'->'roles'->'admin') ? r)
    OR COALESCE(v_teams IS NOT NULL AND EXISTS (
         SELECT 1 FROM unnest(v_teams) t WHERE (v_idx->'deny'->'teams'->'admin') ? t), false)
    OR COALESCE((v_idx->'deny'->'orgs'->'admin') ? p_org::text, false);

  -- Allowed if granted "publish" OR (not admin-denied and granted "admin") to
  -- the user, ANY held role, a team, or the org.
  RETURN COALESCE(
       (v_idx->'allow'->'users'->'publish') ? p_uid
    OR (NOT v_admin_denied AND (v_idx->'allow'->'users'->'admin') ? p_uid)
    OR EXISTS (SELECT 1 FROM unnest(v_roles) r
                WHERE (v_idx->'allow'->'roles'->'publish') ? r
                   OR (NOT v_admin_denied AND (v_idx->'allow'->'roles'->'admin') ? r))
    OR (v_teams IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(v_teams) t
           WHERE (v_idx->'allow'->'teams'->'publish') ? t
              OR (NOT v_admin_denied AND (v_idx->'allow'->'teams'->'admin') ? t)))
    -- OWN-18: an org-subject grant ("everyone in the org") — the drawer offers
    -- it, the raw evaluator and can_manage_node honour it; publish does too.
    OR (v_idx->'allow'->'orgs'->'publish') ? p_org::text
    OR (NOT v_admin_denied AND (v_idx->'allow'->'orgs'->'admin') ? p_org::text),
    false);
END;
$$;

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 5. Inventory rows: n = the aggregate count.
SELECT 'publish evaluator reads the org allow bucket (publish)' AS check,
       (SELECT prosrc LIKE '%(v_idx->''allow''->''orgs''->''publish'') ? p_org::text%'
          FROM pg_proc WHERE proname = 'user_can_publish_on_library') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'publish evaluator reads the org allow bucket (admin, gated on no admin deny)',
       (SELECT prosrc LIKE '%(NOT v_admin_denied AND (v_idx->''allow''->''orgs''->''admin'') ? p_org::text)%'
          FROM pg_proc WHERE proname = 'user_can_publish_on_library'),
       NULL::text
UNION ALL
SELECT 'publish evaluator honours an org deny of publish and of admin',
       (SELECT prosrc LIKE '%(v_idx->''deny''->''orgs''->''publish'') ? p_org::text%'
              AND prosrc LIKE '%(v_idx->''deny''->''orgs''->''admin'') ? p_org::text%'
          FROM pg_proc WHERE proname = 'user_can_publish_on_library'),
       NULL::text
UNION ALL
SELECT 'the user / role / team arms and the deny-wins order survive',
       (SELECT prosrc LIKE '%v_admin_denied :=%'
              AND prosrc LIKE '%(v_idx->''deny''->''teams''->''publish'') ? t%'
              AND prosrc LIKE '%IF v_roles && ARRAY[''Admin'',''DocCtrl'']::text[] THEN%'
          FROM pg_proc WHERE proname = 'user_can_publish_on_library'),
       NULL::text
UNION ALL
SELECT 'user_can_publish_on_library is SECURITY DEFINER with search_path pinned',
       (SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'user_can_publish_on_library'),
       NULL::text
UNION ALL
SELECT 'inventory (before apply): ' || what, NULL::boolean, n::text FROM _rp_e59_before
UNION ALL
SELECT 'inventory (after apply): libraries with any acl_index at all', NULL::boolean, COUNT(*)::text
  FROM libraries WHERE acl_index IS NOT NULL;
