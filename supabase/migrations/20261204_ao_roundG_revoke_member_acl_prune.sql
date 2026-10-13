-- ─────────────────────────────────────────────────────────────────────────────
-- 20261204 — admin-and-org Round G, P8 ORG-ADMIN SURFACES, migration B:
-- a removed member's personal ACL grants die with the membership (ORG-7), the
-- capability-policy grant strip is visible to the policy route's
-- compare-and-set (ALOG-15), and a library deletion leaves its record
-- (ALOG-3).
--
--   ORG-7   revoke_member (REMOVE) cleared ownership, checkouts, capability
--           grants and rosters, but left every explicit per-user ALLOW rule
--           naming the removed uid inside libraries / collections /
--           documents / document_sets `acl` and `acl_index` — a re-added
--           person got them all back, and a recertification listed them.
--     · Three pure helpers (LANGUAGE sql IMMUTABLE, SECURITY INVOKER,
--       search_path pinned, EXECUTE revoked from PUBLIC / anon /
--       authenticated — only definer paths call them):
--         acl_allow_user_ids(acl, acl_index)         the user ids an ALLOW
--                                                    rule or allow bucket names
--         acl_without_user_allow(acl, uids[])        the acl minus those
--                                                    users' ALLOW rules
--         acl_index_without_user_allow(idx, uids[])  the index minus those
--                                                    users in the allow buckets
--       DENY rules are kept (a block outlives the membership); grants by
--       role, team or org are untouched; an acl whose rules all go keeps its
--       object with `rules: []` (an ACL with no rule grants nothing — it is
--       NOT read as "no ACL", so nothing widens). The index strip is the
--       exact image of the nightly rebuild (lib/aclIndexRebuild.ts): the
--       builder fills allow and deny buckets independently, so dropping a
--       uid's allow rules removes it from every allow user list and from
--       nothing else (pinned in lib/__tests__/aoRoundGP8Migrations.test.ts
--       against buildAclIndexFromChain). DEC-90 ruling for this package:
--       PRUNE in revoke_member's transaction, never flag.
--     · revoke_member(uuid, text) re-created from its NEWEST definition
--       (20261161 — found by scanning; it carries 20261043 §0's TEXT[] lock
--       clear and N5's NEDGE-7 tombstone) with, on the REMOVE path only,
--       after the capability-grant strip and before the roster deletes: the
--       four prune UPDATEs (libraries also prune default_new_acl, the
--       template new nodes copy) and one MEMBER_ACL_GRANTS_PRUNED audit row
--       with the counts when anything was pruned. Suspend and restore are
--       unchanged (a suspended member keeps their grants for their return;
--       every evaluator refuses a non-active member).
--     · Grants that ALREADY name someone with no membership in the node's
--       workspace (removed before this paste) are pruned once here, inside
--       the transaction, counted before it, one machine audit row per
--       workspace (ACL_STALE_GRANTS_PRUNED, user_id NULL). An inactive or
--       suspended member still has a membership row and is NOT touched.
--   ALOG-15 the grant strip rewrote org_configurations.data without
--           touching updated_at, so the capability-policy route's
--           compare-and-set (.eq("updated_at", stored)) could not see it and
--           a concurrent save wrote the removed member's grant back. One
--           changed line: `SET updated_at = NOW(), data = jsonb_set(…`.
--   ALOG-4  the MEMBER_REMOVED row names the roles the removal ended
--           (rolesBefore / rolesAfter) and the ACL grants it pruned — one
--           changed line in its jsonb_build_object, two added.
--   ALOG-3  a library DELETE cascades to every folder, document and
--           revision and wrote no audit row. trg_library_delete_audit
--           (BEFORE DELETE on libraries, SECURITY DEFINER) counts what the
--           cascade is about to remove — folders, documents, revisions, open
--           holds, legal holds, requests raised from its documents — and
--           writes LIBRARY_DELETED in the SAME statement: if the audit row
--           cannot be written the delete fails, and a delete a guard refuses
--           (a legal hold, 20261149's evidence guard) rolls the row back
--           with it. The app's delete route (/api/admin/libraries/delete)
--           writes its own row only when it finds none from this trigger,
--           so before this paste every deletion is still recorded, and after
--           it there is exactly one row.
--
-- PRE-APPLY INVENTORY (DEC-30, counts only, BEFORE the transaction): the
-- stale per-user grants by table, the library-delete rows so far, and
-- whether 20261161 (the tombstone column this body writes) is in place.
--
-- DEPLOY / PASTE ORDER: paste 20261161 FIRST — this body writes
-- notifications.org_tombstoned_at, and the script stops with a message if
-- that column is missing (a re-created revoke_member without it would fail
-- every removal with 42703). Either order with the P8 deploy: before the
-- paste a removal works as today (grants not pruned, the strip unstamped),
-- and the delete route records each library deletion itself; after it the
-- route finds the trigger's row and adds none.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (the backfill
-- finds nothing the second time).
--
-- ROLLBACK: re-paste 20261161's revoke_member (its § 4) — the removal path
-- returns exactly; DROP TRIGGER trg_library_delete_audit ON libraries; DROP
-- FUNCTION audit_library_delete(); the helpers may stay (nothing else calls
-- them). Pruned grants are named, per workspace, in their audit rows.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'org_tombstoned_at') THEN
    RAISE EXCEPTION 'Paste 20261161_notif_roundG_read_scope.sql first: revoke_member''s newest body writes notifications.org_tombstoned_at. Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'org_configurations' AND column_name = 'updated_at') THEN
    RAISE EXCEPTION 'org_configurations.updated_at is missing — the capability-policy route''s compare-and-set needs it. Nothing was changed.';
  END IF;
