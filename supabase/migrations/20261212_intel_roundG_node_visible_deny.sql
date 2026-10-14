-- ─────────────────────────────────────────────────────────────────────────────
-- 20261212 — intelligence Round G, I-12 DOCUMENT ACL BOUNDARY: node_visible
-- honours an explicit read deny for every subject, and on every visibility.
--
--   DACL-12 c1  node_visible() consulted only USER-scoped deny entries: a
--           deny of read / discover whose subject is a ROLE, a TEAM or the
--           WORKSPACE never bound at the database, so a member holding any
--           allow on a private / hidden row read it through PostgREST while
--           the app (lib/acl evaluateRules — a deny of an action wins, OWN-8)
--           refused it. The deny check now names the caller by uid, by ANY
--           held role (role ∪ roles, as the allow branch already does), by
--           each of their teams in the node's org, and by the node's org,
--           BEFORE any allow is read.
--   IEDGE-12 c2 / DACL-1 (read-time half)  a NORMAL-visibility row opened
--           before node_visible looked at its acl_index, so a document whose
--           chain-resolved index (DEC-10: rebuilt from the WHOLE chain at
--           save, at a folder move and nightly) carries an explicit READ deny
--           naming the caller came back to a direct PostgREST read — and
--           through doc_is_visible its document_versions.file_url — while the
--           AI seam and the bytes door (lib/permissions canReadNode, this
--           package) refused it. A normal row whose index carries any read
--           deny entry is now judged: controller, then effective owner, then
--           the deny check; a caller the deny does not name keeps the row
--           (normal stays open — the fail-safe default). FAST PATH: a normal
--           row whose index has no non-empty deny.<subject>.read list returns
--           true from a jsonb test alone, with no table read, exactly as
--           before; the member / team reads run only for the rows a read deny
--           names someone on.
--
--   What this does NOT change (recorded on DACL-1 / DACL-6 / DACL-10, with
--   the inventory below):
--     · a normal row stays open to a member the index does not deny — the
--       app's allow-list on a chain that "says something" (DACL-6 c3) is not
--       mirrored at the database: acl_subject_in_bucket ignores the orgs
--       bucket (the library wizard's "Everyone" grant), so an allow-list here
--       would lock every member out of every "Everyone" library;
--     · the allow on a private / hidden row stays "any allowed action"
--       (DACL-12 c2): RLS answers "may this row be listed", which the app
--       grants on discover OR read (canDiscover / canWithAclChain); per-action
--       read-vs-discover stays in the app layer, as R&P DOCACL-5 recorded;
--     · libraries carry no RESTRICTIVE policy (DACL-10 c1).
--   A folder whose index carries a read deny for a subject it also allows to
--   discover is now hidden from that subject at the database (the app would
--   list its name): the same under-disclosure the user-scoped deny already
--   had; never a grant.
--
--   node_visible(text, jsonb, uuid, uuid, uuid, uuid) is re-created from its
--   NEWEST definition (20261203, found by scanning — lib/__tests__/
--   intelRoundGNodeVisibleDeny.test.ts diffs against it line by line). The
--   3-arg wrapper delegates to it and is untouched; both keep SET
--   search_path = public. CREATE OR REPLACE keeps the function's grants: a
--   policy written for every role calls it, so its
--   EXECUTE is deliberately left as it is (20261203's recorded exception to
--   DRLS-16 — a REVOKE FROM
--   PUBLIC / anon here could make a policy that judges documents for that
--   role raise instead of filtering). It reads only its arguments, the
--   caller's own org_members / team_members rows and the two SECURITY
--   DEFINER helpers it already called.
--
-- Pre-apply inventory (DEC-30, aggregate counts only, BEFORE the
-- transaction): the private / hidden rows a role / team / org deny will now
-- bind on, the normal rows whose index carries a read deny (newly judged),
-- and the normal rows whose index says something without a deny (unchanged;
-- DACL-1 / DACL-6's remaining gap). Never a customer row.
--
-- BEFORE THE PASTE the app already refuses these rows (canReadNode, the
-- library page, the AI seam, the bytes door). AFTER IT a direct PostgREST
-- read refuses them too. A member the deny names stops seeing a row the UI
-- already hid from them; no other member, and no controller or effective
-- owner, sees any change. NARROWS.
-- ORDER: after 20261203 (it carries that file's org-scoped team lookup).
-- Independent of every other pending file. ⚠ APPLIED BY HAND (DEC-30). One
-- script; re-running is safe.
--
-- ROLLBACK: re-paste 20261203's node_visible (section 3 of that file).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS intel_i12_20261212_inventory (check_name text, n bigint);
TRUNCATE intel_i12_20261212_inventory;
INSERT INTO intel_i12_20261212_inventory
SELECT 'before: private / hidden documents whose acl_index denies read or discover to a ROLE, TEAM or ORG (the deny now binds at the database)',
       COUNT(*) FROM documents
 WHERE visibility IN ('private', 'hidden') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->a.act) > 0)
UNION ALL
SELECT 'before: private / hidden folders whose acl_index denies read or discover to a ROLE, TEAM or ORG',
       COUNT(*) FROM collections
 WHERE visibility IN ('private', 'hidden') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['roles', 'teams', 'orgs']) s(subj), unnest(ARRAY['read', 'discover']) a(act)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->a.act) = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->a.act) > 0)
