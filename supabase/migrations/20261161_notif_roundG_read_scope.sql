-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N5 DISPATCH-AND-WRITE-HOLES, migration B: the
-- notifications read scope (NEDGE-7) and the read_at-only write (DELIV-13).
--
--   NEDGE-7  notifications_own_select / _update / _delete are USING
--            (user_id = auth.uid()) with no org predicate (20260723:36-41).
--            A removed or suspended member keeps a valid login, so their
--            token kept reading — and marking read, and deleting — every row
--            ever addressed to them: hold reasons, revision titles, actor
--            names, across every org they ever belonged to.
--   DELIV-13 the UPDATE policy has no WITH CHECK, so the whole row was
--            rewritable (title, kind, link, metadata, created_at — the
--            metadata the cron's dedupe watermarks read); the DELETE policy
--            let a member hard-delete an unread compliance obligation.
--
-- What this file does:
--   · notifications.org_tombstoned_at TIMESTAMPTZ (NULL = live). Set by
--     revoke_member on REMOVE for the removed member's rows in that org;
--     never deleted — the archive stays for investigators (the plan's
--     default), and the purge route (service role) is unchanged.
--   · notifications_own_select: user_id = auth.uid() AND the row is not
--     tombstoned AND the caller is an ACTIVE member of the row's org. A
--     suspended member reads nothing until restored; a removed member reads
--     nothing; a re-added member does not get the old archive back.
--   · notifications_own_update: the same USING, plus a WITH CHECK of the
--     same; and trg_notifications_read_at_only (BEFORE UPDATE, SECURITY
--     INVOKER) refuses a change to any column but read_at when the
--     recipient updates their own row (to_jsonb(NEW) - 'read_at' must equal
--     to_jsonb(OLD) - 'read_at' — a column added later is pinned too). The
--     service role and a SECURITY DEFINER path acting on someone else's
--     rows (revoke_member's tombstone) pass.
--   · notifications_own_delete: the same scope AND read_at IS NOT NULL AND
--     the kind is not a compliance kind (notification_kinds(), 20261160) —
--     "clear all" stays a feature for read FYI rows; a compliance obligation
--     is dismiss-only (mark read). A legacy kind the registry no longer
--     declares is not a compliance kind.
--   · revoke_member(uuid, text) RE-CREATED from its newest definition
--     (20261043 §0) with one statement added on the REMOVE path, after the
--     roster deletes and before the membership delete, in the same
--     transaction: UPDATE notifications SET org_tombstoned_at = NOW() for the
--     member's live rows in that org. Nothing else in the body changes —
--     lib/__tests__/notificationWriteRails.test.ts finds the newest earlier
--     definition by scanning supabase/migrations and allows exactly these
--     added lines. EXECUTE restated (DRLS-16): REVOKEd from PUBLIC and anon,
--     GRANTed to authenticated (the body refuses a NULL uid regardless).
--   · notifications_org_insert is untouched (20261160's trigger is the
--     insert rail).
--
-- REGRESSION: a member still reads, marks read (one row, several, all) and
-- clears their own read FYI notifications. The dedupe watermarks that read
-- notifications rows (lib/distributionAcks.ts, lib/storageAlerts.ts,
-- lib/storageUsage.ts, lib/holds.ts scanStaleHolds, the intake review-health
-- nudge, the cron's stale-checkout escalation and the transmittal notice) can
-- no longer be edited by a recipient, and a deletion can only RE-arm a nag
-- (louder) — and never for a compliance kind. This file closes edit and
-- delete only: a FORGED INSERT carrying a watermark is 20261160's to refuse
-- (its rules 2 and 4 — a server-only kind, a server metadata key), which
-- together make DELIV-13 dw3 hold without moving the watermarks. The nag's
-- own key (ackRequest) stays browser-writable by design: a manual request
-- or re-nudge counts as the nag.
--
-- Pre-apply inventory (DEC-30, aggregate counts only): the rows whose
-- recipient is not an active member of the row's org, by the recipient's
-- membership status — they become unreadable to that recipient; nothing is
-- deleted. Rows of members with no membership row at all (removed before
-- this paste) are NOT tombstoned here: they stay hidden while the person is
-- not an active member and would reappear if they were re-added (one UPDATE,
-- recorded in NEDGE-7, if the owner wants them tombstoned too). Then what
-- the delete narrowing touches, and the off-origin links (the insert rule of
-- 20261160; existing rows kept).
--
-- DEPLOY ORDER: paste 20261160 FIRST (the delete policy reads
-- notification_kinds(); this file stops with a message if it is missing).
-- The app reads nothing this file adds and only ever writes read_at, so it
-- may deploy before or after the paste.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regprocedure('public.notification_kinds()') IS NULL THEN
    RAISE EXCEPTION '20261161 needs 20261160 (notification_kinds()) — paste 20261160_notif_roundG_write_rails.sql first';
  END IF;
END $$;

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_161_before;
CREATE TEMP TABLE notif_round_g_161_before AS
SELECT 1 AS ord, 'BEFORE: notifications rows' AS inventory,
       (SELECT COUNT(*) FROM notifications)::text AS n
UNION ALL
SELECT 2, 'BEFORE: rows whose recipient is SUSPENDED in the row''s org (unreadable to them until restored)',
       (SELECT COUNT(*) FROM notifications n JOIN org_members m ON m.org_id = n.org_id AND m.uid = n.user_id
         WHERE m.status = 'suspended')::text
UNION ALL
SELECT 3, 'BEFORE: rows whose recipient is INACTIVE in the row''s org — a restore''s placeholders (unreadable to them until reactivated)',
       (SELECT COUNT(*) FROM notifications n JOIN org_members m ON m.org_id = n.org_id AND m.uid = n.user_id
         WHERE m.status = 'inactive')::text
UNION ALL
SELECT 4, 'BEFORE: rows whose recipient is INVITED in the row''s org (unreadable to them until active)',
       (SELECT COUNT(*) FROM notifications n JOIN org_members m ON m.org_id = n.org_id AND m.uid = n.user_id
         WHERE m.status = 'invited')::text
UNION ALL
SELECT 5, 'BEFORE: rows whose recipient has NO membership row in the row''s org — removed before this paste (unreadable now; not tombstoned by this paste)',
       (SELECT COUNT(*) FROM notifications n
         WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = n.org_id AND m.uid = n.user_id))::text
UNION ALL
SELECT 6, 'BEFORE: distinct recipients among rows 2-5 (people who lose read access to some rows)',
       (SELECT COUNT(DISTINCT n.user_id) FROM notifications n
         WHERE NOT EXISTS (SELECT 1 FROM org_members m
                            WHERE m.org_id = n.org_id AND m.uid = n.user_id AND m.status = 'active'))::text
UNION ALL
SELECT 7, 'BEFORE: unread rows (their recipient can no longer delete one until it is read)',
       (SELECT COUNT(*) FROM notifications WHERE read_at IS NULL)::text
UNION ALL
SELECT 8, 'BEFORE: read rows of a compliance kind (dismiss-only from now on: they stay)',
       (SELECT COUNT(*) FROM notifications n
         WHERE n.read_at IS NOT NULL AND EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = n.kind AND k.compliance))::text
UNION ALL
SELECT 9, 'BEFORE: read rows of any other kind (their recipient may still clear them)',
       (SELECT COUNT(*) FROM notifications n
         WHERE n.read_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = n.kind AND k.compliance))::text
