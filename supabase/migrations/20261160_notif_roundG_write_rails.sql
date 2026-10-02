-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N5 DISPATCH-AND-WRITE-HOLES, migration A: the
-- notification write rails (OS-1, DELIV-6; the kind allowlist of DEC-44 (N5)).
--
--   OS-1     any active org member could insert unlimited rows into any other
--            member's bell, with any kind, title, body and link — the insert
--            policy (20260621:52-61, 20260723:44-52) checks only that the
--            CALLER is an active member of notifications.org_id, and its own
--            comment defers the rest: "Validated at the app layer." The app
--            layer is the caller's browser.
--   DELIV-6  the same row could claim any actor (actor_user_id = an Admin,
--            actor_name 'System'), mint a compliance kind nobody declared
--            ('ack_requested' to every controller) and carry an off-site link
--            (https://evil.example/login) that the bell renders as a live
--            <Link>.
--
-- What this file does — every ~30 browser producers (notify / notifyMany /
-- emit, report 01's census) keep writing exactly as before; nothing moves to
-- a server route (DEC-31):
--   · notification_kinds() — NEW, IMMUTABLE, a set-returning reference
--     relation (kind, compliance): the 51 kinds of lib/notificationKinds.ts
--     KIND_META, 15 of them compliance kinds, seeded from the registry.
--     lib/__tests__/notificationWriteRails.test.ts pins the newest
--     definition to Object.keys(KIND_META) and to each kind's compliance flag,
--     so a kind added to the registry without re-creating this function in a
--     migration fails CI. It is a function, not a table: a table would need a
--     backup decision in lib/exportTables.ts (exportCoverage tripwire, a file
--     other packages own), and a reference list is schema, not org data — a
--     backup never carries it and a restore never writes it. EXECUTE:
--     authenticated (the delete policy of 20261161 reads it) and
--     service_role; never PUBLIC or anon.
--   · enforce_notification_insert() — NEW BEFORE INSERT trigger function,
--     SECURITY DEFINER, search_path pinned. For the service role and the cron
--     (auth.uid() IS NULL) it returns NEW untouched as its FIRST statement:
--     every server producer (the ticket routes, the transmittal route, the
--     intake door, the cron, notify_personnel, the data-export and AI-cap
--     notices) writes exactly as before. For a signed-in caller:
--       1. actor_user_id := auth.uid() when NULL; a different actor is
--          refused (42501). A browser row always names its writer, so a row
--          with actor_user_id NULL is a server row — the mark a member cannot
--          forge (DELIV-6 dw4). actor_name stays the producer's text: the
--          browser's checkout sweep writes 'System' rows legitimately
--          (lib/projects.ts autoReleaseExpiredAdHoc), and those now carry the
--          member whose browser ran the sweep.
--       2. kind must be one notification_kinds() declares (22023).
--       3. link is NULL, empty, or app-relative: starts with one '/', not
--          '//' or '/\', no backslash, no control character (22023).
--       4. the recipient must be an ACTIVE member of notifications.org_id;
--          otherwise the row is SKIPPED (RETURN NULL), not refused, so one
--          suspended watcher never sinks a batch insert for everyone else
--          (lib/projects.ts writes its release notices in one statement).
--       5. rate caps, per actor AND recipient, over the last minute: 60 rows
--          of the same kind about the same resource (a poke button pressed
--          60 times), 600 rows of anything (P0001). Keyed by recipient, not
--          by actor alone: one legitimate fan-out writes one row per
--          recipient — an org-wide ack roster, the sweep's release notices —
--          and must never meet a per-actor ceiling.
--     notifications_org_insert is KEPT unchanged: RLS's WITH CHECK runs after
--     this trigger, so the caller must still be an active member of the org.
--   · notifications_actor_recipient_idx (actor_user_id, user_id, created_at)
--     — the caps' count is an index range scan.
--
-- Pre-apply inventory (DEC-30, aggregate counts only): the rows already
-- written that the new rules would have refused or skipped, and the minute
-- buckets in the last 30 days that would have met a cap (an over-count:
-- server rows, which the caps never apply to, are counted too). No existing
-- row is changed; the undeclared-kind count is reported AFTER the apply
-- (it reads notification_kinds()) and is unchanged by this paste.
--
-- DEPLOY ORDER: either order is safe. The app reads nothing this file adds;
-- before the paste the browser writes as it did. After it, a row a rule
-- refuses is logged by notify() (lib/inAppNotifications.ts), never thrown
-- into a user flow.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe. Paste BEFORE
-- 20261161 (its delete policy reads notification_kinds()).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_160_before;
CREATE TEMP TABLE notif_round_g_160_before AS
SELECT 1 AS ord, 'BEFORE: notifications rows' AS inventory,
       (SELECT COUNT(*) FROM notifications)::text AS n
UNION ALL
SELECT 2, 'BEFORE: rows whose link is not app-relative (a browser can no longer write one; existing rows are kept)',
       (SELECT COUNT(*) FROM notifications
         WHERE link IS NOT NULL AND link <> ''
           AND NOT (left(link, 1) = '/' AND substr(link, 2, 1) NOT IN ('/', E'\\') AND strpos(link, E'\\') = 0 AND link !~ '[[:cntrl:]]'))::text
UNION ALL
SELECT 3, 'BEFORE: rows written in the last 30 days with no actor_user_id (after the paste only a server can write one)',
       (SELECT COUNT(*) FROM notifications
         WHERE created_at >= now() - interval '30 days' AND actor_user_id IS NULL)::text
UNION ALL
SELECT 4, 'BEFORE: rows written in the last 30 days to a recipient who is not an active member of the row''s org now (a browser row like it is skipped from now on)',
       (SELECT COUNT(*) FROM notifications n
         WHERE n.created_at >= now() - interval '30 days'
           AND NOT EXISTS (SELECT 1 FROM org_members m
                            WHERE m.org_id = n.org_id AND m.uid = n.user_id AND m.status = 'active'))::text
UNION ALL
SELECT 5, 'BEFORE: minute buckets in the last 30 days with more than 60 rows from one actor to one recipient of one kind about one resource (the same-notice cap)',
       (SELECT COUNT(*) FROM (SELECT 1 FROM notifications
                               WHERE created_at >= now() - interval '30 days' AND actor_user_id IS NOT NULL
                               GROUP BY actor_user_id, user_id, kind, resource_id, date_trunc('minute', created_at)
                              HAVING COUNT(*) > 60) b)::text
UNION ALL
SELECT 6, 'BEFORE: minute buckets in the last 30 days with more than 600 rows from one actor to one recipient (the per-recipient cap)',
       (SELECT COUNT(*) FROM (SELECT 1 FROM notifications
                               WHERE created_at >= now() - interval '30 days' AND actor_user_id IS NOT NULL
                               GROUP BY actor_user_id, user_id, date_trunc('minute', created_at)
                              HAVING COUNT(*) > 600) b)::text;

BEGIN;

-- ── 1. notification_kinds(): the database's copy of the kind registry ──────
CREATE OR REPLACE FUNCTION notification_kinds()
RETURNS TABLE (kind text, compliance boolean)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  VALUES
    ('ticket_comment',                   false),
    ('ticket_mention',                   false),
    ('ticket_status',                    false),
    ('ticket_assigned',                  false),
    ('request_pending_approval',         false),
    ('checkout_conflict',                false),
    ('checkout_handoff',                 false),
    ('checkout_message',                 false),
    ('checkout_released',                false),
    ('overlap_advisory',                 false),
    ('branch_open',                      false),
    ('branch_resolved',                  false),
    ('doc_superseded',                   true),
    ('markup_request',                   false),
    ('provenance_flag',                  false),
    ('hold_opened',                      false),
    ('hold_released',                    false),
    ('revision_published_over_checkout', false),
    ('library_doc_added',                false),
    ('library_doc_revised',              false),
    ('owner_assigned',                   false),
    ('owner_behind',                     true),
    ('deletion_requested',               true),
    ('ack_requested',                    true),
    ('ack_complete',                     false),
    ('ack_overdue',                      true),
    ('ack_unsatisfiable',                true),
    ('review_due',                       true),
    ('review_requested',                 true),
    ('review_signed',                    false),
    ('review_invalidated',               true),
    ('review_complete',                  true),
    ('review_overdue',                   true),
    ('review_alternate_activated',       true),
    ('effective_now',                    true),
    ('retention_eligible',               true),
    ('legal_hold_placed',                false),
    ('legal_hold_released',              false),
    ('access_recert_due',                true),
    ('project_member',                   false),
    ('project_status',                   false),
    ('project_comment',                  false),
    ('orchestrator_message',             false),
    ('security_export',                  false),
    ('member_revoked',                   false),
    ('library_unowned',                  false),
    ('storage_alert',                    false),
    ('storage_platform_r2',              false),
    ('storage_platform_db',              false),
    ('ai_cap_changed',                   false),
    ('transmittal_unstampable',          false)
$$;

COMMENT ON FUNCTION notification_kinds() IS
  'The notification kind registry (lib/notificationKinds.ts KIND_META): every kind a browser may write, and whether it is a compliance kind. Re-created by a migration whenever the registry changes; lib/__tests__/notificationWriteRails.test.ts pins the two equal. notifications Round G, 20261160.';

REVOKE ALL ON FUNCTION notification_kinds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notification_kinds() TO authenticated, service_role;

-- ── 2. the insert rails ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_notification_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_same int;
  v_any int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- 1. the actor is the signed-in member
  IF NEW.actor_user_id IS NULL THEN
    NEW.actor_user_id := v_uid;
  ELSIF NEW.actor_user_id <> v_uid THEN
    RAISE EXCEPTION 'notifications: a notification''s actor must be the signed-in member' USING ERRCODE = '42501';
  END IF;

  -- 2. a declared kind
  IF NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = NEW.kind) THEN
    RAISE EXCEPTION 'notifications: unknown kind %', NEW.kind USING ERRCODE = '22023';
  END IF;

  -- 3. an app-relative link
  IF NEW.link IS NOT NULL AND NEW.link <> ''
     AND NOT (left(NEW.link, 1) = '/' AND substr(NEW.link, 2, 1) NOT IN ('/', E'\\') AND strpos(NEW.link, E'\\') = 0 AND NEW.link !~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'notifications: a link must be an app-relative path' USING ERRCODE = '22023';
  END IF;

  -- 4. an active member of the org receives it; anyone else is skipped
  IF NOT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = NEW.org_id AND m.uid = NEW.user_id AND m.status = 'active') THEN
    RETURN NULL;
  END IF;

  -- 5. rate caps per (actor, recipient) over the last minute
  SELECT COUNT(*) FILTER (WHERE n.kind = NEW.kind AND n.resource_id IS NOT DISTINCT FROM NEW.resource_id),
         COUNT(*)
    INTO v_same, v_any
    FROM notifications n
   WHERE n.actor_user_id = v_uid
     AND n.user_id = NEW.user_id
     AND n.created_at > now() - interval '1 minute';
  IF v_same >= 60 THEN
    RAISE EXCEPTION 'notifications: rate limit — 60 of the same notification to one person per minute';
  END IF;
  IF v_any >= 600 THEN
    RAISE EXCEPTION 'notifications: rate limit — 600 notifications to one person per minute';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_notification_insert() IS
  'BEFORE INSERT on notifications: the service role passes untouched; a signed-in writer is stamped as the actor (another actor refused), the kind must be declared (notification_kinds()), the link app-relative, a recipient who is not an active member of the org is skipped, and 60 same-notice / 600 any rows per actor and recipient per minute is the cap. notifications Round G, 20261160.';

REVOKE ALL ON FUNCTION enforce_notification_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notifications_enforce_insert ON notifications;
CREATE TRIGGER trg_notifications_enforce_insert
  BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION enforce_notification_insert();

CREATE INDEX IF NOT EXISTS notifications_actor_recipient_idx
  ON notifications (actor_user_id, user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 12 ────────
SELECT 'notification_kinds() is IMMUTABLE, search_path pinned, and declares 51 kinds — 15 of them compliance kinds — each once' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'notification_kinds'
                  AND pg_get_function_identity_arguments(p.oid) = ''
                  AND p.provolatile = 'i' AND NOT p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public'])
       AND (SELECT COUNT(*) = 51 AND COUNT(DISTINCT kind) = 51 AND COUNT(*) FILTER (WHERE compliance) = 15
              FROM notification_kinds()) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'notification_kinds(): anon and PUBLIC cannot execute it, authenticated and service_role can',
       (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'notification_kinds'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert() returns trigger, is SECURITY DEFINER with search_path pinned, and no API role (PUBLIC, anon, authenticated) can call it directly',
       (SELECT pg_get_function_result(p.oid) = 'trigger' AND p.prosecdef
               AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'enforce_notification_insert'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: its first statement returns NEW untouched for the service role / cron (no uid)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%BEGIN%IF v_uid IS NULL THEN%RETURN NEW;%END IF;%NEW.actor_user_id%'
                  AND position('IF v_uid IS NULL THEN' IN prosrc) < position('NEW.actor_user_id' IN prosrc)),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: the actor is stamped when absent and refused when it is someone else',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%IF NEW.actor_user_id IS NULL THEN%NEW.actor_user_id := v_uid;%ELSIF NEW.actor_user_id <> v_uid THEN%RAISE EXCEPTION%42501%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: an undeclared kind and a link that is not app-relative are refused',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%IF NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = NEW.kind) THEN%'
                  AND prosrc LIKE '%left(NEW.link, 1) = ''/''%substr(NEW.link, 2, 1) NOT IN%strpos(NEW.link, %[[:cntrl:]]%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: a recipient who is not an active member of the org is skipped (RETURN NULL), never refused',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%m.org_id = NEW.org_id AND m.uid = NEW.user_id AND m.status = ''active'') THEN%RETURN NULL;%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: the caps are 60 same-notice and 600 any rows per actor and recipient per minute',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%n.actor_user_id = v_uid%n.user_id = NEW.user_id%n.created_at > now() - interval ''1 minute''%'
                  AND prosrc LIKE '%IF v_same >= 60 THEN%IF v_any >= 600 THEN%'),
       NULL
