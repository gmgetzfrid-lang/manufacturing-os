-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N14 RAW-INSERT TAIL: the access-request burst
-- notice claimed atomically (PROD-16), and a compliance digest only the
-- server may queue (NEDGE-20).
--
--   PROD-16  Past the per-org cap, the access-request door tells each Admin /
--            DocCtrl in the pool ONCE that more requests are waiting: one
--            unread access_request_pending row about the org (resource_type
--            'org', no actor). The route read which members already hold one
--            and then inserted rows for the rest — two steps nothing
--            serialised, so two over-cap requests that landed together could
--            each see no open row and each write one. The app cannot close
--            that window: notifications takes no upsert from any app path
--            (lib/__tests__/notificationWriteRails.test.ts), and a partial
--            unique index would fail the whole batch on a conflict.
--   NEDGE-20 The compliance digest starts each recipient's list where their
--            last compliance_digest email row says it stopped
--            (metadata.through). email_notif_insert (20261047) let any active
--            member queue such a row for a colleague, with a `through` of
--            their choosing — a month ahead silenced that colleague's digest.
--            The reader half is in app/api/cron/maintenance/route.ts (it
--            trusts only a server-queued row once 20261183 is pasted, and
--            never a `through` past the row's own created_at plus the clock
--            margin); this file closes the door the forged row came in by.
--
-- What this file does:
--   · claim_access_request_burst(uuid, uuid[], text, text) — NEW, plpgsql,
--     SECURITY DEFINER, search_path pinned. Under a transaction-scoped
--     advisory lock keyed on the org, it writes the burst row for each
--     recipient who is an ACTIVE member of the org and holds no unread
--     server burst row for it (actor NULL), and answers
--     {"told": rows written, "already": recipients who already held one}.
--     The row is the one the route wrote: kind access_request_pending,
--     link /admin/users, resource ('org', the org id), no actor, metadata
--     {"accessRequestBurst": true}; the title and body are the route's.
--     The lock is held until the call's transaction commits, so a second
--     call for the same org waits, then reads the first one's rows (each
--     statement in a READ COMMITTED function takes a new snapshot).
--     EXECUTE: service_role only (DRLS-16) — the door runs on the service
--     role; PUBLIC, anon and authenticated cannot call it.
--   · email_notif_insert RE-CREATED from its NEWEST definition (20261047 §4)
--     with one line added: a signed-in writer's row may not be a
--     compliance_digest (the event type only the cron queues — on the
--     service role, which RLS does not bind). Every other line is the same;
--     lib/__tests__/notifRoundGBurstDigestMigration.test.ts diffs it against
--     the newest earlier definition found by scanning supabase/migrations.
--   · Nothing else: no row is changed, no other policy or function touched.
--
-- Not widening (DEC-30): nobody may do more after this file — the function is
-- the service role's alone, and the policy only narrows. The inventory below
-- (aggregate counts only, read BEFORE the change) sizes what each fix bears
-- on.
--
-- PASTE AND DEPLOY ORDER: either order is safe.
--   · Before this paste the door's call answers 42883 / PGRST202 and the
--     route keeps today's path (read the open rows, then write the rest —
--     the window PROD-16 describes, logged as unserialised).
--   · Before this paste a member can still queue a compliance_digest row;
--     the digest's reader already ignores one whose `through` runs past its
--     created_at plus five minutes, and (once 20261183 is pasted) any row a
--     signed-in member queued. After it, the row is refused at the door.
--   · 20261183 (email_notifications.queued_by) is independent of this file.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe. Needs 20260529
-- (email_notifications), 20260621 / 20260723 (notifications) and 20261047
-- (the policy re-created here).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_197_before;
CREATE TEMP TABLE notif_round_g_197_before AS
SELECT 1 AS ord, 'BEFORE: unread server burst notices (access_request_pending about an org, no actor)' AS inventory,
       (SELECT COUNT(*) FROM notifications
         WHERE kind = 'access_request_pending' AND resource_type = 'org'
           AND read_at IS NULL AND actor_user_id IS NULL)::text AS n
UNION ALL
SELECT 2, 'BEFORE: (org, member) pairs holding MORE than one unread burst notice (PROD-16: the race this paste closes; the extra rows are left as they are)',
       (SELECT COUNT(*) FROM (SELECT 1 FROM notifications
                               WHERE kind = 'access_request_pending' AND resource_type = 'org'
                                 AND read_at IS NULL AND actor_user_id IS NULL
                               GROUP BY org_id, user_id HAVING COUNT(*) > 1) d)::text
UNION ALL
SELECT 3, 'BEFORE: compliance_digest email rows a signed-in member queued (queued_by set — 0 until 20261183 is pasted; the digest ignores them, NEDGE-20)',
       (SELECT COUNT(*) FROM email_notifications e
         WHERE e.event_type = 'compliance_digest' AND to_jsonb(e) ->> 'queued_by' IS NOT NULL)::text
UNION ALL
SELECT 4, 'BEFORE: compliance_digest email rows whose metadata.through runs more than five minutes past their created_at (the forged shape; the digest no longer trusts one)',
       (SELECT COUNT(*) FROM email_notifications e
         WHERE e.event_type = 'compliance_digest'
           AND CASE WHEN COALESCE(e.metadata ->> 'through', '') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$'
                    THEN (e.metadata ->> 'through')::timestamptz > e.created_at + interval '5 minutes'
                    ELSE false END)::text;

