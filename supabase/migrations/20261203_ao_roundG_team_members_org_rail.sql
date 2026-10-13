-- ─────────────────────────────────────────────────────────────────────────────
-- 20261203 — admin-and-org Round G, P8 ORG-ADMIN SURFACES, migration A:
-- team membership stays inside its team's workspace (ORG-13), the last
-- org-authority helper pins its search_path (ORG-6), and the workspace time
-- zone is an Admin's setting (NEDGE-19 / VFY-15).
--
--   ORG-13  team_members carries its own org_id beside team_id, and nothing
--           tied the two together: an Admin / Manager of org A could insert
--           (team_id = a team of org B, org_id = A) and RLS passed on the
--           row's own org_id. node_visible() then read the caller's team
--           ids with no org filter at all.
--     · trg_team_members_org_rail (BEFORE INSERT OR UPDATE OF team_id,
--       org_id): the row's org_id must equal its team's org_id, read by a
--       SECURITY DEFINER function so a team the caller cannot see is still
--       compared (RLS would hide it and let the row through). Refused with
--       check_violation; the app always writes the team's own org, so no
--       legitimate add changes.
--     · trg_teams_org_move_rail (BEFORE UPDATE OF org_id on teams): a team
--       that has members cannot be moved to another org — its rows would
--       break the rail from the other side. No writer moves a team today.
--     · Rows that ALREADY break it are counted before the transaction and
--       removed inside it, one machine audit row each (TEAM_MEMBER_REMOVED,
--       reason cross_org_team_member, user_id NULL). They can only have been
--       forged (the teams page writes the team's own org), and each one makes
--       a person a member of another workspace's team. A rail (a trigger, not
--       a composite FK — DEC-90 ruling for this package: a composite FK needs
--       a new unique key on teams and rewrites every row).
--     · node_visible(text, jsonb, uuid, uuid, uuid, uuid) re-created from its
--       NEWEST definition (20261041) with ONE line changed: the team lookup
--       reads `team_members WHERE uid = auth.uid() AND org_id = p_org`,
--       matching user_can_publish_on_library (20261046). The 3-arg wrapper
--       delegates to it and is untouched. CREATE OR REPLACE keeps the
--       function's grants: a policy written for every role calls it, so its
--       EXECUTE is deliberately left as it is (a REVOKE FROM PUBLIC here
--       could reach a role that judges documents through PUBLIC — DEC-95's
--       door role names that risk).
--     · my_team_ids() is not re-created: since 20261042 it joins the
--       caller's ACTIVE membership on tm.org_id, and with the rail every
--       such org is the team's own; no policy calls it.
--   ORG-6   acl_subject_in_bucket(jsonb, text, text, text[]) is the twelfth
--           helper the finding lists and the only one without a pin (a
--           SECURITY INVOKER function over its own arguments, reached under
--           node_visible's pin). One ALTER FUNCTION … SET search_path.
--   NEDGE-19 / VFY-15  the workspace time zone is org_configurations key
--           'timezone' (data.timeZone, an IANA name — the shape
--           lib/recordTime.ts orgTimeZone already reads). Until now the key
--           fell to the permissive org policy: ANY active member could set
--           the zone every server-composed time (and, once VFY-15's resolver
--           lands, every effective date) is read in. The three RESTRICTIVE
--           per-key policies (newest definition 20260818) are re-created with
--           one added line each: 'timezone' → is_org_admin(org_id). NARROWS.
--
-- Pre-apply inventory (DEC-30, aggregate counts only, BEFORE the
-- transaction): team_members rows, the cross-org rows this paste removes,
-- the existing timezone rows. Never a customer row.
--
-- BEFORE THE PASTE the app works as today: an Admin's team add / remove and
-- the settings page's time-zone save are the same writes (the save writes
-- what an Admin may write after it too). AFTER IT a forged cross-org team
-- row is refused, and a non-Admin's write of the timezone key is refused
-- (42501, shown by the settings page as a refusal — only Admins see it).
-- ORDER: independent of every other pending file; either order with the P8
-- deploy. ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
--
-- ROLLBACK: DROP TRIGGER trg_team_members_org_rail ON team_members;
--   DROP TRIGGER trg_teams_org_move_rail ON teams; DROP FUNCTION
--   enforce_team_member_org(), enforce_team_org_move(); re-paste 20261041's
--   node_visible and 20260818's three org_config_key_writes_* policies;
--   ALTER FUNCTION acl_subject_in_bucket(jsonb, text, text, text[]) RESET
--   search_path. The removed cross-org rows are named in their audit rows.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS ao_p8_20261203_inventory (check_name text, n bigint);
TRUNCATE ao_p8_20261203_inventory;
INSERT INTO ao_p8_20261203_inventory
SELECT 'before: team_members rows', COUNT(*) FROM team_members
UNION ALL
SELECT 'before: team_members rows whose org_id is not their team''s org (removed by this paste, one audit row each)',
       COUNT(*) FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.org_id IS DISTINCT FROM t.org_id