END $$;

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS ao_p8_20261204_inventory (check_name text, n bigint);
TRUNCATE ao_p8_20261204_inventory;
INSERT INTO ao_p8_20261204_inventory
SELECT 'before: libraries with an ALLOW grant (acl, index or new-node template) naming someone with no membership here', COUNT(*)
  FROM libraries t
 WHERE EXISTS (SELECT 1 FROM unnest(
         ARRAY(SELECT r->'subject'->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.acl->'rules') = 'array' THEN t.acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->'subject'->>'type' = 'user' AND COALESCE(r->>'effect', '') <> 'deny')
         || ARRAY(SELECT r->'subject'->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.default_new_acl->'rules') = 'array' THEN t.default_new_acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->'subject'->>'type' = 'user' AND COALESCE(r->>'effect', '') <> 'deny')
         || ARRAY(SELECT e #>> '{}' FROM jsonb_each(CASE WHEN jsonb_typeof(t.acl_index->'allow'->'users') = 'object' THEN t.acl_index->'allow'->'users' ELSE '{}'::jsonb END) b(k, v),
                  jsonb_array_elements(CASE WHEN jsonb_typeof(b.v) = 'array' THEN b.v ELSE '[]'::jsonb END) e)) u
       WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u))
UNION ALL
SELECT 'before: folders with such a grant', COUNT(*)
  FROM collections t
 WHERE t.org_id IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(
         ARRAY(SELECT r->'subject'->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.acl->'rules') = 'array' THEN t.acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->'subject'->>'type' = 'user' AND COALESCE(r->>'effect', '') <> 'deny')
         || ARRAY(SELECT e #>> '{}' FROM jsonb_each(CASE WHEN jsonb_typeof(t.acl_index->'allow'->'users') = 'object' THEN t.acl_index->'allow'->'users' ELSE '{}'::jsonb END) b(k, v),
                  jsonb_array_elements(CASE WHEN jsonb_typeof(b.v) = 'array' THEN b.v ELSE '[]'::jsonb END) e)) u
       WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u))
UNION ALL
SELECT 'before: documents with such a grant', COUNT(*)
  FROM documents t
 WHERE t.org_id IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(
         ARRAY(SELECT r->'subject'->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.acl->'rules') = 'array' THEN t.acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->'subject'->>'type' = 'user' AND COALESCE(r->>'effect', '') <> 'deny')
         || ARRAY(SELECT e #>> '{}' FROM jsonb_each(CASE WHEN jsonb_typeof(t.acl_index->'allow'->'users') = 'object' THEN t.acl_index->'allow'->'users' ELSE '{}'::jsonb END) b(k, v),
                  jsonb_array_elements(CASE WHEN jsonb_typeof(b.v) = 'array' THEN b.v ELSE '[]'::jsonb END) e)) u
       WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u))