BEGIN;

-- ── 1. PROD-16: the burst notice, claimed under a per-org lock ──────────────
CREATE OR REPLACE FUNCTION claim_access_request_burst(p_org uuid, p_recipients uuid[], p_title text, p_body text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_told integer := 0;
  v_already integer := 0;
BEGIN
  IF p_org IS NULL OR p_recipients IS NULL OR cardinality(p_recipients) = 0 THEN
    RETURN jsonb_build_object('told', 0, 'already', 0);
  END IF;
  -- One burst claim per org at a time, until this transaction commits.
  PERFORM pg_advisory_xact_lock(hashtextextended('access-request-burst:' || p_org::text, 0));
  SELECT COUNT(DISTINCT n.user_id) INTO v_already
    FROM notifications n
   WHERE n.org_id = p_org
     AND n.kind = 'access_request_pending'
     AND n.resource_type = 'org'
     AND n.resource_id = p_org::text
     AND n.read_at IS NULL
     AND n.actor_user_id IS NULL
     AND n.user_id = ANY (p_recipients);
  INSERT INTO notifications (org_id, user_id, kind, title, body, link, resource_type, resource_id, actor_user_id, actor_name, metadata)
  SELECT p_org, r.uid, 'access_request_pending', p_title, p_body, '/admin/users', 'org', p_org::text, NULL, NULL,
         jsonb_build_object('accessRequestBurst', true)
    FROM (SELECT DISTINCT u AS uid FROM unnest(p_recipients) AS u WHERE u IS NOT NULL) r
   WHERE EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = p_org AND m.uid = r.uid AND m.status = 'active')
     AND NOT EXISTS (SELECT 1 FROM notifications n
                      WHERE n.org_id = p_org
                        AND n.user_id = r.uid
                        AND n.kind = 'access_request_pending'
                        AND n.resource_type = 'org'
                        AND n.resource_id = p_org::text
                        AND n.read_at IS NULL
                        AND n.actor_user_id IS NULL);
  GET DIAGNOSTICS v_told = ROW_COUNT;
  RETURN jsonb_build_object('told', v_told, 'already', v_already);
END;
$$;

COMMENT ON FUNCTION claim_access_request_burst(uuid, uuid[], text, text) IS
  'PROD-16: the access-request door''s "more requests are waiting" notice, claimed under a per-org advisory lock — one unread server burst row (access_request_pending about the org, no actor) per ACTIVE pool member at most, however many requests land at once. Answers {told, already}. Service role only. notifications Round G, 20261197 (N14).';

REVOKE ALL ON FUNCTION claim_access_request_burst(uuid, uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_access_request_burst(uuid, uuid[], text, text) TO service_role;

-- ── 2. NEDGE-20: email_notif_insert (newest: 20261047 §4) + one line ────────
DROP POLICY IF EXISTS email_notif_insert ON email_notifications;
CREATE POLICY email_notif_insert ON email_notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members WHERE org_id = email_notifications.org_id AND uid = auth.uid() AND status = 'active')
    AND COALESCE(metadata->>'external', '') <> 'true'
    AND event_type <> 'compliance_digest'
    AND EXISTS (SELECT 1 FROM org_members r WHERE r.org_id = email_notifications.org_id
                AND lower(r.email) = lower(email_notifications.to_email))
  );

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 5 ─────────
SELECT 'claim_access_request_burst(uuid, uuid[], text, text) returns jsonb, is SECURITY DEFINER with search_path pinned, and takes the per-org advisory lock before it reads or writes' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'claim_access_request_burst'
                  AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_recipients uuid[], p_title text, p_body text'
                  AND pg_get_function_result(p.oid) = 'jsonb'
                  AND p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND p.prosrc LIKE '%pg_advisory_xact_lock(hashtextextended(''access-request-burst:'' || p_org::text, 0));%SELECT COUNT(DISTINCT n.user_id) INTO v_already%INSERT INTO notifications%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'claim_access_request_burst: only service_role may execute it (not PUBLIC, anon or authenticated)',
       (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'claim_access_request_burst'),
       NULL
UNION ALL
SELECT 'email_notif_insert refuses a signed-in writer''s compliance_digest row, and still binds the writer''s membership, refuses external mail and checks the address',
       COALESCE((SELECT cmd = 'INSERT' AND permissive = 'PERMISSIVE' AND roles = '{authenticated}'
                        AND with_check LIKE '%compliance_digest%'
                        AND with_check LIKE '%external%'
                        AND with_check LIKE '%auth.uid()%'
                        AND with_check LIKE '%lower(r.email) = lower(email_notifications.to_email)%'
                   FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'email_notifications' AND policyname = 'email_notif_insert'), false),
       NULL
UNION ALL
SELECT 'email_notifications keeps exactly its three policies (insert, select own-or-admin, update admin-requeue)',
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'email_notifications'
           AND policyname IN ('email_notif_insert', 'email_notif_select_own_or_admin', 'email_notif_update_admin_requeue')),
       NULL
UNION ALL
SELECT 'no row was changed: the unread server burst notices are as many as before',
       (SELECT COUNT(*) FROM notifications
         WHERE kind = 'access_request_pending' AND resource_type = 'org'
           AND read_at IS NULL AND actor_user_id IS NULL)::text
         = (SELECT n FROM notif_round_g_197_before WHERE ord = 1),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_197_before ORDER BY ord) b;
