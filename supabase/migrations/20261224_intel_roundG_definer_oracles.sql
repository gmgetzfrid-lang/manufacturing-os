-- ─────────────────────────────────────────────────────────────────────────────
-- 20261224 — intelligence Round G, I-28 DEFINER ORACLES: the SECURITY DEFINER
-- helpers that answered about any uid (or project) a caller names now answer a
-- client role only about itself (projects-and-cost INTK-19; DEC-90; DRLS-16).
--
-- THE DEFECT. Five helpers called inside row-level-security policies take the
-- person (or project) to judge as a parameter and never read the session, and
-- org_capability_allows_for does the same for any signed-in account. Over
-- PostgREST, anyone holding the public anon key could ask whether uid X may
-- publish into library Y, is document Z's effective owner, holds capability C
-- or is denied by an ACL index, and map any project to its workspace; and,
-- through user_is_effective_owner(X, NULL, <library>, X), whether X is an
-- active member of a workspace (of ANY workspace, with no library) — the
-- answer 20261217 took away from member_is_active.
--
-- WHAT THIS FILE DOES. No policy and no app code changes.
--
--   1. user_can_publish_on_library, user_is_effective_owner,
--      org_capability_allows and acl_index_denies are each re-created from
--      their NEWEST body (20261059, 20261042, 20261052, 20261025) with one
--      added block: when the request's role is anon or authenticated (the
--      role PostgREST sets, or the JWT's role claim), a uid other than
--      auth.uid() is refused with 42501. Every policy that calls them passes
--      auth.uid(). So does every definer that calls them in a client session:
--      the publish, register-rail, retention, review-control, review-signoff
--      and intake-link guards, publish_revision (which binds p_actor to the
--      session), the checkout guards, supersession_writable,
--      user_can_publish_doc, documents_guard_access_change and node_visible.
--      Each policy therefore answers exactly as before for every reader
--      (proven per role, before and after, on the database harness). The
--      service role, the SQL editor and definer code in a server session
--      still ask about anyone. user_is_effective_owner also answers false to
--      a client role when no workspace resolves (no library, or none with
--      that id): with no library its membership tests range over every
--      workspace. Every client-session caller passes a document's or a
--      folder's library, and both columns are NOT NULL.
--   2. effective_owner_matches (NEW, internal) is the same walk, for the one
--      definer that asks about OTHER candidates in a signed-in session:
--      review_signoff_owner_stamp (20261159), re-created from its only body
--      with that one call renamed. No client role and not the service role
--      may execute it. Its membership tests are written inline, so
--      user_is_effective_owner stays the only function that names
--      member_is_active (20261217's precondition counts every other definer
--      that names it, so either file may be pasted first).
--   3. org_capability_allows_for, the 4-argument evaluator, is NOT
--      re-created: its 20261137 body stays the base that every later
--      capability row starts from. Its EXECUTE narrows to service_role. Its
--      definer callers, org_capability_allows and quality_signoff_granted_for,
--      keep calling it as its owner. The quality sign-off helpers ask it about
--      OTHER signers, which is why it is narrowed rather than bound. Its one
--      SECURITY INVOKER caller, transmittals_guard (20261199), is re-created
--      with its two calls going through caller_capability_allows (NEW: the
--      evaluator for auth.uid() only; authenticated and service_role).
--      LIVE-DATABASE PRECONDITION (fail-safe, as 20261217). The REVOKE runs
--      only when the live catalog holds nothing else a client role could
--      reach it through: a policy, a SECURITY INVOKER function other than
--      transmittals_guard, a view, a default, a CHECK, a trigger definition,
--      or a definer owned by a role that would lose the call. Otherwise it
--      stays executable, a NOTICE says why, and the precondition probe
--      answers false.
--   4. project_org is re-created from its only body (20260913),
--      caller-scoped: a client role reads a project's workspace only as an
--      active member of it. Each of its 6 policies already requires that
--      membership (EXISTS on org_members, is_org_controller,
--      user_owns_project, project_visible_to_me), and
--      checkouts_resync_project_documents returns early for a non-member
--      either way.
--
-- NOT DONE HERE (DEC-90, the integrator's ruling for this package):
-- node_visible is not re-created; intelligence I-30 re-creates it once. Its
-- ownership limb calls user_is_effective_owner(p_owner, …, auth.uid()) in the
-- caller's session. After this file, a caller-supplied p_owner tells the anon
-- key nothing, and tells a signed-in account nothing about a workspace it is
-- not an active member of. What both doors still answer is projects-and-cost
-- INTK-20: inside a workspace where the caller is active and the effective
-- owner of the named container, the answer still follows the named person's
-- membership there, which org_members_read already returns to that caller.
--
-- NARROWS. Nobody legitimate loses anything, and no app code changes. The
-- grants of the re-created policy helpers are unchanged (CREATE OR REPLACE
-- keeps them; their policies are written for every role). Pre-apply inventory
-- (DEC-30): aggregate COUNTs of the catalog only, captured in a TEMP TABLE
-- before the transaction. Never a customer row.
--
-- BEFORE THE PASTE the app works as today. AFTER IT: every policy answers
-- exactly as before for every role. A client role that asks a bound helper
-- about another person gets 42501. The anon key gets no project's workspace.
-- Signed-in accounts can no longer call org_capability_allows_for directly
-- (no app code does). Transmittals issue, void and revoke as before. The app
-- calls none of the new functions and no changed signature, so no 42703,
-- 42883 or PGRST202 can arise from it.
--
-- PASTE FACTS.
--   ORDER: after 20261199, 20261159, 20261137 and 20261136, and after the
--   newest bodies it re-creates (20261059, 20261042, 20261052, 20261025,
--   20260913). The apply-order check at the top refuses, changing nothing,
--   when one is missing: it reads each re-created body's own marker,
--   20261137's ai.manage_caps row in org_capability_allows_for, and
--   quality_signoff_granted_for, which only 20261136 creates. (Both of those
--   files end by granting authenticated the evaluator, so neither may come
--   after this file.) Independent of 20261217 and 20261212 (either order).
--   HOLDS: inherits the holds of 20261159 (the Intake force deployed,
--   projects-and-cost INTK-18) and 20261199 (the app carrying
--   document-control P24 deployed). Paste only after both are lifted and
--   pasted. Until then the apply-order check refuses and changes nothing.
--   DEPLOY GATE: none of its own. Either order with any deploy (the app is
--   unchanged), once the holds above are lifted.
--   ⚠ NEVER RE-PASTE 20261159, 20261199, 20261133 OR 20261027 AFTER THIS FILE.
--   Re-pasting 20261199 or 20261133 puts back a transmittals_guard that asks
--   org_capability_allows_for as the signed-in member: it BREAKS every
--   transmit authority's issue, void and revoke (42501, permission denied for
--   function org_capability_allows_for). Re-pasting 20261159 puts back a
--   review_signoff_owner_stamp that asks user_is_effective_owner about other
--   candidates: it BREAKS signed-in roster opening on a document whose review
--   control needs the owner (42501 from user_is_effective_owner). Each stays
--   broken until this file is pasted again in the same sitting. After
--   20261133, paste 20261199 first: this file's apply-order check refuses
--   over 20261133's older guard. 20261027's transmittals_guard predates TRX-1
--   and names no evaluator: re-pasted, it raises nothing, but takes TRX-1 and
--   TRX-17 away (it is already never re-pasted after 20261133).
--   Re-pasting 20261059, 20261042, 20261052, 20261025 or 20260913 only puts
--   that function's earlier, unbound body back, and re-pasting 20261137 (or
--   20261136) only gives authenticated org_capability_allows_for back: each
--   undoes this file for that function and breaks nothing this file
--   changed; re-paste this file after it. (20261052, 20261136 and 20261137
--   keep their own never-re-paste rules for the evaluator's rows.)
--   EXPECTED RESULT (one result set, 44 rows): 13 probes with ok = true, n
--   NULL; then 2 after-counts and 29 inventory counts (ok NULL). On the
--   harness's replay the anon- and authenticated-executable SECURITY DEFINER
--   counts are the same before and after (org_capability_allows_for leaves
--   authenticated, caller_capability_allows joins it), and the four
--   precondition rows (expect 0) are each 0. A precondition row above 0 means
--   org_capability_allows_for was left executable by signed-in accounts: its
--   probe and the precondition probe answer false, and the NOTICE gives the
--   total. Everything else in the file applies either way.
--   ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
--
-- ROLLBACK:
--   GRANT EXECUTE ON FUNCTION public.org_capability_allows_for(uuid, text, uuid, jsonb) TO authenticated;
--   then re-run the CREATE OR REPLACE blocks of 20261059 (user_can_publish_on_library),
--   20261042 (user_is_effective_owner), 20261052 (org_capability_allows), 20261025
--   (acl_index_denies), 20260913 (project_org), 20261159 (review_signoff_owner_stamp)
--   and 20261199 (transmittals_guard). effective_owner_matches and
--   caller_capability_allows are then unused.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. apply order: the newest bodies this file re-creates are in place ─────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'transmittals_guard' AND prosrc LIKE '%TRX-17 (20261199)%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'review_signoff_owner_stamp' AND prosrc LIKE '%opened_owner_slot%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)') AND prosrc LIKE '%WHEN ''ai.manage_caps''%')
     OR to_regprocedure('public.quality_signoff_granted_for(uuid,uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'user_can_publish_on_library' AND prosrc LIKE '%(v_idx->''allow''->''orgs''->''publish'') ? p_org::text%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'user_is_effective_owner' AND prosrc LIKE '%member_is_active(v_org, p_doc_owner)%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'org_capability_allows' AND prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'acl_index_denies' AND prosrc LIKE '%tm.uid = p_uid%')
     OR to_regprocedure('public.project_org(uuid)') IS NULL THEN
    RAISE EXCEPTION '20261224 needs 20260913, 20261025, 20261042, 20261052, 20261059, 20261136, 20261137, 20261159 and 20261199 pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── 1. pre-apply inventory (counts only; the catalog, never a customer row) ──
-- `pre` marks a precondition count for org_capability_allows_for's REVOKE:
-- it runs only when every one is 0.
DROP TABLE IF EXISTS intel_i28_20261224_inventory;
CREATE TEMP TABLE intel_i28_20261224_inventory (ord int, check_name text, n bigint, pre boolean);
INSERT INTO intel_i28_20261224_inventory
WITH h(k, name) AS (
  VALUES (1, 'user_can_publish_on_library'), (2, 'user_is_effective_owner'), (3, 'org_capability_allows'),
         (4, 'org_capability_allows_for'), (5, 'acl_index_denies'), (6, 'project_org')
)
SELECT h.k * 10 + 1,
       CASE WHEN h.name = 'org_capability_allows_for' THEN 'precondition (expect 0): ' ELSE 'before: ' END
         || 'row-level-security policies whose USING or WITH CHECK names ' || h.name || '(',
       (SELECT COUNT(*) FROM pg_policy pol
         WHERE COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') ~ ('\m' || h.name || '\s*\(')
            OR COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ ('\m' || h.name || '\s*\(')),
       h.name = 'org_capability_allows_for'
  FROM h
UNION ALL
SELECT h.k * 10 + 2, 'before: SECURITY INVOKER functions whose body names ' || h.name || '(',
       (SELECT COUNT(*) FROM pg_proc p
         WHERE NOT p.prosecdef
           AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
           AND (COALESCE(p.prosrc, '') ~ ('\m' || h.name || '\s*\(')
                OR COALESCE(CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_function_sqlbody(p.oid) END, '') ~ ('\m' || h.name || '\s*\('))),
       false
  FROM h
UNION ALL
SELECT h.k * 10 + 3, 'before: other SECURITY DEFINER functions whose body names ' || h.name || '(',
       (SELECT COUNT(*) FROM pg_proc p
         WHERE p.prosecdef AND p.proname <> h.name
           AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
           AND (COALESCE(p.prosrc, '') ~ ('\m' || h.name || '\s*\(')
                OR COALESCE(CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_function_sqlbody(p.oid) END, '') ~ ('\m' || h.name || '\s*\('))),
       false
  FROM h
UNION ALL
SELECT h.k * 10 + 4,
       CASE WHEN h.name = 'org_capability_allows_for' THEN 'precondition (expect 0): ' ELSE 'before: ' END
         || 'views, column defaults, CHECK constraints and trigger definitions that name ' || h.name || '(',
       (SELECT COUNT(*) FROM (SELECT definition FROM pg_views UNION ALL SELECT definition FROM pg_matviews) v
         WHERE COALESCE(v.definition, '') ~ ('\m' || h.name || '\s*\('))
       + (SELECT COUNT(*) FROM pg_attrdef d WHERE pg_get_expr(d.adbin, d.adrelid) ~ ('\m' || h.name || '\s*\('))
       + (SELECT COUNT(*) FROM pg_constraint c WHERE c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ ('\m' || h.name || '\s*\('))
       + (SELECT COUNT(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ~ ('\m' || h.name || '\s*\(')),
       h.name = 'org_capability_allows_for'
  FROM h
UNION ALL
SELECT 75, 'precondition (expect 0): SECURITY INVOKER functions other than transmittals_guard whose body names org_capability_allows_for(', COUNT(*), true
  FROM pg_proc p
 WHERE NOT p.prosecdef AND p.proname <> 'transmittals_guard'
   AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
   AND (COALESCE(p.prosrc, '') ~ '\morg_capability_allows_for\s*\('
        OR COALESCE(CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_function_sqlbody(p.oid) END, '') ~ '\morg_capability_allows_for\s*\(')
UNION ALL
SELECT 76, 'precondition (expect 0): SECURITY DEFINER functions naming org_capability_allows_for( owned by a role that is neither its owner nor a superuser (they would lose the call)', COUNT(*), true
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
 CROSS JOIN (SELECT to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)') AS f) x
  JOIN pg_proc o ON o.oid = x.f
 WHERE p.prosecdef AND p.oid <> o.oid AND p.proowner <> o.proowner AND NOT r.rolsuper
   AND (COALESCE(p.prosrc, '') ~ '\morg_capability_allows_for\s*\('
        OR COALESCE(CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_function_sqlbody(p.oid) END, '') ~ '\morg_capability_allows_for\s*\(')
UNION ALL
SELECT 77, 'before: roles of anon / authenticated / PUBLIC that may execute org_capability_allows_for (1, authenticated, on a first paste; 0 on a re-paste)', COUNT(*), false
  FROM (SELECT to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)') AS f) x
  JOIN pg_proc p ON p.oid = x.f
 CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
 WHERE a.privilege_type = 'EXECUTE'
   AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))
UNION ALL
SELECT 81, 'before: SECURITY DEFINER functions in public the anon role may execute', COUNT(*), false
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
   AND p.prorettype <> 'trigger'::regtype
   AND has_function_privilege('anon', p.oid, 'EXECUTE')
UNION ALL
SELECT 82, 'before: SECURITY DEFINER functions in public the authenticated role may execute', COUNT(*), false
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
   AND p.prorettype <> 'trigger'::regtype
   AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

BEGIN;

-- ── 2. user_can_publish_on_library — 20261059's body + the client binding ───
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

  -- INTK-19 (20261224): a client role (the anon key, or a signed-in
  -- session) is answered only about itself. Every policy, and every definer
  -- that calls this in a client session, passes auth.uid(); the service role
  -- and the SQL editor still ask about the person they name.
  IF p_uid IS DISTINCT FROM auth.uid()::text
     AND (current_setting('role', true) IN ('anon', 'authenticated')
          OR COALESCE(auth.role(), '') IN ('anon', 'authenticated')) THEN
    RAISE EXCEPTION 'user_can_publish_on_library answers a client only about the signed-in caller (INTK-19).'
      USING ERRCODE = '42501';
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

-- ── 3. user_is_effective_owner — 20261042's body + the client binding ───────
CREATE OR REPLACE FUNCTION user_is_effective_owner(p_doc_owner uuid, p_collection uuid, p_library uuid, p_uid uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_team  uuid;
  v_org   uuid;
  -- INTK-19 (20261224): the request's role, not the function's owner.
  v_client boolean := current_setting('role', true) IN ('anon', 'authenticated')
                      OR COALESCE(auth.role(), '') IN ('anon', 'authenticated');
BEGIN
  IF p_uid IS NULL THEN RETURN false; END IF;

  -- INTK-19 (20261224): a client role (the anon key, or a signed-in
  -- session) is answered only about itself. Every policy, and every definer
  -- that calls this in a client session, passes auth.uid();
  -- review_signoff_owner_stamp asks about other candidates through
  -- effective_owner_matches. The service role and the SQL editor still ask
  -- about the person they name.
  IF v_client AND p_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'user_is_effective_owner answers a client only about the signed-in caller (INTK-19).'
      USING ERRCODE = '42501';
  END IF;

  -- The org is the library's (documents and folders inherit it).
  IF p_library IS NOT NULL THEN
    SELECT org_id INTO v_org FROM libraries WHERE id = p_library;
  END IF;

  -- INTK-19 (20261224): for a client role, no workspace means no owner.
  -- Without a library the membership tests below range over every
  -- workspace, and the answer would say whether a named person is active
  -- in any of them. Every caller in a client session passes a document's or
  -- a folder's library, which always exists.
  IF v_client AND v_org IS NULL THEN
    RETURN false;
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

-- ── 4. effective_owner_matches — NEW, internal: the same walk for definers ──
-- The membership test is the EXISTS member_is_active runs, written inline.
CREATE OR REPLACE FUNCTION effective_owner_matches(p_doc_owner uuid, p_collection uuid, p_library uuid, p_uid uuid)
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
  IF p_doc_owner IS NOT NULL
     AND EXISTS (SELECT 1 FROM org_members m WHERE m.uid = p_doc_owner AND m.status = 'active' AND (v_org IS NULL OR m.org_id = v_org)) THEN
    RETURN p_doc_owner = p_uid;
  END IF;
  IF p_collection IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner FROM collections WHERE id = p_collection;
    IF v_owner IS NOT NULL AND EXISTS (SELECT 1 FROM org_members m WHERE m.uid = v_owner AND m.status = 'active' AND (v_org IS NULL OR m.org_id = v_org)) THEN RETURN v_owner = p_uid; END IF;
  END IF;
  IF p_library IS NOT NULL THEN
    SELECT owner_user_id, owner_team_id INTO v_owner, v_team FROM libraries WHERE id = p_library;
    IF v_owner IS NOT NULL AND EXISTS (SELECT 1 FROM org_members m WHERE m.uid = v_owner AND m.status = 'active' AND (v_org IS NULL OR m.org_id = v_org)) THEN RETURN v_owner = p_uid; END IF;
    IF v_team IS NOT NULL THEN                         -- team-owned library → its supervisor
      SELECT supervisor_user_id INTO v_owner FROM teams WHERE id = v_team;
      IF v_owner IS NOT NULL AND EXISTS (SELECT 1 FROM org_members m WHERE m.uid = v_owner AND m.status = 'active' AND (v_org IS NULL OR m.org_id = v_org)) THEN RETURN v_owner = p_uid; END IF;
    END IF;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION effective_owner_matches(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION effective_owner_matches(uuid, uuid, uuid, uuid) IS
  'INTK-19 (20261224): user_is_effective_owner''s walk (20261042) for definer code that asks about a candidate other than the caller in a signed-in session (review_signoff_owner_stamp). No client role and not the service role may execute it.';

-- ── 5. review_signoff_owner_stamp — 20261159's body, one call renamed ───────
CREATE OR REPLACE FUNCTION review_signoff_owner_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_open        boolean;
  v_inherited   text;
  v_doc_id      uuid;
  v_created_by  uuid;
  v_found       boolean;
  v_doc_owner   uuid;
  v_collection  uuid;
  v_library     uuid;
  v_control     jsonb;
  v_owner       uuid;
  v_independent boolean;
BEGIN
  -- A write with no JWT (the service role) is trusted only as
  -- enforce_review_signoff_guard (20261070) trusts it: no service-role door
  -- writes roster rows today, and the data restore never imports
  -- document_review_signoffs (lib/dataRestore.ts IMMUTABLE_TABLES, :162,
  -- its entry :168). (RLS gives anon no roster row to insert or update.)
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  -- A signed-in UPDATE never changes it: a roster keeps the rule it was
  -- opened under (GAP-4: reviews already in progress keep their roster).
  IF TG_OP = 'UPDATE' THEN
    NEW.opened_owner_slot := OLD.opened_owner_slot;
    RETURN NEW;
  END IF;
  -- A signed-in INSERT: whatever the caller sent is overwritten. A row added
  -- to a roster that is already open takes the rule that roster was opened
  -- under — its rows' stamp (an owner rule over any other when they differ),
  -- or NULL when they carry none (a roster opened before 20261159 is never
  -- retrofitted) — so a policy or owner change mid-review never reaches it.
  SELECT count(*) > 0, max(s.opened_owner_slot) INTO v_open, v_inherited
    FROM document_review_signoffs s
   WHERE s.document_version_id = NEW.document_version_id;
  IF v_open THEN
    NEW.opened_owner_slot := v_inherited;
    RETURN NEW;
  END IF;
  -- The roster's first row: the rule read NOW for the DRAFT's own document
  -- (the version's record, not the row's claimed document_id), and the
  -- author the version records, kept raw for the author rule below.
  SELECT v.record_id, v.created_by INTO v_doc_id, v_created_by
    FROM document_versions v WHERE v.id = NEW.document_version_id;
  SELECT true, d.owner_user_id, d.collection_id, d.library_id, d.review_control
    INTO v_found, v_doc_owner, v_collection, v_library, v_control
    FROM documents d WHERE d.id = COALESCE(v_doc_id, NEW.document_id);
  IF v_found IS NULL
     OR NOT review_control_owner_must_approve_for(v_control, v_collection, v_library) THEN
    NEW.opened_owner_slot := 'none';
    RETURN NEW;
  END IF;
  -- The effective owner: the candidate the one SQL chain names
  -- (user_is_effective_owner — document → folder → library → the owning
  -- team's supervisor, an inactive member skipped: OWN-16 / GAP-5).
  -- INTK-19 (20261224): asked through effective_owner_matches, the same walk
  -- for definer code: this signed-in INSERT asks about candidates other than
  -- the caller, which user_is_effective_owner now refuses to a client role.
  SELECT c.uid INTO v_owner
    FROM (VALUES (1, v_doc_owner),
                 (2, (SELECT col.owner_user_id FROM collections col WHERE col.id = v_collection)),
                 (3, (SELECT l.owner_user_id FROM libraries l WHERE l.id = v_library)),
                 (4, (SELECT t.supervisor_user_id FROM libraries l JOIN teams t ON t.id = l.owner_team_id
                       WHERE l.id = v_library))) AS c(ord, uid)
   WHERE c.uid IS NOT NULL
     AND effective_owner_matches(v_doc_owner, v_collection, v_library, c.uid)
   ORDER BY c.ord
   LIMIT 1;
  IF v_owner IS NULL THEN
    NEW.opened_owner_slot := 'no_owner';
    RETURN NEW;
  END IF;
  -- DEC-21: an owner who authored the revision is skipped where the library
  -- requires an independent reviewer — anything but
  -- requireIndependentReviewer = false (lib/reviewControl.ts). The author
  -- exception holds only when the owner is the person OPENING the roster
  -- and the version names no other author (P17 review fix): created_by is a
  -- column a library publisher can write through PostgREST (20261037's
  -- version policies admit any value for a publisher; no trigger keeps it),
  -- so an author read from it alone let a publisher who is not the owner
  -- name the owner as author and open a roster without them. Every roster
  -- the app opens is one of these: submitForReview opens it as the
  -- version's creator, and the intake approve opens an external
  -- submission's (no created_by — openReviewRoster's author is then its
  -- actor). A version naming the owner as author on a roster someone else
  -- opens is stamped owner:<uid>: the owner approves it.
  SELECT NOT COALESCE(l.review_control->'requireIndependentReviewer' = 'false'::jsonb, false)
    INTO v_independent
    FROM libraries l WHERE l.id = v_library;
  IF COALESCE(v_independent, true)
     AND v_owner = auth.uid()
     AND (v_created_by IS NULL OR v_created_by = auth.uid()) THEN
    NEW.opened_owner_slot := 'author';
    RETURN NEW;
  END IF;
  NEW.opened_owner_slot := 'owner:' || v_owner::text;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION review_signoff_owner_stamp() FROM PUBLIC, anon, authenticated, service_role;

-- ── 6. org_capability_allows — 20261052's body + the client binding ─────────
CREATE OR REPLACE FUNCTION org_capability_allows(p_org UUID, p_cap TEXT, p_uid UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- INTK-19 (20261224): a client role (the anon key, or a signed-in
  -- session) is answered only about itself. Its 4 policies and its 3
  -- definer callers (the checkout guards) pass auth.uid(); the service role
  -- and the SQL editor still ask about the person they name.
  IF p_uid IS DISTINCT FROM auth.uid()
     AND (current_setting('role', true) IN ('anon', 'authenticated')
          OR COALESCE(auth.role(), '') IN ('anon', 'authenticated')) THEN
    RAISE EXCEPTION 'org_capability_allows answers a client only about the signed-in caller (INTK-19).'
      USING ERRCODE = '42501';
  END IF;
  RETURN org_capability_allows_for(p_org, p_cap, p_uid, '{}'::jsonb);
END;
$$;

-- ── 7. acl_index_denies — 20261025's body + the client binding ──────────────
CREATE OR REPLACE FUNCTION acl_index_denies(p_idx JSONB, p_org UUID, p_uid UUID, p_action TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_roles TEXT[];
BEGIN
  IF p_idx IS NULL THEN RETURN FALSE; END IF;
  -- INTK-19 (20261224): a client role (the anon key, or a signed-in
  -- session) is answered only about itself. Its 2 policies pass auth.uid();
  -- the service role (lib/orchestrator/tools.ts) still asks about the person
  -- it names.
  IF p_uid IS DISTINCT FROM auth.uid()
     AND (current_setting('role', true) IN ('anon', 'authenticated')
          OR COALESCE(auth.role(), '') IN ('anon', 'authenticated')) THEN
    RAISE EXCEPTION 'acl_index_denies answers a client only about the signed-in caller (INTK-19).'
      USING ERRCODE = '42501';
  END IF;
  IF p_idx->'deny'->'users'->p_action ? p_uid::text THEN RETURN TRUE; END IF;
  SELECT role, COALESCE(roles, ARRAY[role]) INTO v_role, v_roles
  FROM org_members WHERE org_id = p_org AND uid = p_uid AND status = 'active' LIMIT 1;
  IF v_roles IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_roles) r
    WHERE p_idx->'deny'->'roles'->p_action ? r
  ) THEN RETURN TRUE; END IF;
  -- was: WHERE tm.user_id = p_uid::text  (phantom column → 42703)
  IF EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.uid = p_uid
      AND p_idx->'deny'->'teams'->p_action ? tm.team_id::text
  ) THEN RETURN TRUE; END IF;
  RETURN FALSE;
END;
$$;

-- ── 8. project_org — 20260913's body, caller-scoped ─────────────────────────
CREATE OR REPLACE FUNCTION project_org(p_project uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- INTK-19 (20261224): a client role (the anon key, or a signed-in
  -- session) reads a project's workspace only as an active member of that
  -- workspace; every policy that calls this already requires that
  -- membership. The service role and the SQL editor read it for any project.
  SELECT p.org_id FROM projects p
   WHERE p.id = p_project
     AND (NOT (current_setting('role', true) IN ('anon', 'authenticated')
               OR COALESCE(auth.role(), '') IN ('anon', 'authenticated'))
          OR EXISTS (SELECT 1 FROM org_members m
                      WHERE m.org_id = p.org_id AND m.uid = auth.uid() AND m.status = 'active'));
$$;

-- ── 9. caller_capability_allows — NEW: the evaluator for the caller only ────
CREATE OR REPLACE FUNCTION caller_capability_allows(p_org uuid, p_cap text, p_resource jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_capability_allows_for(p_org, p_cap, auth.uid(), p_resource);
$$;

REVOKE ALL ON FUNCTION caller_capability_allows(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION caller_capability_allows(uuid, text, jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION caller_capability_allows(uuid, text, jsonb) IS
  'INTK-19 (20261224): org_capability_allows_for for auth.uid() only, the caller-bound form transmittals_guard (SECURITY INVOKER) asks. With no session it answers false.';

-- ── 10. transmittals_guard — 20261199's body, two calls as the caller ───────
CREATE OR REPLACE FUNCTION transmittals_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  it JSONB;
  v_doc uuid;
  v_ver uuid;
  -- 20261133 (TRX-1 / TRX-2 / TRX-3 / TRX-4 / TRX-6 / TRX-8 / TRX-12):
  v_uid uuid := auth.uid();
  v_issue boolean := false;
  v_items JSONB;
  v_lib uuid;
  v_status text;
  v_archived timestamptz;
  v_current uuid;
  v_record uuid;
  v_label text;
  v_hash text;
  v_eff date;
  v_branch boolean;
  v_review text;
  v_key text;
  v_shed timestamptz;
  v_doc_rev text;
  v_cur_label text;
  v_size bigint;
  v_superseded timestamptz;
  -- 20261199 (TRX-17):
  v_check_ok boolean := false;
  v_verdict text;
  v_accepted boolean;
BEGIN
  -- ── TRX-2: an issued transmittal never leaves the register ───────────────
  -- Only a draft is deleted — for EVERY caller, the service role included
  -- (20260826's rule for held records). The one pass is an FK cascade from
  -- deleting the workspace itself: the org row is already gone in this
  -- snapshot, so the org's own delete decided.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IS DISTINCT FROM 'draft'
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id) THEN
      RAISE EXCEPTION 'Transmittal % was issued — it stays on the register (void it instead). Only a draft can be deleted. (TRX-2, 20261133)', OLD.number
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  v_issue := NEW.status = 'issued'
             AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'issued');

  IF TG_OP = 'INSERT' THEN
    -- ── TRX-1: a member session creates a DRAFT ─────────────────────────────
    -- Issuing is an UPDATE this trigger authorizes; the server-owned columns
    -- start empty whatever the client sent. (The service role — a restore —
    -- keeps its rows as written: a restored issued row arrives voided, DEC-45.)
    IF v_uid IS NOT NULL THEN
      IF NEW.status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'A transmittal is created as a draft and issued from the register — it cannot be born %. (TRX-1, 20261133)', NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.portal_token := NULL;
      NEW.issued_at := NULL;
      NEW.acknowledged_at := NULL;
      NEW.acknowledged_by_name := NULL;
      NEW.acknowledged_via := NULL;
      NEW.acknowledged_meta := NULL;
      NEW.portal_expires_at := NULL;
      NEW.portal_revoked_at := NULL;
      NEW.portal_revoked_by := NULL;
      NEW.portal_last_used_at := NULL;
      NEW.portal_open_count := 0;
      NEW.portal_download_count := 0;
      NEW.stamp_check := NULL;
    ELSIF NEW.status = 'issued' THEN
      -- ── DEC-45: a service-role INSERT born issued is a restore ──────────
      -- (no app path inserts with the service role). Its backup predates the
      -- portal_token column, so the restore's scrub could not void it: it
      -- lands voided here instead — the register keeps the record and its
      -- issue date, no live link is minted, and the issue gate is not run
      -- (it would re-date the record, or abort the whole restore on a
      -- document the backup lists as withdrawn).
      NEW.status := 'voided';
      NEW.portal_token := NULL;
      NEW.notes := concat_ws(E'\n\n', NULLIF(btrim(COALESCE(NEW.notes, '')), ''),
        'Restored from a backup: the portal link was not restored (DEC-45). Issue a new transmittal to send these documents again.');
      v_issue := false;
    END IF;
  ELSE
    -- ── TRX-6: identity is fixed at creation ────────────────────────────────
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.seq IS DISTINCT FROM OLD.seq
       OR NEW.number IS DISTINCT FROM OLD.number OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'A transmittal''s workspace, number and author are fixed when it is created. (TRX-6, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-2 / TRX-6: the lifecycle runs one way ───────────────────────────
    -- draft → issued → acknowledged, and issued / acknowledged → voided.
    -- Nothing comes back from voided, nothing returns to draft, and a draft
    -- is deleted rather than voided.
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status = 'issued')
      OR (OLD.status = 'issued' AND NEW.status IN ('acknowledged', 'voided'))
      OR (OLD.status = 'acknowledged' AND NEW.status = 'voided')) THEN
      RAISE EXCEPTION 'A transmittal cannot move from % to %. (TRX-2 / TRX-6, 20261133)', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-6: once issued, the record is the record ───────────────────────
    -- The documents, the recipient, the purpose, the issue time and the
    -- portal link are what was sent. Unlinking it from a project is allowed
    -- only as the FK's own ON DELETE SET NULL (one trigger level down) or by
    -- the service role (the project purge).
    IF OLD.status <> 'draft' AND (
         NEW.items IS DISTINCT FROM OLD.items
      OR NEW.recipient_name IS DISTINCT FROM OLD.recipient_name
      OR NEW.recipient_company IS DISTINCT FROM OLD.recipient_company
      OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.subject IS DISTINCT FROM OLD.subject
      OR NEW.notes IS DISTINCT FROM OLD.notes
      OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name
      OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
      OR NEW.portal_token IS DISTINCT FROM OLD.portal_token
      OR NEW.portal_expires_at IS DISTINCT FROM OLD.portal_expires_at
      OR (NEW.project_id IS DISTINCT FROM OLD.project_id
          AND NOT (NEW.project_id IS NULL AND (pg_trigger_depth() > 1 OR v_uid IS NULL)))) THEN
      RAISE EXCEPTION 'Transmittal % has been issued — its documents, recipient, purpose and portal link are the record and cannot be edited. Void it and issue a new one. (TRX-6, 20261133)', OLD.number
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-17 (20261199): the stamp check an issue relied on is frozen with it
    IF OLD.status <> 'draft' AND NEW.stamp_check IS DISTINCT FROM OLD.stamp_check THEN
      RAISE EXCEPTION 'Transmittal % has been issued — the stamp check it was issued on is part of the record. (TRX-17, 20261199)', OLD.number
        USING ERRCODE = 'check_violation';
    END IF;

    -- ── TRX-6: the receipt is written once, server-side ─────────────────────
    -- acknowledged_* change only on the issued → acknowledged transition, and
    -- only from a service-role path (the recipient portal, or the register's
    -- receipt route, which checks transmit authority and names the recorder).
    IF (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
        OR NEW.acknowledged_by_name IS DISTINCT FROM OLD.acknowledged_by_name
        OR NEW.acknowledged_via IS DISTINCT FROM OLD.acknowledged_via
        OR NEW.acknowledged_meta IS DISTINCT FROM OLD.acknowledged_meta)
       AND NOT (OLD.status = 'issued' AND NEW.status = 'acknowledged') THEN
      RAISE EXCEPTION 'A transmittal''s receipt is recorded once and never edited. (TRX-6, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'issued' AND NEW.status = 'acknowledged' THEN
      IF v_uid IS NOT NULL THEN
        RAISE EXCEPTION 'A receipt is recorded by the recipient portal, or on the register through the receipt route — never by a member session. (TRX-6, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.acknowledged_at IS NULL THEN
        RAISE EXCEPTION 'An acknowledgment records when it happened. (TRX-6, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- ── TRX-4: revoking the portal link is durable ─────────────────────────
    -- Revocation cuts the link without repudiating the record. It is set
    -- once, on a live link of an issued transmittal, stamped with the
    -- database's clock and the caller; it never clears or moves.
    IF NEW.portal_revoked_at IS DISTINCT FROM OLD.portal_revoked_at
       OR NEW.portal_revoked_by IS DISTINCT FROM OLD.portal_revoked_by THEN
      IF OLD.portal_revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'This portal link was revoked on % — a revocation never clears or moves. (TRX-4, 20261133)', OLD.portal_revoked_at
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.portal_revoked_at IS NULL OR OLD.status NOT IN ('issued', 'acknowledged') OR OLD.portal_token IS NULL THEN
        RAISE EXCEPTION 'Only the live portal link of an issued transmittal can be revoked. (TRX-4, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.portal_revoked_at := now();
      NEW.portal_revoked_by := COALESCE(v_uid, NEW.portal_revoked_by);
    END IF;

    IF v_uid IS NOT NULL THEN
      -- ── TRX-4: the usage trail is the portal's, not a member's ──────────
      IF NEW.portal_last_used_at IS DISTINCT FROM OLD.portal_last_used_at
         OR NEW.portal_open_count IS DISTINCT FROM OLD.portal_open_count
         OR NEW.portal_download_count IS DISTINCT FROM OLD.portal_download_count THEN
        RAISE EXCEPTION 'The portal usage trail is written by the portal, not by a member session. (TRX-4, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;

      -- ── TRX-17 (20261199): the stamp check is the server's record ───────
      -- /api/transmittal/stamp-check writes it (service role) for the draft
      -- it checked; a member session never writes, moves or clears it.
      IF NEW.stamp_check IS DISTINCT FROM OLD.stamp_check THEN
        RAISE EXCEPTION 'The issue-time stamp check is recorded by the server, not by a member session. (TRX-17, 20261199)'
          USING ERRCODE = 'check_violation';
      END IF;

      -- ── TRX-1: issuing, voiding and revoking are transmit authority ─────
      -- The capability policy decides (transmittal.issue), once per item's
      -- LIBRARY (DEC-13: a library rule replaces the base list for that
      -- library); an item whose document is gone — and a transmittal with no
      -- items — is judged on the base list. Drafting stays open to members.
      -- INTK-19 (20261224): asked as the caller (caller_capability_allows;
      -- v_uid is auth.uid() here), now that the uid-taking form is the
      -- service role's and the definers' alone.
      IF (OLD.status = 'draft' AND NEW.status = 'issued')
         OR (NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided')
         OR NEW.portal_revoked_at IS DISTINCT FROM OLD.portal_revoked_at THEN
        IF NEW.items IS NULL OR jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
          IF NOT caller_capability_allows(NEW.org_id, 'transmittal.issue', '{}'::jsonb) THEN
            RAISE EXCEPTION 'Only a transmit authority (the "Issue transmittals" capability) can issue, void or revoke transmittal %. (TRX-1, 20261133)', NEW.number
              USING ERRCODE = 'insufficient_privilege';
          END IF;
        ELSE
          FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
            v_lib := NULL;
            SELECT d.library_id INTO v_lib FROM documents d
             WHERE d.id = NULLIF(it->>'documentId', '')::uuid AND d.org_id = NEW.org_id;
            IF NOT caller_capability_allows(NEW.org_id, 'transmittal.issue',
                 CASE WHEN v_lib IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('libraryId', v_lib::text) END) THEN
              RAISE EXCEPTION 'You do not hold transmit authority (the "Issue transmittals" capability) for % — only a transmit authority for every document on it can issue, void or revoke transmittal %. (TRX-1, 20261133)', COALESCE(it->>'number', it->>'documentId'), NEW.number
                USING ERRCODE = 'insufficient_privilege';
            END IF;
          END LOOP;
        END IF;
      END IF;
    END IF;
  END IF;

  -- ── TRX-3 / TRX-8 / TRX-12: the issue gate, and the as-sent snapshot ─────
  -- On the issue transition every item must name a current, unheld document
  -- of this workspace and that document's CURRENT revision — published, not
  -- superseded, with a stored file. An unpinned item is pinned here — to the
  -- current revision, and only when that is the revision the item names; a
  -- pinned item must still BE the current revision (status truth: the
  -- document's status is written as the status of what was sent). The
  -- database then writes what was sent onto the item (the version, its file
  -- hash and size, the document's status and the revision's effective date),
  -- stamps the issue time with its own clock and gives the portal link its
  -- lifetime.
  IF v_issue THEN
    IF NEW.items IS NULL OR jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
      RAISE EXCEPTION 'A transmittal needs at least one document to be issued. (TRX-3, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NULLIF(btrim(COALESCE(NEW.recipient_name, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.recipient_company, '')), '') IS NULL THEN
      RAISE EXCEPTION 'A transmittal needs a recipient (a name or a company) to be issued. (TRX-3, 20261133)'
        USING ERRCODE = 'check_violation';
    END IF;
    v_items := '[]'::jsonb;
    -- ── TRX-17 (20261199): the server's stamp check, for the draft as issued ─
    -- The check counts only when it was recorded on the draft row as it
    -- stands now (its updated_at): a draft saved after the check is not
    -- what was checked.
    v_check_ok := false;
    IF TG_OP = 'UPDATE' AND jsonb_typeof(NEW.stamp_check) = 'object' AND jsonb_typeof(NEW.stamp_check->'items') = 'array' THEN
      BEGIN
        v_check_ok := COALESCE((NEW.stamp_check->>'draftUpdatedAt')::timestamptz = OLD.updated_at, false);
      EXCEPTION WHEN others THEN
        v_check_ok := false;
      END;
    END IF;
    FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
      v_doc := NULLIF(it->>'documentId', '')::uuid;
      IF v_doc IS NULL THEN
        RAISE EXCEPTION 'Every item on a transmittal must name a document. (TRX-3, 20261133)'
          USING ERRCODE = 'check_violation';
      END IF;
      v_status := NULL; v_archived := NULL; v_current := NULL; v_doc_rev := NULL; v_cur_label := NULL;
      SELECT d.status, d.archived_at, d.current_version_id, d.rev
        INTO v_status, v_archived, v_current, v_doc_rev
        FROM documents d WHERE d.id = v_doc AND d.org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'transmittal item names a document outside this workspace';
      END IF;
      IF v_archived IS NOT NULL OR v_status IN ('Superseded', 'Void', 'Archived') THEN
        RAISE EXCEPTION '% is withdrawn (%) and cannot be issued on a transmittal. (TRX-3, 20261133)', COALESCE(it->>'number', v_doc::text), COALESCE(CASE WHEN v_archived IS NOT NULL THEN 'archived' END, v_status)
          USING ERRCODE = 'check_violation';
      END IF;
      IF EXISTS (SELECT 1 FROM document_holds h WHERE h.document_id = v_doc AND h.released_at IS NULL) THEN
        RAISE EXCEPTION '% is under an active hold — release the hold before issuing it on a transmittal. (HLD-1 / TRX-3, 20261133)', COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT v.revision_label INTO v_cur_label FROM document_versions v
       WHERE v.id = v_current AND v.org_id = NEW.org_id;
      IF v_current IS NULL OR v_cur_label IS NULL THEN
        RAISE EXCEPTION '% has no published file to send. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      -- Status truth: a pin to an older revision (added before a rev-up) is
      -- refused, naming the revision that replaced it.
      v_ver := NULLIF(it->>'versionId', '')::uuid;
      IF v_ver IS NOT NULL AND v_ver IS DISTINCT FROM v_current THEN
        RAISE EXCEPTION '% Rev % has been superseded by Rev % — remove % and add it again to send the current revision. (TRX-3 / TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), COALESCE(NULLIF(btrim(COALESCE(it->>'rev', '')), ''), '?'), btrim(v_cur_label), COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      -- A Rev that is not the current file's label: either the document's own
      -- Rev field drifted from its file (re-adding cannot help — correct the
      -- document), or the item is stale (re-add it).
      IF NULLIF(btrim(COALESCE(it->>'rev', '')), '') IS NOT NULL AND btrim(v_cur_label) IS DISTINCT FROM btrim(it->>'rev') THEN
        IF btrim(COALESCE(v_doc_rev, '')) = btrim(it->>'rev') THEN
          RAISE EXCEPTION '%: the document''s Rev field (%) does not match its current file (Rev %) — correct the document''s revision, then issue. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), btrim(v_doc_rev), btrim(v_cur_label)
            USING ERRCODE = 'check_violation';
        END IF;
        RAISE EXCEPTION '% is listed at Rev %, but its current file is Rev % — remove % and add it again. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), btrim(it->>'rev'), btrim(v_cur_label), COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      v_ver := v_current;
      v_record := NULL; v_label := NULL; v_hash := NULL; v_eff := NULL;
      v_branch := NULL; v_review := NULL; v_key := NULL; v_shed := NULL;
      v_size := NULL; v_superseded := NULL;
      SELECT v.record_id, v.revision_label, v.file_hash, v.effective_date, v.is_branch, v.review_state, v.file_url, v.archived_at, v.size, v.superseded_at
        INTO v_record, v_label, v_hash, v_eff, v_branch, v_review, v_key, v_shed, v_size, v_superseded
        FROM document_versions v WHERE v.id = v_ver AND v.org_id = NEW.org_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'transmittal item names a version outside this workspace';
      END IF;
      IF v_record IS DISTINCT FROM v_doc THEN
        RAISE EXCEPTION 'The revision pinned for % belongs to another document. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text)
          USING ERRCODE = 'check_violation';
      END IF;
      IF COALESCE(v_branch, false) OR v_review IN ('in_review', 'rejected') THEN
        RAISE EXCEPTION '% Rev % is not a published revision (an unreconciled branch or an unreviewed submission). (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), v_label
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_superseded IS NOT NULL THEN
        RAISE EXCEPTION '% Rev % is marked superseded (%) and cannot be issued. (TRX-3, 20261133)', COALESCE(it->>'number', v_doc::text), v_label, v_superseded
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_key IS NULL OR v_shed IS NOT NULL THEN
        RAISE EXCEPTION '% Rev % has no stored file to send. (TRX-12, 20261133)', COALESCE(it->>'number', v_doc::text), v_label
          USING ERRCODE = 'check_violation';
      END IF;
      -- ── TRX-17 (20261199): a server verdict for the file issued, or a yes ─
      -- A PDF goes out only with a server-recorded verdict for the very file
      -- being issued (the version pinned above) — stampable (the mark below
      -- arms the portal's refusal) or not a PDF — or with the issuer's yes to
      -- it leaving without the UNCONTROLLED marking (`stampAccepted` on the
      -- item), recorded here with who and when. Without either the issue is
      -- refused: a PATCH that skips the register's check cannot issue. The
      -- mark is the server's alone; a browser-written one is not kept.
      v_verdict := NULL;
      IF v_check_ok THEN
        SELECT c->>'verdict' INTO v_verdict
          FROM jsonb_array_elements(NEW.stamp_check->'items') c
         WHERE c->>'documentId' = v_doc::text AND c->>'versionId' = v_ver::text
         LIMIT 1;
      END IF;
      v_accepted := COALESCE(it->>'stampAccepted', '') = 'true';
      IF v_verdict IS DISTINCT FROM 'stampable' AND v_verdict IS DISTINCT FROM 'not_pdf' AND NOT v_accepted THEN
        IF v_verdict IS NULL THEN
          RAISE EXCEPTION '% was not issued: no stamp check is recorded for its file as issued (Rev %), and no yes is recorded for it leaving the portal without the UNCONTROLLED marking. Issue it from the register — it checks each file and asks. (TRX-17, 20261199)', COALESCE(it->>'number', v_doc::text), v_label
            USING ERRCODE = 'check_violation';
        END IF;
        RAISE EXCEPTION '% was not issued: the stamp check answered % for its file, so the portal may release it without the UNCONTROLLED marking, and no yes is recorded for that. Issue it from the register — it asks. (TRX-17, 20261199)', COALESCE(it->>'number', v_doc::text), v_verdict
          USING ERRCODE = 'check_violation';
      END IF;
      it := (it - 'stampable' - 'stampAccepted' - 'stampAcceptedBy' - 'stampAcceptedAt' - 'stampVerdict')
            || jsonb_build_object('stampVerdict', COALESCE(v_verdict, 'none'))
            || CASE WHEN v_verdict = 'stampable' THEN jsonb_build_object('stampable', true) ELSE '{}'::jsonb END
            || CASE WHEN v_verdict IS DISTINCT FROM 'stampable' AND v_verdict IS DISTINCT FROM 'not_pdf'
                    THEN jsonb_build_object('stampAccepted', true, 'stampAcceptedBy', v_uid, 'stampAcceptedAt', now())
                    ELSE '{}'::jsonb END;
      v_items := v_items || jsonb_build_array(
        it || jsonb_build_object(
          'versionId', v_ver::text,
          'rev', COALESCE(NULLIF(btrim(COALESCE(it->>'rev', '')), ''), btrim(v_label)),
          'fileHash', v_hash,
          'fileSize', v_size,
          'statusAsSent', v_status,
          'effectiveDate', v_eff));
    END LOOP;
    NEW.items := v_items;
    NEW.issued_at := now();
    NEW.portal_expires_at := now() + interval '90 days';
  END IF;

  -- A write that leaves the items as they were (a draft's other fields, a
  -- void, a revocation, a receipt, the usage trail, a project unlink) has
  -- nothing for the item rail below to re-check: issued items are frozen
  -- above, and a draft's were checked when written. Re-reading them would
  -- refuse every later write once a listed document is deleted — the very
  -- case the snapshot exists to survive.
  IF TG_OP = 'UPDATE' AND NOT v_issue AND NEW.items IS NOT DISTINCT FROM OLD.items THEN
    RETURN NEW;
  END IF;

  -- Every item that names a document or a version must name one in THIS
  -- transmittal's org. `items` is browser-written JSONB, so this is the rail
  -- behind the portal's read-time org scope: a forged cross-org id can never
  -- be persisted, in draft or issued state.
  IF NEW.items IS NOT NULL AND jsonb_typeof(NEW.items) = 'array' THEN
    FOR it IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
      v_doc := NULLIF(it->>'documentId', '')::uuid;
      v_ver := NULLIF(it->>'versionId', '')::uuid;
      IF v_doc IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM documents d WHERE d.id = v_doc AND d.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'transmittal item names a document outside this workspace';
      END IF;
      IF v_ver IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM document_versions v WHERE v.id = v_ver AND v.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'transmittal item names a version outside this workspace';
      END IF;
    END LOOP;
  END IF;

  -- Server-mint the portal token on the ISSUE TRANSITION, overriding whatever
  -- the client sent — so the creator cannot pre-choose (or pre-know via a
  -- predictable value) a token for a row they were not permitted to issue
  -- (EGR-1 done-when 4). Only on the transition: an already-issued transmittal
  -- keeps its live token so re-saves never invalidate the recipient's link.
  IF NEW.status = 'issued'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'issued') THEN
    NEW.portal_token := replace(gen_random_uuid()::text, '-', '')
                        || replace(gen_random_uuid()::text, '-', '');
  END IF;

  RETURN NEW;
END;
$$;

-- ── 11. org_capability_allows_for: service_role (and the definers) only ─────
DO $grants$
DECLARE
  v_blockers bigint;
BEGIN
  SELECT COALESCE(SUM(n), 0) INTO v_blockers FROM intel_i28_20261224_inventory WHERE pre;
  IF v_blockers = 0 THEN
    REVOKE ALL ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION org_capability_allows_for(uuid, text, uuid, jsonb) TO service_role;
  ELSE
    RAISE NOTICE '20261224 left org_capability_allows_for executable by signed-in accounts: % object(s) other than transmittals_guard name it where a client role could reach it (or its definer callers would lose the call); read the precondition rows of the result', v_blockers;
  END IF;
END
$grants$;

COMMIT;

-- ── verification + inventory — ONE result set ───────────────────────────────
-- Probes carry ok (expect true), n NULL; count rows carry n, ok NULL.
SELECT 'user_can_publish_on_library: a client role (the anon key or a signed-in session) is answered only about itself, 42501 otherwise (INTK-19); 20261059''s body otherwise; SECURITY DEFINER, search_path pinned'::text AS "check",
       (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND p.prosrc LIKE '%IF p_uid IS DISTINCT FROM auth.uid()::text%'
               AND p.prosrc LIKE '%user_can_publish_on_library answers a client only about the signed-in caller (INTK-19).%'
               AND p.prosrc LIKE '%(v_idx->''allow''->''orgs''->''publish'') ? p_org::text%'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.user_can_publish_on_library(uuid,text,uuid)')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'user_is_effective_owner: a client role is answered only about itself (42501 otherwise) and never without a workspace; 20261042''s walk otherwise (4 membership tests); SECURITY DEFINER, search_path pinned',
       (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND p.prosrc LIKE '%IF v_client AND p_uid IS DISTINCT FROM auth.uid() THEN%'
               AND p.prosrc LIKE '%IF v_client AND v_org IS NULL THEN%'
               AND (LENGTH(p.prosrc) - LENGTH(REPLACE(p.prosrc, 'member_is_active(', ''))) / LENGTH('member_is_active(') = 4
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.user_is_effective_owner(uuid,uuid,uuid,uuid)')),
       NULL
UNION ALL
SELECT 'org_capability_allows: a client role is answered only about itself (42501 otherwise); it still asks org_capability_allows_for with the empty resource; SECURITY DEFINER, search_path pinned',
       (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND p.prosrc LIKE '%org_capability_allows answers a client only about the signed-in caller (INTK-19).%'
               AND p.prosrc LIKE '%org_capability_allows_for(p_org, p_cap, p_uid, ''{}''::jsonb)%'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_capability_allows(uuid,text,uuid)')),
       NULL
UNION ALL
SELECT 'acl_index_denies: a client role is answered only about itself (42501 otherwise); 20261025''s body otherwise; SECURITY DEFINER, search_path pinned',
       (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND p.prosrc LIKE '%acl_index_denies answers a client only about the signed-in caller (INTK-19).%'
               AND p.prosrc LIKE '%tm.uid = p_uid%'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.acl_index_denies(jsonb,uuid,uuid,text)')),
       NULL
UNION ALL
SELECT 'project_org: a client role reads a project''s workspace only as an active member of it; SECURITY DEFINER, search_path pinned',
       (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND p.prosrc LIKE '%WHERE m.org_id = p.org_id AND m.uid = auth.uid() AND m.status = ''active''%'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.project_org(uuid)')),
       NULL
UNION ALL
SELECT 'effective_owner_matches: the walk for definer code; no client role and not the service role may execute it; search_path pinned; it names no other helper',
       (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND p.prosrc NOT LIKE '%member_is_active%'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.effective_owner_matches(uuid,uuid,uuid,uuid)')),
       NULL
UNION ALL
SELECT 'review_signoff_owner_stamp asks effective_owner_matches about each candidate, so a signed-in INSERT still stamps owner:<uid>; its trigger is still bound; no client role may execute it',
       (SELECT p.prosrc LIKE '%AND effective_owner_matches(v_doc_owner, v_collection, v_library, c.uid)%'
               AND p.prosrc NOT LIKE '%user_is_effective_owner(v_doc_owner, v_collection, v_library, c.uid)%'
               AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_review_signoff_owner_stamp' AND t.tgfoid = p.oid AND NOT t.tgisinternal)
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.review_signoff_owner_stamp()')),
       NULL
UNION ALL
SELECT 'caller_capability_allows: signed-in accounts and the service role may execute it; anon and PUBLIC may not; SECURITY DEFINER, search_path pinned',
       (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.caller_capability_allows(uuid,text,jsonb)')),
       NULL
UNION ALL
SELECT 'transmittals_guard asks caller_capability_allows as the member (TRX-1 unchanged), names org_capability_allows_for nowhere, is still SECURITY INVOKER and still bound',
       (SELECT p.prosrc LIKE '%IF NOT caller_capability_allows(NEW.org_id, ''transmittal.issue'', ''{}''::jsonb) THEN%'
               AND p.prosrc NOT LIKE '%org_capability_allows_for%'
               AND NOT p.prosecdef
               AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'trg_transmittals_guard' AND t.tgfoid = p.oid AND NOT t.tgisinternal)
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.transmittals_guard()')),
       NULL
UNION ALL
SELECT 'precondition: nothing but definers names org_capability_allows_for (no policy, view, default, CHECK, trigger or SECURITY INVOKER function other than transmittals_guard), and every definer that names it keeps the call, so the REVOKE ran (false: it stays executable by signed-in accounts; read the precondition rows)',
       (SELECT COALESCE(SUM(i.n), 0) = 0 FROM intel_i28_20261224_inventory i WHERE i.pre),
       NULL
UNION ALL
SELECT 'org_capability_allows_for: only service_role may execute it (its definer callers call it as its owner); false when the precondition is false',
       (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_capability_allows_for(uuid,text,uuid,jsonb)')),
       NULL
UNION ALL
SELECT 'the five re-created policy helpers keep EXECUTE for anon and authenticated (their policies are written for every role)',
       (SELECT COUNT(*) = 5 AND bool_and(has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          FROM pg_proc p
         WHERE p.oid IN (to_regprocedure('public.user_can_publish_on_library(uuid,text,uuid)'),
                         to_regprocedure('public.user_is_effective_owner(uuid,uuid,uuid,uuid)'),
                         to_regprocedure('public.org_capability_allows(uuid,text,uuid)'),
                         to_regprocedure('public.acl_index_denies(jsonb,uuid,uuid,text)'),
                         to_regprocedure('public.project_org(uuid)'))),
       NULL
UNION ALL
SELECT 'node_visible is not re-created here (intelligence I-30 re-creates it once); its ownership limb still asks user_is_effective_owner about auth.uid()',
       (SELECT p.prosrc LIKE '%user_is_effective_owner(p_owner, p_collection, p_library, auth.uid())%'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.node_visible(text,jsonb,uuid,uuid,uuid,uuid)')),
       NULL
UNION ALL
SELECT 'after: SECURITY DEFINER functions in public the anon role may execute', NULL,
       (SELECT COUNT(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
           AND p.prorettype <> 'trigger'::regtype
           AND has_function_privilege('anon', p.oid, 'EXECUTE'))::text
UNION ALL
SELECT 'after: SECURITY DEFINER functions in public the authenticated role may execute', NULL,
       (SELECT COUNT(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
           AND p.prorettype <> 'trigger'::regtype
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))::text
UNION ALL
SELECT check_name, NULL, n::text FROM (SELECT check_name, n FROM intel_i28_20261224_inventory ORDER BY ord) i;