UNION ALL
SELECT 'before: normal-visibility documents whose acl_index denies READ to someone (newly judged; refused to the named only)',
       COUNT(*) FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 'before: normal-visibility folders whose acl_index denies READ to someone',
       COUNT(*) FROM collections
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                  AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0)
UNION ALL
SELECT 'before: normal-visibility documents with an acl_index and no read deny (unchanged — open at the database, an allow-list in the app; DACL-1 / DACL-6 residual)',
       COUNT(*) FROM documents
 WHERE (visibility IS NULL OR visibility = 'normal') AND acl_index IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
                    WHERE jsonb_typeof(acl_index->'deny'->s.subj->'read') = 'array'
                      AND jsonb_array_length(acl_index->'deny'->s.subj->'read') > 0);

BEGIN;

-- ── 1. node_visible: deny for every subject, on every visibility ────────────
-- Body from 20261203 (its newest definition). Changes: the normal fast path
-- reads the index's read-deny lists; the deny check names user, every held
-- role, team and org, and runs before the allow; a normal row the deny does
-- not name returns true after it.
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
  v_normal boolean := (p_visibility IS NULL OR p_visibility = 'normal');
BEGIN
  -- Fail-safe: normal/unset visibility is open to org members — unless the
  -- row's chain-resolved acl_index carries an explicit READ deny (IEDGE-12 /
  -- DACL-1, intelligence I-12). Fast path: no non-empty deny.<subject>.read
  -- list means no table is read and the row is open, as before.
  IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (
       SELECT 1 FROM unnest(ARRAY['users', 'roles', 'teams', 'orgs']) s(subj)
        WHERE jsonb_typeof(p_acl_index->'deny'->s.subj->'read') = 'array'
          AND jsonb_array_length(p_acl_index->'deny'->s.subj->'read') > 0)) THEN
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

  SELECT array_agg(team_id::text) INTO v_teams
    FROM team_members WHERE uid = auth.uid() AND org_id = p_org;

  -- Explicit deny wins (DACL-12): a deny of read — or, on a hidden / private
  -- row, of discover — naming the caller by uid, by ANY held role, by a team
  -- or by the workspace refuses before any allow is read (lib/acl: a deny of
  -- an action wins, OWN-8).
  IF EXISTS (
       SELECT 1 FROM unnest(CASE WHEN v_normal THEN ARRAY['read'] ELSE ARRAY['read', 'discover'] END) a(act)
        WHERE (p_acl_index->'deny'->'users'->a.act) ? v_uid
           OR (p_acl_index->'deny'->'orgs'->a.act) ? p_org::text
           OR EXISTS (SELECT 1 FROM unnest(COALESCE(v_roles, '{}'::text[])) r
                       WHERE (p_acl_index->'deny'->'roles'->a.act) ? r)
           OR EXISTS (SELECT 1 FROM unnest(COALESCE(v_teams, '{}'::text[])) t
                       WHERE (p_acl_index->'deny'->'teams'->a.act) ? t)) THEN
    RETURN false;
  END IF;

  -- A normal row the deny does not name stays open (the fail-safe default).
  IF v_normal THEN
    RETURN true;
  END IF;

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

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'node_visible/6: SECURITY DEFINER, search_path pinned; controller via is_org_controller before the owner branch; every held role; team lookup org-scoped (ORG-13)' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6 AND prosecdef
                  AND proconfig @> ARRAY['search_path=public']
                  AND prosrc LIKE '%IF is_org_controller(p_org) THEN%'
                  AND position('is_org_controller(p_org)' in prosrc) < position('user_is_effective_owner(p_owner' in prosrc)
                  AND prosrc LIKE '%FROM unnest(v_roles) r%'
                  AND prosrc LIKE '%FROM team_members WHERE uid = auth.uid() AND org_id = p_org;%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'node_visible/6: the deny check names user, every held role, team and org (DACL-12 c1), and runs before the allow',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%(p_acl_index->''deny''->''users''->a.act) ? v_uid%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''orgs''->a.act) ? p_org::text%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''roles''->a.act) ? r%'
                  AND prosrc LIKE '%(p_acl_index->''deny''->''teams''->a.act) ? t%'
                  AND position('''deny''->''teams''' in prosrc) < position('acl_subject_in_bucket(p_acl_index->''allow''' in prosrc)),
       NULL
