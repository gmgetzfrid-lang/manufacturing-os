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
--       0. the caller must be an ACTIVE member of notifications.org_id
--          (42501) — checked FIRST, before this function reads anything
--          else of that org with its definer rights. Without it, the
--          recipient check (5) and the resource check (6) would run for any
--          org id a caller names, and the outcome (a skipped row, a cap, or
--          RLS's refusal) would tell them whether a uid is an active member
--          of another tenant or whether a resource id exists there. The
--          same predicate as notifications_org_insert, which still runs.
--       1. actor_user_id := auth.uid() when NULL; a different actor is
--          refused (42501). A browser row always names its writer, so a row
--          with actor_user_id NULL is a server row — the mark a member cannot
--          forge (DELIV-6 dw4). actor_name stays the producer's text: the
--          browser's checkout sweep writes 'System' rows legitimately
--          (lib/projects.ts autoReleaseExpiredAdHoc), and those now carry the
--          member whose browser ran the sweep. created_at := now(): a
--          browser's row is dated when it is written — a back-dated row
--          would slip below every cap's window (rule 7), and a future-dated
--          one would sit at the top of a bell for good.
--       2. kind must be one notification_kinds() declares (22023), and
--          not one only the server writes: transmittal_unstampable (the
--          transmittal route), storage_alert, storage_platform_r2 and
--          storage_platform_db (the cron, through notifyAsServiceRole) —
--          each is a dedupe watermark keyed on the kind (22023).
--       3. link is NULL, empty, or app-relative: starts with one '/', not
--          '//' or '/\', no backslash, no control character (22023).
--       4. metadata carries none of the server's dedupe watermark keys —
--          staleSessionId (the cron's stale-checkout escalation),
--          staleHoldId (lib/holds.ts scanStaleHolds), reviewHealthDay
--          (lib/intakeRateLimit.ts nudgeReviewHealth), ackEscalation
--          (lib/distributionAcks.ts scanDistributionAcks) (22023). Each
--          probe matches kind + metadata alone, with no actor or recipient
--          filter, so a browser row carrying one — addressed to anyone,
--          the writer included — would silence that escalation for good.
--          Only the cron writes them. ackRequest and autoReleasedSessionId
--          are written by browsers legitimately and stay allowed.
--       5. the recipient must be an ACTIVE member of notifications.org_id;
--          otherwise the row is SKIPPED (RETURN NULL), not refused, so one
--          suspended watcher never sinks a batch insert for everyone else
--          (lib/projects.ts writes its release notices in one statement).
--       6. resource_id is caller-written text, so the same-notice cap below
--          trusts it only when it names a row of resource_type ('document',
--          'ticket', 'project', 'library' — the types the app's producers
--          fan out about) in the row's org. Any other resource_id is no key:
--          the cap then counts the kind alone.
--       7. rate caps (P0001), counted over the signed-in writer's own rows
--          (how the counts meet concurrency follows the list):
--            · per actor and recipient, last minute — 60 rows of the same
--              kind about the same verified resource, or of the same kind
--              when the resource is not verified (a poke pressed 60 times; a
--              loop that mints a fresh resource_id per row); 600 rows of
--              anything;
--            · per actor and recipient, last hour — 1,200 rows of anything:
--              twice the minute cap, so a sustained loop reaches one person
--              1,200 times an hour, not 36,000;
--            · per actor across every recipient, last minute — 3,000 rows:
--              ten times an org-wide audience, so one event's fan-out (a
--              role broadcast, an ack roster, the sweep's release notices —
--              each one row per recipient) never meets it, and no member can
--              flood the whole org.
--          A count sees committed rows only, so requests of one member in
--          flight at once each see the same baseline. The counts are taken
--          first WITHOUT a lock: a count already at its cap is refused
--          there, and a row far from every cap is judged as it stands, so
--          the requests of one fan-out (notifyMany's Promise.all, one
--          insert per recipient, each holding one of the API's pooled
--          connections) run side by side. A row NEAR a cap — the same
--          notice already sent to that person in the minute (the 60 cap is
--          smaller than the margin), or a count within 64 of its cap — and
--          every later row of one transaction (a transaction-local setting
--          marks the first; a multi-row statement such as the browser's
--          checkout sweep) are counted again under a transaction-scoped
--          advisory lock keyed on the actor, one after another, each seeing
--          every row committed before it. One key per transaction, so no
--          lock-order deadlock. A request waiting on the lock still holds
--          its pooled connection, which is why ordinary traffic never takes
--          it: until the third review fix it was taken for every row, so
--          one member's bulk fan-out ran one insert at a time and could
--          fill the API's pool for every other member. What the margin
--          buys: each row judged without the lock was at least 64 below
--          every cap (the first same notice of the minute, for the 60 cap),
--          so a count passes its cap only by such rows still uncommitted
--          when later rows reach the cap under the lock — at most one per
--          request of that member in flight at that moment, fewer than the
--          API pool's width; a burst of up to 60 concurrent requests that
--          commit as they land stays within every cap.
--          Legitimate paths that can meet a cap: a multi-document
--          operation under a wide ack policy (a bulk upload, a library-wide
--          policy change) the hourly or the per-actor one; and more than 60
--          revisions published in one library within a minute from one
--          browser the same-notice one, per library follower — each
--          publish's library_doc_revised row is keyed on the LIBRARY, a
--          verified resource (lib/postPublish.ts). Past a cap the bell
--          copies are refused and logged by notify(); an obligation is not
--          — the acknowledgment roster row, the inbox and the cron's
--          re-nudge stand.
--     notifications_org_insert is KEPT unchanged: RLS's WITH CHECK runs after
--     this trigger and checks the caller's membership again.
--   · notifications_actor_recipient_idx (actor_user_id, user_id, created_at)
--     and notifications_actor_created_idx (actor_user_id, created_at) — each
--     cap's count is an index range scan.
--
-- Pre-apply inventory (DEC-30, aggregate counts only): the rows already
-- written that the new rules would have refused or skipped, the minute and
-- hour buckets in the last 30 days that would have met a cap, and the
-- busiest minute and hour one actor actually wrote — the numbers the caps
-- are sized against (rows that name an actor only: server rows that name
-- one are counted too, browser rows that named none before this paste are
-- not). No existing row is changed; the undeclared-kind count is reported
-- AFTER the apply (it reads notification_kinds()) and is unchanged by this
-- paste.
--
-- DEPLOY ORDER: either order is safe. The app reads nothing this file adds;
-- before the paste the browser writes as it did. After it, a row a rule
-- refuses is logged by notify() (lib/inAppNotifications.ts), never thrown
-- into a user flow.
--
-- A KIND ADDED LATER (N8, N9, N12 …): re-create notification_kinds() from
-- its NEWEST definition plus the new rows, in the same package as the
-- KIND_META entry, and paste that migration BEFORE the deploy that writes
-- the kind — once this file is live, a browser's row of a kind the live
-- function does not list is refused (22023) and only logged. Paste those
-- migrations in number order; each newer definition must be a superset of
-- the one before it (the parity test pins the newest to KIND_META, so a
-- branch that dropped another package's kinds fails CI at merge).
--
-- A SERVER DEDUPE ADDED LATER: a server path that decides whether to send
-- by reading notifications rows must key on a kind or a metadata key rule 2
-- or rule 4 refuses from a browser, or a member can forge the row that
-- silences it. lib/__tests__/notificationWriteRails.test.ts pins every such
-- read in the app to its watermark (a new one fails CI until it is
-- classified) and checks that no browser path writes a listed key or kind;
-- adding one is a re-create of this function from its newest definition.
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
                              HAVING COUNT(*) > 600) b)::text