UNION ALL
SELECT 'trg_notifications_enforce_insert is BEFORE INSERT FOR EACH ROW on notifications, enabled',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                WHERE t.tgrelid = 'public.notifications'::regclass AND t.tgname = 'trg_notifications_enforce_insert'
                  AND p.proname = 'enforce_notification_insert' AND NOT t.tgisinternal AND t.tgenabled = 'O'
                  AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4),
       NULL
UNION ALL
SELECT 'notifications_org_insert is kept: the caller must still be an active member of the org',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
                  AND policyname = 'notifications_org_insert' AND cmd = 'INSERT'
                  AND with_check LIKE '%org_members%' AND with_check LIKE '%auth.uid()%' AND with_check LIKE '%''active''%'),
       NULL
UNION ALL
SELECT 'notifications_actor_recipient_idx exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'notifications'
                  AND indexname = 'notifications_actor_recipient_idx'),
       NULL
UNION ALL
SELECT 'the four notifications policies are still there (SELECT / UPDATE / DELETE own, INSERT org) — 20261161 narrows the first three',
       (SELECT COUNT(*) = 4 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notifications'
           AND policyname IN ('notifications_own_select', 'notifications_own_update', 'notifications_own_delete', 'notifications_org_insert')),
       NULL
UNION ALL
SELECT 'AFTER (unchanged by this paste): rows whose kind notification_kinds() does not declare — legacy rows, kept and readable',
       NULL::boolean,
       (SELECT COUNT(*) FROM notifications n WHERE NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = n.kind))::text
UNION ALL
SELECT 'AFTER (unchanged by this paste): distinct undeclared kinds among them',
       NULL::boolean,
       (SELECT COUNT(DISTINCT n.kind) FROM notifications n WHERE NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = n.kind))::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_160_before ORDER BY ord) b;