UNION ALL
SELECT 'before: document sets with such a grant', COUNT(*)
  FROM document_sets t
 WHERE t.org_id IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(
         ARRAY(SELECT r->'subject'->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.acl->'rules') = 'array' THEN t.acl->'rules' ELSE '[]'::jsonb END) r
                WHERE r->'subject'->>'type' = 'user' AND COALESCE(r->>'effect', '') <> 'deny')
         || ARRAY(SELECT e #>> '{}' FROM jsonb_each(CASE WHEN jsonb_typeof(t.acl_index->'allow'->'users') = 'object' THEN t.acl_index->'allow'->'users' ELSE '{}'::jsonb END) b(k, v),
                  jsonb_array_elements(CASE WHEN jsonb_typeof(b.v) = 'array' THEN b.v ELSE '[]'::jsonb END) e)) u
       WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u))
UNION ALL
SELECT 'before: LIBRARY_DELETED audit rows (all time)', COUNT(*) FROM audit_logs WHERE action = 'LIBRARY_DELETED'
UNION ALL
SELECT 'before: trg_library_delete_audit present (1 = a re-run)', COUNT(*) FROM pg_trigger
 WHERE tgrelid = 'public.libraries'::regclass AND tgname = 'trg_library_delete_audit' AND NOT tgisinternal;

BEGIN;

-- ── 1. ORG-7: the pure helpers ──────────────────────────────────────────────
-- The user ids an ALLOW rule of `p_acl` or an allow user bucket of `p_idx`
-- names. A rule is an allow unless its effect is 'deny' (lib/acl.ts reads it
-- the same way). Malformed shapes contribute nothing.
CREATE OR REPLACE FUNCTION acl_allow_user_ids(p_acl jsonb, p_idx jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT u), '{}'::text[]) FROM (
    SELECT r->'subject'->>'id' AS u
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_acl->'rules') = 'array' THEN p_acl->'rules' ELSE '[]'::jsonb END) r
     WHERE jsonb_typeof(r) = 'object' AND r->'subject'->>'type' = 'user'
       AND COALESCE(r->>'effect', '') <> 'deny' AND r->'subject'->>'id' IS NOT NULL
    UNION
    SELECT e #>> '{}'
      FROM jsonb_each(CASE WHEN jsonb_typeof(p_idx->'allow'->'users') = 'object' THEN p_idx->'allow'->'users' ELSE '{}'::jsonb END) b(k, v),
           jsonb_array_elements(CASE WHEN jsonb_typeof(b.v) = 'array' THEN b.v ELSE '[]'::jsonb END) e
     WHERE jsonb_typeof(e) = 'string'
  ) s;
$$;