UNION ALL
SELECT 7, 'BEFORE: clock hours in the last 30 days with more than 1,200 rows from one actor to one recipient (the hourly cap; a clock hour under-counts a sliding one)',
       (SELECT COUNT(*) FROM (SELECT 1 FROM notifications
                               WHERE created_at >= now() - interval '30 days' AND actor_user_id IS NOT NULL
                               GROUP BY actor_user_id, user_id, date_trunc('hour', created_at)
                              HAVING COUNT(*) > 1200) b)::text
UNION ALL
SELECT 8, 'BEFORE: minute buckets in the last 30 days with more than 3,000 rows from one actor across all recipients (the per-actor cap)',
       (SELECT COUNT(*) FROM (SELECT 1 FROM notifications
                               WHERE created_at >= now() - interval '30 days' AND actor_user_id IS NOT NULL
                               GROUP BY actor_user_id, date_trunc('minute', created_at)
                              HAVING COUNT(*) > 3000) b)::text
UNION ALL
SELECT 9, 'BEFORE: the most rows one actor wrote in one minute in the last 30 days, across all recipients (what the 3,000 cap is sized against)',
       (SELECT COALESCE(MAX(c), 0) FROM (SELECT COUNT(*) AS c FROM notifications
                                          WHERE created_at >= now() - interval '30 days' AND actor_user_id IS NOT NULL
                                          GROUP BY actor_user_id, date_trunc('minute', created_at)) b)::text