UNION ALL
SELECT 'before: workspace time-zone rows (org_configurations key timezone)',
       COUNT(*) FROM org_configurations WHERE key = 'timezone';

BEGIN;

-- ── 1. ORG-13: remove the rows that already break the rail (audited) ────────
INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details, metadata)
SELECT 'TEAM_MEMBER_REMOVED', tm.team_id::text, 'team', tm.org_id, NULL, 'system:migration-20261203', 'system',
       jsonb_build_object('memberUid', tm.uid, 'teamOrgId', t.org_id, 'reason', 'cross_org_team_member', 'migration', '20261203'),
       jsonb_build_object('actor_kind', 'system')
  FROM team_members tm JOIN teams t ON t.id = tm.team_id
 WHERE tm.org_id IS DISTINCT FROM t.org_id;
DELETE FROM team_members tm USING teams t
 WHERE t.id = tm.team_id AND tm.org_id IS DISTINCT FROM t.org_id;

-- ── 2. ORG-13: the rail ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_team_member_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_team_org uuid;
BEGIN
  SELECT org_id INTO v_team_org FROM teams WHERE id = NEW.team_id;
  -- A missing team is the foreign key's to refuse; the rail compares orgs.
  IF FOUND AND NEW.org_id IS DISTINCT FROM v_team_org THEN
    RAISE EXCEPTION 'A team member must belong to the team''s own workspace (team_members.org_id must equal teams.org_id).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_team_member_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_team_members_org_rail ON team_members;
CREATE TRIGGER trg_team_members_org_rail
  BEFORE INSERT OR UPDATE OF team_id, org_id ON team_members
  FOR EACH ROW EXECUTE FUNCTION enforce_team_member_org();

CREATE OR REPLACE FUNCTION enforce_team_org_move()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     AND EXISTS (SELECT 1 FROM team_members WHERE team_id = OLD.id) THEN
    RAISE EXCEPTION 'A team that has members cannot be moved to another workspace.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_team_org_move() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_teams_org_move_rail ON teams;
CREATE TRIGGER trg_teams_org_move_rail
  BEFORE UPDATE OF org_id ON teams
  FOR EACH ROW EXECUTE FUNCTION enforce_team_org_move();

-- ── 3. ORG-13 done-when 2: node_visible's team lookup is org-scoped ─────────
-- Body from 20261041 (its newest definition) with one line changed — the
-- team lookup adds `AND org_id = p_org`. lib/__tests__/aoRoundGP8Migrations
-- .test.ts finds the newest earlier definition by scanning the sequence.
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
    FROM team_members WHERE uid = auth.uid() AND org_id = p_org;

  -- Any allow grant (any action) lets the row through; finer read-vs-
  -- discover distinctions stay in the app layer. CHAIN-1/ADD-1: a role
  -- subject matches ANY held role, not only the headline.
  RETURN acl_subject_in_bucket(p_acl_index->'allow', v_uid, v_role, v_teams)
      OR (v_roles IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(v_roles) r
             WHERE acl_subject_in_bucket(p_acl_index->'allow', v_uid, r, NULL::text[])));
END;
$$;

-- ── 4. ORG-6: the twelfth helper pins its search_path ───────────────────────
ALTER FUNCTION acl_subject_in_bucket(jsonb, text, text, text[]) SET search_path = public;

-- ── 5. NEDGE-19 / VFY-15: the workspace time zone is an Admin's write ───────
-- The three RESTRICTIVE per-key policies from 20260818 (their newest
-- definition), each with one added line: 'timezone' → is_org_admin(org_id).
DROP POLICY IF EXISTS org_config_key_writes_ins ON org_configurations;
CREATE POLICY org_config_key_writes_ins ON org_configurations
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_upd ON org_configurations;
CREATE POLICY org_config_key_writes_upd ON org_configurations
  AS RESTRICTIVE FOR UPDATE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END)
  WITH CHECK (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END);