-- `p_acl` without the ALLOW rules whose subject is one of `p_uids`. Deny
-- rules, other subjects and every other key are kept; NULL / a non-array
-- `rules` comes back as given.
CREATE OR REPLACE FUNCTION acl_without_user_allow(p_acl jsonb, p_uids text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_acl IS NULL OR jsonb_typeof(p_acl->'rules') IS DISTINCT FROM 'array' OR p_uids IS NULL THEN p_acl
    ELSE jsonb_set(p_acl, '{rules}', COALESCE((
      SELECT jsonb_agg(r ORDER BY ord)
        FROM jsonb_array_elements(p_acl->'rules') WITH ORDINALITY AS x(r, ord)
       WHERE NOT (jsonb_typeof(r) = 'object' AND r->'subject'->>'type' = 'user'
                  AND COALESCE(r->>'effect', '') <> 'deny'
                  AND r->'subject'->>'id' = ANY(p_uids))), '[]'::jsonb))
  END;
$$;

-- `p_idx` with `p_uids` removed from every allow->users action list. The
-- deny buckets, the role / team / org buckets and every other key are kept.
CREATE OR REPLACE FUNCTION acl_index_without_user_allow(p_idx jsonb, p_uids text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_idx IS NULL OR jsonb_typeof(p_idx->'allow'->'users') IS DISTINCT FROM 'object' OR p_uids IS NULL THEN p_idx
    ELSE jsonb_set(p_idx, '{allow,users}', COALESCE((
      SELECT jsonb_object_agg(b.k, CASE WHEN jsonb_typeof(b.v) = 'array' THEN COALESCE((
               SELECT jsonb_agg(e ORDER BY ord)
                 FROM jsonb_array_elements(b.v) WITH ORDINALITY AS y(e, ord)
                WHERE NOT (jsonb_typeof(e) = 'string' AND (e #>> '{}') = ANY(p_uids))), '[]'::jsonb)
             ELSE b.v END)
        FROM jsonb_each(p_idx->'allow'->'users') b(k, v)), '{}'::jsonb))
  END;
$$;

REVOKE ALL ON FUNCTION acl_allow_user_ids(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION acl_without_user_allow(jsonb, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION acl_index_without_user_allow(jsonb, text[]) FROM PUBLIC, anon, authenticated;

-- ── 2. ORG-7 + ALOG-15: revoke_member, from its NEWEST body (20261161) ──────
-- Two additions, both on the REMOVE path: the grant strip stamps updated_at
-- (one changed line), and the ACL prune block after it. Nothing else in the
-- body changes — lib/__tests__/aoRoundGP8Migrations.test.ts finds the newest
-- earlier definition by scanning supabase/migrations and allows exactly
-- these lines.
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
  v_acl_libs int := 0;
  v_acl_cols int := 0;
  v_acl_docs int := 0;
  v_acl_sets int := 0;
  v_rule_probe jsonb;
  v_bucket_probe jsonpath;
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
  -- ALOG-15 (admin-and-org Round G, 20261204): the strip stamps updated_at,
  -- so the policy route's compare-and-set sees it and answers 409 to a save
  -- built from a policy that still held this member's grant.
  UPDATE org_configurations
     SET updated_at = NOW(), data = jsonb_set(data, '{grants}',
           COALESCE((SELECT jsonb_agg(g) FROM jsonb_array_elements(data->'grants') g
                      WHERE g->>'uid' <> v_member.uid::text), '[]'::jsonb))
   WHERE org_id = v_member.org_id AND key = 'capability_policy'
     AND jsonb_typeof(data->'grants') = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'grants') g WHERE g->>'uid' = v_member.uid::text);
  GET DIAGNOSTICS v_grants = ROW_COUNT;

  -- ORG-7 (admin-and-org Round G, 20261204): per-person ACL ALLOW rules
  -- naming the removed member are pruned in this transaction — from each
  -- node's own `acl`, from its chain-resolved `acl_index` allow buckets (the
  -- exact image of the rebuild: allow and deny buckets are built
  -- independently, so dropping this uid's allow rules drops it from every
  -- allow user list and from nothing else), and from a library's template
  -- for new nodes. DENY rules naming them are KEPT: a block outlives the
  -- membership, so a re-added person is still refused where they were.
  -- Grants by role, team or org are not touched.
  -- Each scan is narrowed BEFORE the exact check by two binary jsonb tests,
  -- built once here (no text cast of any row, no per-row construction):
  -- containment for a rule naming the uid, and a jsonpath for an allow
  -- bucket naming it. Both are supersets of the exact check
  -- (acl_allow_user_ids), so nothing is missed. The cost is set by the rows
  -- REWRITTEN, not by the scan: should a removal exceed the caller's
  -- statement_timeout (a personal grant indexed into tens of thousands of
  -- descendants), the whole call rolls back (57014) — the member stays,
  -- nothing is half-pruned, and the Admin sees the error (ORG-7 record).
  v_rule_probe := jsonb_build_object('rules', jsonb_build_array(jsonb_build_object('subject', jsonb_build_object('type', 'user', 'id', v_member.uid::text))));
  v_bucket_probe := format('$.allow.users.*[*] ? (@ == "%s")', v_member.uid::text)::jsonpath;
  UPDATE libraries
     SET acl = acl_without_user_allow(acl, ARRAY[v_member.uid::text]),
         acl_index = acl_index_without_user_allow(acl_index, ARRAY[v_member.uid::text]),
         default_new_acl = acl_without_user_allow(default_new_acl, ARRAY[v_member.uid::text])
   WHERE org_id = v_member.org_id
     AND (acl @> v_rule_probe OR default_new_acl @> v_rule_probe OR acl_index @? v_bucket_probe)
     AND v_member.uid::text = ANY(acl_allow_user_ids(acl, acl_index) || acl_allow_user_ids(default_new_acl, NULL));
  GET DIAGNOSTICS v_acl_libs = ROW_COUNT;
  UPDATE collections
     SET acl = acl_without_user_allow(acl, ARRAY[v_member.uid::text]),
         acl_index = acl_index_without_user_allow(acl_index, ARRAY[v_member.uid::text])
   WHERE org_id = v_member.org_id
     AND (acl @> v_rule_probe OR acl_index @? v_bucket_probe)
     AND v_member.uid::text = ANY(acl_allow_user_ids(acl, acl_index));
  GET DIAGNOSTICS v_acl_cols = ROW_COUNT;
  UPDATE documents
     SET acl = acl_without_user_allow(acl, ARRAY[v_member.uid::text]),
         acl_index = acl_index_without_user_allow(acl_index, ARRAY[v_member.uid::text])
   WHERE org_id = v_member.org_id
     AND (acl @> v_rule_probe OR acl_index @? v_bucket_probe)
     AND v_member.uid::text = ANY(acl_allow_user_ids(acl, acl_index));
  GET DIAGNOSTICS v_acl_docs = ROW_COUNT;
  UPDATE document_sets
     SET acl = acl_without_user_allow(acl, ARRAY[v_member.uid::text]),
         acl_index = acl_index_without_user_allow(acl_index, ARRAY[v_member.uid::text])
   WHERE org_id = v_member.org_id
     AND (acl @> v_rule_probe OR acl_index @? v_bucket_probe)
     AND v_member.uid::text = ANY(acl_allow_user_ids(acl, acl_index));
  GET DIAGNOSTICS v_acl_sets = ROW_COUNT;
  IF v_acl_libs + v_acl_cols + v_acl_docs + v_acl_sets > 0 THEN
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
    VALUES ('MEMBER_ACL_GRANTS_PRUNED', v_member.uid::text, 'member', v_member.org_id, v_actor, v_actor_email,
            jsonb_build_object('memberId', p_member_id, 'memberEmail', v_member.email, 'reason', 'member_removed',
                               'libraries', v_acl_libs, 'collections', v_acl_cols,
                               'documents', v_acl_docs, 'documentSets', v_acl_sets));
  END IF;

  -- Team and project rosters (team_members has no FK to org_members), and
  -- the member's follow subscriptions (their RLS is self-only, so only this
  -- definer path can clear them; otherwise fan-out keeps writing to a dead uid).
  DELETE FROM subscriptions WHERE org_id = v_member.org_id AND user_id = v_member.uid;
  DELETE FROM team_members WHERE org_id = v_member.org_id AND uid = v_member.uid;
  DELETE FROM project_members pm USING projects p
   WHERE pm.project_id = p.id AND p.org_id = v_member.org_id AND pm.user_id = v_member.uid;
  -- NEDGE-7 (notifications Round G, 20261161): the member's notifications in
  -- this org are tombstoned, not deleted — the archive stays for
  -- investigators; the read policy hides a tombstoned row from its recipient
  -- for good, so a re-added member starts with an empty bell.
  UPDATE notifications SET org_tombstoned_at = NOW()
   WHERE org_id = v_member.org_id AND user_id = v_member.uid AND org_tombstoned_at IS NULL;

  -- The membership itself. The last-admin trigger fires here.
  DELETE FROM org_members WHERE id = p_member_id;

  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, details)
  VALUES ('MEMBER_REMOVED', v_member.uid::text, 'member', v_member.org_id, v_actor, v_actor_email,
          jsonb_build_object('memberId', p_member_id, 'memberEmail', v_member.email,
                             'clearedLibraries', v_libs, 'clearedCollections', v_cols,
                             'clearedDocuments', v_docs, 'clearedTeams', v_teams,
                             'endedCheckouts', v_checkouts, 'revokedGrants', v_grants,
                             -- ALOG-4 (20261204): the removal names the roles it ended.
                             'rolesBefore', to_jsonb(COALESCE(v_member.roles, ARRAY[v_member.role])), 'rolesAfter', '[]'::jsonb,
                             'prunedAclGrants', v_acl_libs + v_acl_cols + v_acl_docs + v_acl_sets));

  RETURN jsonb_build_object(
    'mode', 'remove', 'uid', v_member.uid,
    'cleared', jsonb_build_object('libraries', v_libs, 'collections', v_cols, 'documents', v_docs, 'teams', v_teams),
    'endedCheckouts', v_checkouts, 'revokedGrants', v_grants
  );
END;
$$;

REVOKE ALL ON FUNCTION revoke_member(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION revoke_member(uuid, text) TO authenticated;

-- ── 3. ORG-7: grants that already name someone with no membership ───────────
-- One pass per table; one machine audit row per workspace with the counts.
CREATE TEMP TABLE IF NOT EXISTS ao_p8_20261204_backfill (org_id uuid, tbl text, n bigint);
TRUNCATE ao_p8_20261204_backfill;

WITH gone AS (
  SELECT t.id, t.org_id,
         ARRAY(SELECT u FROM unnest(acl_allow_user_ids(t.acl, t.acl_index) || acl_allow_user_ids(t.default_new_acl, NULL)) u
                WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u)) AS uids
    FROM libraries t
   WHERE t.acl IS NOT NULL OR t.acl_index IS NOT NULL OR t.default_new_acl IS NOT NULL
), done AS (
  UPDATE libraries l
     SET acl = acl_without_user_allow(l.acl, g.uids),
         acl_index = acl_index_without_user_allow(l.acl_index, g.uids),
         default_new_acl = acl_without_user_allow(l.default_new_acl, g.uids)
    FROM gone g
   WHERE l.id = g.id AND cardinality(g.uids) > 0
  RETURNING l.org_id
)
INSERT INTO ao_p8_20261204_backfill SELECT org_id, 'libraries', COUNT(*) FROM done GROUP BY org_id;

WITH gone AS (
  SELECT t.id, t.org_id,
         ARRAY(SELECT u FROM unnest(acl_allow_user_ids(t.acl, t.acl_index)) u
                WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u)) AS uids
    FROM collections t
   WHERE t.org_id IS NOT NULL AND (t.acl IS NOT NULL OR t.acl_index IS NOT NULL)
), done AS (
  UPDATE collections c
     SET acl = acl_without_user_allow(c.acl, g.uids),
         acl_index = acl_index_without_user_allow(c.acl_index, g.uids)
    FROM gone g
   WHERE c.id = g.id AND cardinality(g.uids) > 0
  RETURNING c.org_id
)
INSERT INTO ao_p8_20261204_backfill SELECT org_id, 'collections', COUNT(*) FROM done GROUP BY org_id;

WITH gone AS (
  SELECT t.id, t.org_id,
         ARRAY(SELECT u FROM unnest(acl_allow_user_ids(t.acl, t.acl_index)) u
                WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u)) AS uids
    FROM documents t
   WHERE t.org_id IS NOT NULL AND (t.acl IS NOT NULL OR t.acl_index IS NOT NULL)
), done AS (
  UPDATE documents d
     SET acl = acl_without_user_allow(d.acl, g.uids),
         acl_index = acl_index_without_user_allow(d.acl_index, g.uids)
    FROM gone g
   WHERE d.id = g.id AND cardinality(g.uids) > 0
  RETURNING d.org_id
)
INSERT INTO ao_p8_20261204_backfill SELECT org_id, 'documents', COUNT(*) FROM done GROUP BY org_id;

WITH gone AS (
  SELECT t.id, t.org_id,
         ARRAY(SELECT u FROM unnest(acl_allow_user_ids(t.acl, t.acl_index)) u
                WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u)) AS uids
    FROM document_sets t
   WHERE t.org_id IS NOT NULL AND (t.acl IS NOT NULL OR t.acl_index IS NOT NULL)
), done AS (
  UPDATE document_sets s
     SET acl = acl_without_user_allow(s.acl, g.uids),
         acl_index = acl_index_without_user_allow(s.acl_index, g.uids)
    FROM gone g
   WHERE s.id = g.id AND cardinality(g.uids) > 0
  RETURNING s.org_id
)
INSERT INTO ao_p8_20261204_backfill SELECT org_id, 'document_sets', COUNT(*) FROM done GROUP BY org_id;

INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details, metadata)
SELECT 'ACL_STALE_GRANTS_PRUNED', b.org_id::text, 'org', b.org_id, NULL, 'system:migration-20261204', 'system',
       jsonb_build_object('reason', 'grant_names_no_member', 'migration', '20261204',
                          'libraries', COALESCE(SUM(b.n) FILTER (WHERE b.tbl = 'libraries'), 0),
                          'collections', COALESCE(SUM(b.n) FILTER (WHERE b.tbl = 'collections'), 0),
                          'documents', COALESCE(SUM(b.n) FILTER (WHERE b.tbl = 'documents'), 0),
                          'documentSets', COALESCE(SUM(b.n) FILTER (WHERE b.tbl = 'document_sets'), 0)),
       jsonb_build_object('actor_kind', 'system')
  FROM ao_p8_20261204_backfill b
 GROUP BY b.org_id;

-- ── 4. ALOG-3: a library deletion is recorded in its own statement ──────────
CREATE OR REPLACE FUNCTION audit_library_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_email text;
  v_folders bigint;
  v_docs bigint;
  v_revs bigint;
  v_holds bigint;
  v_legal bigint;
  v_tickets bigint;
BEGIN
  -- Counted BEFORE the cascade runs (a BEFORE row trigger fires first).
  SELECT COUNT(*) INTO v_folders FROM collections WHERE library_id = OLD.id;
  SELECT COUNT(*), COUNT(*) FILTER (WHERE legal_hold IS TRUE) INTO v_docs, v_legal FROM documents WHERE library_id = OLD.id;
  SELECT COUNT(*) INTO v_revs FROM document_versions v JOIN documents d ON d.id = v.record_id WHERE d.library_id = OLD.id;
  SELECT COUNT(*) INTO v_holds FROM document_holds h JOIN documents d ON d.id = h.document_id
   WHERE d.library_id = OLD.id AND h.released_at IS NULL;
  SELECT COUNT(*) INTO v_tickets FROM tickets t
   WHERE t.org_id = OLD.org_id
     AND (t.metadata -> 'source_document' ->> 'id') IN (SELECT d.id::text FROM documents d WHERE d.library_id = OLD.id);
  IF v_actor IS NOT NULL THEN
    SELECT email INTO v_email FROM org_members WHERE uid = v_actor AND org_id = OLD.org_id LIMIT 1;
  END IF;
  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, user_email, user_role, details, metadata)
  VALUES ('LIBRARY_DELETED', OLD.id::text, 'library', OLD.org_id, v_actor,
          CASE WHEN v_actor IS NULL THEN 'system:library-delete' ELSE v_email END,
          CASE WHEN v_actor IS NULL THEN 'system' ELSE NULL END,
          jsonb_build_object('name', OLD.name, 'via', 'database',
                             'folders', v_folders, 'documents', v_docs, 'revisions', v_revs,
                             'openHolds', v_holds, 'legalHolds', v_legal, 'requests', v_tickets),
          CASE WHEN v_actor IS NULL THEN jsonb_build_object('actor_kind', 'system') ELSE NULL END);
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION audit_library_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_library_delete_audit ON libraries;
CREATE TRIGGER trg_library_delete_audit
  BEFORE DELETE ON libraries
  FOR EACH ROW EXECUTE FUNCTION audit_library_delete();

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'revoke_member keeps its newest body: SECURITY DEFINER, search_path pinned, the self-guard, the TEXT[] lock clear, the NEDGE-7 tombstone' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member' AND prosecdef
                  AND proconfig @> ARRAY['search_path=public']
                  AND prosrc LIKE '%You can''''t suspend or remove yourself.%'
                  AND prosrc LIKE '%active_collaborators = ''{}''::text[]%'
                  AND prosrc LIKE '%UPDATE notifications SET org_tombstoned_at = NOW()%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'revoke_member: the capability-grant strip stamps updated_at (ALOG-15)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member'
                  AND prosrc LIKE '%SET updated_at = NOW(), data = jsonb_set(data, ''{grants}'',%'),
       NULL
UNION ALL
SELECT 'revoke_member: REMOVE prunes per-user ALLOW rules on all four node tables, after the grant strip and before the membership delete (ORG-7)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member'
                  AND prosrc LIKE '%GET DIAGNOSTICS v_grants = ROW_COUNT;%UPDATE libraries%acl_without_user_allow(acl, ARRAY[v_member.uid::text])%UPDATE collections%UPDATE documents%UPDATE document_sets%MEMBER_ACL_GRANTS_PRUNED%DELETE FROM org_members WHERE id = p_member_id;%'),
       NULL
UNION ALL
SELECT 'revoke_member: anon and PUBLIC cannot execute it, authenticated can',
       NOT has_function_privilege('anon', 'revoke_member(uuid, text)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'revoke_member(uuid, text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'the three ACL helpers: IMMUTABLE, SECURITY INVOKER, search_path pinned, not executable by anon or authenticated',
       (SELECT COUNT(*) = 3 FROM pg_proc
         WHERE proname IN ('acl_allow_user_ids', 'acl_without_user_allow', 'acl_index_without_user_allow')
           AND provolatile = 'i' AND NOT prosecdef AND proconfig @> ARRAY['search_path=public'])
       AND NOT has_function_privilege('anon', 'acl_without_user_allow(jsonb, text[])', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'acl_index_without_user_allow(jsonb, text[])', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'self-test: an allow for X goes, a deny for X and an allow for Y stay; the index loses X from allow only',
       acl_without_user_allow('{"inherit":true,"rules":[{"effect":"allow","subject":{"type":"user","id":"X"},"actions":["read"]},{"effect":"deny","subject":{"type":"user","id":"X"},"actions":["read"]},{"effect":"allow","subject":{"type":"user","id":"Y"},"actions":["read"]}]}'::jsonb, ARRAY['X'])
         = '{"inherit":true,"rules":[{"effect":"deny","subject":{"type":"user","id":"X"},"actions":["read"]},{"effect":"allow","subject":{"type":"user","id":"Y"},"actions":["read"]}]}'::jsonb
       AND acl_index_without_user_allow('{"allow":{"users":{"read":["X","Y"],"write":["X"]},"roles":{"read":["X"]}},"deny":{"users":{"read":["X"]}}}'::jsonb, ARRAY['X'])
         = '{"allow":{"users":{"read":["Y"],"write":[]},"roles":{"read":["X"]}},"deny":{"users":{"read":["X"]}}}'::jsonb,
       NULL
UNION ALL
SELECT 'no ALLOW grant on a library, folder, document or set names someone with no membership in its workspace',
       NOT EXISTS (SELECT 1 FROM libraries t, unnest(acl_allow_user_ids(t.acl, t.acl_index) || acl_allow_user_ids(t.default_new_acl, NULL)) u
                    WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u))
       AND NOT EXISTS (SELECT 1 FROM collections t, unnest(acl_allow_user_ids(t.acl, t.acl_index)) u
                    WHERE t.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u))
       AND NOT EXISTS (SELECT 1 FROM documents t, unnest(acl_allow_user_ids(t.acl, t.acl_index)) u
                    WHERE t.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u))
       AND NOT EXISTS (SELECT 1 FROM document_sets t, unnest(acl_allow_user_ids(t.acl, t.acl_index)) u
                    WHERE t.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.uid::text = u)),
       NULL
UNION ALL
SELECT 'trg_library_delete_audit: BEFORE DELETE, row-level, enabled; SECURITY DEFINER, search_path pinned, writes LIBRARY_DELETED with the counts; not executable by anon or authenticated (ALOG-3)',
       EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                WHERE tg.tgrelid = 'public.libraries'::regclass AND tg.tgname = 'trg_library_delete_audit'
                  AND NOT tg.tgisinternal AND tg.tgenabled = 'O'
                  AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 8) = 8
                  AND p.proname = 'audit_library_delete' AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                  AND p.prosrc LIKE '%''LIBRARY_DELETED''%' AND p.prosrc LIKE '%''revisions'', v_revs%')
       AND NOT has_function_privilege('anon', 'audit_library_delete()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'audit_library_delete()', 'EXECUTE'),
       NULL
UNION ALL
SELECT check_name, NULL, n::text FROM ao_p8_20261204_inventory
UNION ALL
SELECT 'after: workspaces whose stale grants this run pruned', NULL, (SELECT COUNT(DISTINCT org_id) FROM ao_p8_20261204_backfill)::text
UNION ALL
SELECT 'after: nodes whose stale grants this run pruned', NULL, (SELECT COALESCE(SUM(n), 0) FROM ao_p8_20261204_backfill)::text;