UNION ALL
SELECT 10, 'BEFORE: the most rows one actor wrote to one recipient in one clock hour in the last 30 days (what the 1,200 cap is sized against)',
       (SELECT COALESCE(MAX(c), 0) FROM (SELECT COUNT(*) AS c FROM notifications
                                          WHERE created_at >= now() - interval '30 days' AND actor_user_id IS NOT NULL
                                          GROUP BY actor_user_id, user_id, date_trunc('hour', created_at)) b)::text
UNION ALL
SELECT 11, 'BEFORE: rows dated in the future (a browser''s row is dated when it is written from now on; existing rows are kept)',
       (SELECT COUNT(*) FROM notifications WHERE created_at > now() + interval '5 minutes')::text
UNION ALL
SELECT 12, 'BEFORE: rows carrying a server dedupe watermark (a server-only kind or metadata key) that name an actor — the server''s own name none; a forged one keeps silencing its escalation until it is deleted (kept by this paste)',
       (SELECT COUNT(*) FROM notifications
         WHERE actor_user_id IS NOT NULL
           AND (kind IN ('transmittal_unstampable', 'storage_alert', 'storage_platform_r2', 'storage_platform_db')
                OR metadata ?| ARRAY['staleSessionId', 'staleHoldId', 'reviewHealthDay', 'ackEscalation']))::text;

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
  v_res uuid;
  v_res_ok boolean := false;
  v_same int;
  v_any int;
  v_hour int;
  v_actor int;
  v_lock boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- 0. the writer is an active member of the row's org — before anything
  --    else of that org is read with this function's rights
  IF NOT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = NEW.org_id AND m.uid = v_uid AND m.status = 'active') THEN
    RAISE EXCEPTION 'notifications: not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  -- 1. the actor is the signed-in member; the row is dated now
  IF NEW.actor_user_id IS NULL THEN
    NEW.actor_user_id := v_uid;
  ELSIF NEW.actor_user_id <> v_uid THEN
    RAISE EXCEPTION 'notifications: a notification''s actor must be the signed-in member' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();

  -- 2. a declared kind, and not one only the server writes
  IF NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = NEW.kind) THEN
    RAISE EXCEPTION 'notifications: unknown kind %', NEW.kind USING ERRCODE = '22023';
  END IF;
  IF NEW.kind IN ('transmittal_unstampable', 'storage_alert', 'storage_platform_r2', 'storage_platform_db') THEN
    RAISE EXCEPTION 'notifications: kind % is written only by the server', NEW.kind USING ERRCODE = '22023';
  END IF;

  -- 3. an app-relative link
  IF NEW.link IS NOT NULL AND NEW.link <> ''
     AND NOT (left(NEW.link, 1) = '/' AND substr(NEW.link, 2, 1) NOT IN ('/', E'\\') AND strpos(NEW.link, E'\\') = 0 AND NEW.link !~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'notifications: a link must be an app-relative path' USING ERRCODE = '22023';
  END IF;

  -- 4. no server dedupe watermark in the metadata
  IF NEW.metadata ?| ARRAY['staleSessionId', 'staleHoldId', 'reviewHealthDay', 'ackEscalation'] THEN
    RAISE EXCEPTION 'notifications: the metadata carries a dedupe watermark only the server writes' USING ERRCODE = '22023';
  END IF;

  -- 5. an active member of the org receives it; anyone else is skipped
  IF NOT EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = NEW.org_id AND m.uid = NEW.user_id AND m.status = 'active') THEN
    RETURN NULL;
  END IF;

  -- 6. the resource is a key only when it names a row of its type in this org
  IF NEW.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_res := NEW.resource_id::uuid;
    v_res_ok := CASE NEW.resource_type
      WHEN 'document' THEN EXISTS (SELECT 1 FROM documents r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      WHEN 'ticket'   THEN EXISTS (SELECT 1 FROM tickets r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      WHEN 'project'  THEN EXISTS (SELECT 1 FROM projects r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      WHEN 'library'  THEN EXISTS (SELECT 1 FROM libraries r WHERE r.id = v_res AND r.org_id = NEW.org_id)
      ELSE false
    END;
  END IF;

  -- 7. rate caps: per (actor, recipient) a minute and an hour, per actor a
  --    minute. Counted first without a lock, so one fan-out's requests run
  --    side by side; a count already at a cap is refused there. A row near
  --    a cap — the same notice already sent to this person in the minute,
  --    or a count within 64 of its cap — and every later row of one
  --    transaction are counted again under the actor's lock, one after
  --    another (a concurrent insert from the same actor that needs the
  --    lock waits here until this one commits)
  v_lock := coalesce(current_setting('notif_rail.wrote_row', true), '') = 'y';
  PERFORM set_config('notif_rail.wrote_row', 'y', true);
  LOOP
    IF v_lock THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('notif-cap:' || v_uid::text, 0));
    END IF;
    SELECT COUNT(*) FILTER (WHERE n.created_at > now() - interval '1 minute' AND n.kind = NEW.kind
                              AND (NOT v_res_ok OR n.resource_id IS NOT DISTINCT FROM NEW.resource_id)),
           COUNT(*) FILTER (WHERE n.created_at > now() - interval '1 minute'),
           COUNT(*)
      INTO v_same, v_any, v_hour
      FROM notifications n
     WHERE n.actor_user_id = v_uid
       AND n.user_id = NEW.user_id
       AND n.created_at > now() - interval '1 hour';
    IF v_same >= 60 THEN
      RAISE EXCEPTION 'notifications: rate limit — 60 of the same notification to one person per minute';
    END IF;
    IF v_any >= 600 THEN
      RAISE EXCEPTION 'notifications: rate limit — 600 notifications to one person per minute';
    END IF;
    IF v_hour >= 1200 THEN
      RAISE EXCEPTION 'notifications: rate limit — 1200 notifications to one person per hour';
    END IF;
    SELECT COUNT(*) INTO v_actor
      FROM (SELECT 1 FROM notifications n
             WHERE n.actor_user_id = v_uid
               AND n.created_at > now() - interval '1 minute'
             LIMIT 3000) s;
    IF v_actor >= 3000 THEN
      RAISE EXCEPTION 'notifications: rate limit — 3000 notifications per minute from one member';
    END IF;
    EXIT WHEN v_lock
           OR (v_same = 0 AND v_any < 600 - 64 AND v_hour < 1200 - 64 AND v_actor < 3000 - 64);
    v_lock := true;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_notification_insert() IS
  'BEFORE INSERT on notifications: the service role passes untouched; a signed-in writer must be an active member of the row''s org (checked before anything else of that org is read), is stamped as the actor (another actor refused) and the row dated now; the kind must be declared (notification_kinds()) and not server-only, the link app-relative, the metadata free of the server''s dedupe watermark keys; a recipient who is not an active member of the org is skipped; the caps — counted without a lock, and again one insert at a time per actor (an advisory lock) for a row near a cap or a later row of one transaction — are 60 same-notice (the resource counts only when it names a row of its type in the org) and 600 any rows per actor and recipient per minute, 1200 per actor and recipient per hour, and 3000 per actor per minute across all recipients. notifications Round G, 20261160.';

REVOKE ALL ON FUNCTION enforce_notification_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notifications_enforce_insert ON notifications;
CREATE TRIGGER trg_notifications_enforce_insert
  BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION enforce_notification_insert();

CREATE INDEX IF NOT EXISTS notifications_actor_recipient_idx
  ON notifications (actor_user_id, user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_actor_created_idx
  ON notifications (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 17 ────────
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
SELECT 'enforce_notification_insert: the caller must be an active member of the row''s org (42501), checked right after the service role''s return and before the recipient and resource reads — no definer read of another tenant',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%IF v_uid IS NULL THEN%RETURN NEW;%END IF;%m.org_id = NEW.org_id AND m.uid = v_uid AND m.status = ''active'') THEN%not a member of this workspace%42501%'
                  AND position('m.uid = v_uid' IN prosrc) < position('NEW.actor_user_id' IN prosrc)
                  AND position('m.uid = v_uid' IN prosrc) < position('m.uid = NEW.user_id' IN prosrc)
                  AND position('m.uid = v_uid' IN prosrc) < position('FROM documents r' IN prosrc)),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: the actor is stamped when absent and refused when it is someone else',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%IF NEW.actor_user_id IS NULL THEN%NEW.actor_user_id := v_uid;%ELSIF NEW.actor_user_id <> v_uid THEN%RAISE EXCEPTION%42501%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: a browser''s row is dated when it is written (no back-dating under the caps, no future-dated row pinned to a bell)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%ELSIF NEW.actor_user_id <> v_uid THEN%END IF;%NEW.created_at := now();%IF NOT EXISTS (SELECT 1 FROM notification_kinds() k%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: an undeclared kind and a link that is not app-relative are refused',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%IF NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = NEW.kind) THEN%'
                  AND prosrc LIKE '%left(NEW.link, 1) = ''/''%substr(NEW.link, 2, 1) NOT IN%strpos(NEW.link, %[[:cntrl:]]%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: a server-only kind and a server dedupe watermark key in the metadata are refused (22023)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%IF NEW.kind IN (''transmittal_unstampable'', ''storage_alert'', ''storage_platform_r2'', ''storage_platform_db'') THEN%22023%'
                  AND prosrc LIKE '%IF NEW.metadata ?| ARRAY[''staleSessionId'', ''staleHoldId'', ''reviewHealthDay'', ''ackEscalation''] THEN%22023%'
                  AND position('NEW.metadata ?|' IN prosrc) < position('RETURN NULL;' IN prosrc)),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: a recipient who is not an active member of the org is skipped (RETURN NULL), never refused',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%m.org_id = NEW.org_id AND m.uid = NEW.user_id AND m.status = ''active'') THEN%RETURN NULL;%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: the same-notice cap keys on resource_id only when it names a row of its type in the org — otherwise on the kind alone',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%WHEN ''document'' THEN EXISTS (SELECT 1 FROM documents r WHERE r.id = v_res AND r.org_id = NEW.org_id)%'
                  AND prosrc LIKE '%WHEN ''ticket''%WHEN ''project''%WHEN ''library''%ELSE false%'
                  AND prosrc LIKE '%(NOT v_res_ok OR n.resource_id IS NOT DISTINCT FROM NEW.resource_id)%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: the caps are 60 same-notice and 600 any per actor and recipient per minute, 1200 per actor and recipient per hour, 3000 per actor per minute',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%n.actor_user_id = v_uid%n.user_id = NEW.user_id%n.created_at > now() - interval ''1 hour''%'
                  AND prosrc LIKE '%IF v_same >= 60 THEN%IF v_any >= 600 THEN%IF v_hour >= 1200 THEN%LIMIT 3000%IF v_actor >= 3000 THEN%'),
       NULL
UNION ALL
SELECT 'enforce_notification_insert: a row near a cap, and every later row of one transaction, is counted again one after another under an advisory lock keyed on the actor — an ordinary row takes no lock',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_notification_insert'
                  AND prosrc LIKE '%v_lock := coalesce(current_setting(''notif_rail.wrote_row'', true), '''') = ''y'';%PERFORM set_config(''notif_rail.wrote_row'', ''y'', true);%LOOP%IF v_lock THEN%PERFORM pg_advisory_xact_lock(hashtextextended(''notif-cap:'' || v_uid::text, 0));%END IF;%INTO v_same, v_any, v_hour%IF v_actor >= 3000 THEN%EXIT WHEN v_lock%OR (v_same = 0 AND v_any < 600 - 64 AND v_hour < 1200 - 64 AND v_actor < 3000 - 64);%v_lock := true;%END LOOP;%'),
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
SELECT 'notifications_actor_recipient_idx and notifications_actor_created_idx exist',
       (SELECT COUNT(*) = 2 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'notifications'
           AND indexname IN ('notifications_actor_recipient_idx', 'notifications_actor_created_idx')),
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