UNION ALL
SELECT 'node_visible/6: a normal row reads its index''s read-deny lists before opening (IEDGE-12 c2), with no table read on the fast path',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 6
                  AND prosrc LIKE '%IF v_normal AND (p_acl_index IS NULL OR NOT EXISTS (%'
                  AND position('IF v_normal AND (p_acl_index IS NULL' in prosrc) < position('is_org_controller(p_org)' in prosrc)),
       NULL
UNION ALL
SELECT 'node_visible/3 and /6 both carry SET search_path = public; the 3-arg wrapper still delegates',
       (SELECT COUNT(*) = 2 FROM pg_proc WHERE proname = 'node_visible' AND pronargs IN (3, 6)
          AND proconfig @> ARRAY['search_path=public'])
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'node_visible' AND pronargs = 3
                      AND prosrc LIKE '%node_visible(p_visibility, p_acl_index, p_org, NULL::uuid, NULL::uuid, NULL::uuid)%'),
       NULL
UNION ALL
SELECT 'behaviour (no session): a normal row with no index is open; a normal row whose read deny names nobody here is open; a private row with no index is closed',
       node_visible('normal', NULL::jsonb, '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL)
       AND node_visible('normal', '{"deny":{"users":{"read":["00000000-0000-0000-0000-0000000000aa"]}}}'::jsonb,
                        '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL)
       AND NOT node_visible('private', NULL::jsonb, '00000000-0000-0000-0000-000000000000'::uuid, NULL, NULL, NULL),
       NULL
UNION ALL
SELECT 'documents_acl_select and collections_acl_select still call the 6-arg node_visible',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE schemaname = 'public' AND policyname IN ('documents_acl_select', 'collections_acl_select')
           AND permissive = 'RESTRICTIVE' AND qual LIKE '%node_visible(visibility, acl_index, org_id, owner_user_id,%'),
       NULL
UNION ALL
SELECT check_name, NULL, n::text FROM intel_i12_20261212_inventory;