UNION ALL
SELECT 10, 'BEFORE: rows whose link is not app-relative (20261160 refuses such a link from a browser; existing rows kept)',
       (SELECT COUNT(*) FROM notifications
         WHERE link IS NOT NULL AND link <> ''
           AND NOT (left(link, 1) = '/' AND substr(link, 2, 1) NOT IN ('/', E'\\') AND strpos(link, E'\\') = 0 AND link !~ '[[:cntrl:]]'))::text
UNION ALL
SELECT 11, 'BEFORE: rows already tombstoned (0 on the first paste)',
       (SELECT COUNT(*) FILTER (WHERE to_jsonb(n) ->> 'org_tombstoned_at' IS NOT NULL) FROM notifications n)::text;

BEGIN;

-- ── 1. the tombstone ────────────────────────────────────────────────────────
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS org_tombstoned_at TIMESTAMPTZ;

COMMENT ON COLUMN notifications.org_tombstoned_at IS
  'Set when the recipient was removed from this org (revoke_member, REMOVE). A tombstoned row is kept for investigators and is never readable by its recipient again. NULL = live. notifications Round G, 20261161.';

-- ── 2. the read scope: own rows, live, in an org where the caller is active ─
DROP POLICY IF EXISTS notifications_own_select ON notifications;
CREATE POLICY notifications_own_select ON notifications FOR SELECT USING (
  user_id = auth.uid()
  AND org_tombstoned_at IS NULL
  AND EXISTS (SELECT 1 FROM org_members m
                 WHERE m.org_id = notifications.org_id AND m.uid = auth.uid() AND m.status = 'active')
);