DROP POLICY IF EXISTS org_config_key_writes_del ON org_configurations;
CREATE POLICY org_config_key_writes_del ON org_configurations
  AS RESTRICTIVE FOR DELETE
  USING (CASE key
    WHEN 'branding' THEN is_org_admin(org_id)
    WHEN 'drafting' THEN is_org_assign_drafters(org_id)
    WHEN 'timezone' THEN is_org_admin(org_id)
    ELSE true END);

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'trg_team_members_org_rail: BEFORE INSERT OR UPDATE, row-level, enabled; its function is SECURITY DEFINER with search_path pinned' AS check,
       EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                WHERE tg.tgrelid = 'public.team_members'::regclass AND tg.tgname = 'trg_team_members_org_rail'
                  AND NOT tg.tgisinternal AND tg.tgenabled = 'O'
                  AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 4) = 4 AND (tg.tgtype & 16) = 16
                  AND p.proname = 'enforce_team_member_org' AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'trg_teams_org_move_rail: BEFORE UPDATE on teams, enabled; SECURITY DEFINER, search_path pinned',
       EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                WHERE tg.tgrelid = 'public.teams'::regclass AND tg.tgname = 'trg_teams_org_move_rail'
                  AND NOT tg.tgisinternal AND tg.tgenabled = 'O' AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 16) = 16
                  AND p.proname = 'enforce_team_org_move' AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 'no team_members row names a team of another workspace',
       NOT EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.org_id IS DISTINCT FROM t.org_id),
       NULL
UNION ALL
SELECT 'the rail functions are not executable by PUBLIC, anon or authenticated (trigger-only)',
       NOT has_function_privilege('anon', 'enforce_team_member_org()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_team_member_org()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'enforce_team_org_move()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_team_org_move()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'node_visible/6 reads the caller''s teams in the node''s org only',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%FROM team_members WHERE uid = auth.uid() AND org_id = p_org;%'),
       NULL
UNION ALL
SELECT 'node_visible/6 keeps its body: controller via is_org_controller, the owner branch after it, every held role, SECURITY DEFINER; both arities pinned',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6 AND prosecdef
                  AND prosrc LIKE '%IF is_org_controller(p_org) THEN%'
                  AND position('is_org_controller(p_org)' in prosrc) < position('user_is_effective_owner(p_owner' in prosrc)
                  AND prosrc LIKE '%FROM unnest(v_roles) r%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''users''->''read'') ? v_uid%')
       AND (SELECT COUNT(*) = 2 FROM pg_proc WHERE proname = 'node_visible' AND pronargs IN (3, 6)
              AND proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 'acl_subject_in_bucket(jsonb, text, text, text[]) carries SET search_path = public (ORG-6)',
       EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'acl_subject_in_bucket(jsonb, text, text, text[])'::regprocedure
                  AND proconfig @> ARRAY['search_path=public']),
       NULL
UNION ALL
SELECT 'org_config_key_writes_ins / _upd / _del: timezone is an Admin''s, branding and drafting unchanged, RESTRICTIVE',
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'org_configurations' AND permissive = 'RESTRICTIVE'
           AND policyname IN ('org_config_key_writes_ins', 'org_config_key_writes_upd', 'org_config_key_writes_del')
           AND COALESCE(qual, with_check) LIKE '%''timezone''%THEN is_org_admin(org_id)%'
           AND COALESCE(qual, with_check) LIKE '%''branding''%THEN is_org_admin(org_id)%'
           AND COALESCE(qual, with_check) LIKE '%''drafting''%THEN is_org_assign_drafters(org_id)%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'org_configurations'
                      AND policyname = 'org_config_key_writes_upd' AND with_check LIKE '%''timezone''%THEN is_org_admin(org_id)%'),
       NULL
UNION ALL
SELECT check_name, NULL, n::text FROM ao_p8_20261203_inventory
UNION ALL
SELECT 'after: team_members rows', NULL, (SELECT COUNT(*) FROM team_members)::text
UNION ALL
SELECT 'after: machine audit rows recording a removed cross-org team member (all runs)', NULL,
       (SELECT COUNT(*) FROM audit_logs WHERE action = 'TEAM_MEMBER_REMOVED' AND details->>'reason' = 'cross_org_team_member')::text;