DROP POLICY IF EXISTS notifications_own_update ON notifications;
CREATE POLICY notifications_own_update ON notifications FOR UPDATE USING (
  user_id = auth.uid()
  AND org_tombstoned_at IS NULL
  AND EXISTS (SELECT 1 FROM org_members m
                 WHERE m.org_id = notifications.org_id AND m.uid = auth.uid() AND m.status = 'active')
) WITH CHECK (
  user_id = auth.uid()
  AND org_tombstoned_at IS NULL
  AND EXISTS (SELECT 1 FROM org_members m
                 WHERE m.org_id = notifications.org_id AND m.uid = auth.uid() AND m.status = 'active')
);

DROP POLICY IF EXISTS notifications_own_delete ON notifications;
CREATE POLICY notifications_own_delete ON notifications FOR DELETE USING (
  user_id = auth.uid()
  AND org_tombstoned_at IS NULL
  AND read_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM org_members m
                 WHERE m.org_id = notifications.org_id AND m.uid = auth.uid() AND m.status = 'active')
  AND NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = notifications.kind AND k.compliance)
);

-- ── 3. a recipient changes read_at and nothing else ─────────────────────────
CREATE OR REPLACE FUNCTION enforce_notification_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR OLD.user_id IS DISTINCT FROM auth.uid() THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
    RAISE EXCEPTION 'notifications: only read_at may change on your own notification' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_notification_update() IS
  'BEFORE UPDATE on notifications: when the recipient updates their own row, every column but read_at must stay as it was. The service role and a definer path acting on another member''s rows pass. notifications Round G, 20261161.';

REVOKE ALL ON FUNCTION enforce_notification_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notifications_read_at_only ON notifications;
CREATE TRIGGER trg_notifications_read_at_only
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION enforce_notification_update();

-- ── 4. revoke_member: the newest body (20261043 §0) + the tombstone ─────────
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
                             'endedCheckouts', v_checkouts, 'revokedGrants', v_grants));

  RETURN jsonb_build_object(
    'mode', 'remove', 'uid', v_member.uid,
    'cleared', jsonb_build_object('libraries', v_libs, 'collections', v_cols, 'documents', v_docs, 'teams', v_teams),
    'endedCheckouts', v_checkouts, 'revokedGrants', v_grants
  );
END;
$$;

REVOKE ALL ON FUNCTION revoke_member(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION revoke_member(uuid, text) TO authenticated;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 10 ────────
SELECT 'notifications.org_tombstoned_at exists (timestamptz, nullable)' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'org_tombstoned_at'
                  AND data_type = 'timestamp with time zone' AND is_nullable = 'YES') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'notifications_own_select: own rows, not tombstoned, caller an ACTIVE member of the row''s org',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
                  AND policyname = 'notifications_own_select' AND cmd = 'SELECT'
                  AND qual LIKE '%user_id = auth.uid()%' AND qual LIKE '%org_tombstoned_at IS NULL%'
                  AND qual LIKE '%org_members%' AND qual LIKE '%m.status = ''active''%'
                  AND qual LIKE '%m.org_id = notifications.org_id%'),
       NULL
UNION ALL
SELECT 'notifications_own_update: the same scope in USING and in WITH CHECK',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
                  AND policyname = 'notifications_own_update' AND cmd = 'UPDATE'
                  AND qual LIKE '%user_id = auth.uid()%' AND qual LIKE '%org_tombstoned_at IS NULL%' AND qual LIKE '%m.status = ''active''%'
                  AND with_check LIKE '%user_id = auth.uid()%' AND with_check LIKE '%org_tombstoned_at IS NULL%' AND with_check LIKE '%m.status = ''active''%'),
       NULL
UNION ALL
SELECT 'notifications_own_delete: own, live, READ rows of a non-compliance kind, caller active',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
                  AND policyname = 'notifications_own_delete' AND cmd = 'DELETE'
                  AND qual LIKE '%user_id = auth.uid()%' AND qual LIKE '%org_tombstoned_at IS NULL%'
                  AND qual LIKE '%read_at IS NOT NULL%' AND qual LIKE '%m.status = ''active''%'
                  AND qual LIKE '%notification_kinds()%' AND qual LIKE '%compliance%'),
       NULL
UNION ALL
SELECT 'notifications_org_insert untouched, and notifications still has exactly its four policies',
       (SELECT COUNT(*) = 4 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
                      AND policyname = 'notifications_org_insert' AND cmd = 'INSERT'
                      AND with_check LIKE '%org_members%' AND with_check LIKE '%''active''%'),
       NULL
UNION ALL
SELECT 'trg_notifications_read_at_only is BEFORE UPDATE FOR EACH ROW, enabled; its function pins every column but read_at and is SECURITY INVOKER',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgrelid = 'public.notifications'::regclass AND t.tgname = 'trg_notifications_read_at_only'
                  AND p.proname = 'enforce_notification_update' AND NOT t.tgisinternal AND t.tgenabled = 'O'
                  AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
                  AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                  AND p.prosrc LIKE '%(to_jsonb(NEW) - ''read_at'') IS DISTINCT FROM (to_jsonb(OLD) - ''read_at'')%'
                  AND p.prosrc LIKE '%OLD.user_id IS DISTINCT FROM auth.uid()%'),
       NULL
UNION ALL
SELECT 'revoke_member tombstones the removed member''s notifications on REMOVE, in the same body as the roster sweep',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member'
                  AND prosrc LIKE '%DELETE FROM subscriptions WHERE org_id = v_member.org_id AND user_id = v_member.uid;%UPDATE notifications SET org_tombstoned_at = NOW()%DELETE FROM org_members WHERE id = p_member_id;%'),
       NULL
UNION ALL
SELECT 'revoke_member keeps its newest body: SECURITY DEFINER, search_path pinned, the self-guard, the TEXT[] lock clear',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'revoke_member' AND prosecdef
                  AND proconfig @> ARRAY['search_path=public']
                  AND prosrc LIKE '%You can''''t suspend or remove yourself.%'
                  AND prosrc LIKE '%active_collaborators = ''{}''::text[]%'
                  AND prosrc NOT LIKE '%active_collaborators = ''[]''::jsonb%'),
       NULL
UNION ALL
SELECT 'revoke_member: anon and PUBLIC cannot execute it, authenticated can',
       (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'revoke_member'),
       NULL
UNION ALL
SELECT '20261160 is in place: notification_kinds() and trg_notifications_enforce_insert',
       to_regprocedure('public.notification_kinds()') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.notifications'::regclass
                      AND tgname = 'trg_notifications_enforce_insert' AND tgenabled = 'O'),
       NULL
UNION ALL
SELECT 'AFTER: rows tombstoned (0 on the first paste — only a REMOVE from now on sets it)',
       NULL::boolean,
       (SELECT COUNT(*) FROM notifications WHERE org_tombstoned_at IS NOT NULL)::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_161_before ORDER BY ord) b;
