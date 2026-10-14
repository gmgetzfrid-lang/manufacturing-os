-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N10 PUSH (fix pass): push_subscriptions gets ONE
-- writer, the service-role route /api/push/subscribe (OS-10, the review's
-- blocker and its OS-10 done-when 3 minor).
--
-- 20260804 created push_subscriptions with an own-row INSERT policy,
-- push_sub_insert_own: any signed-in member could insert their own row
-- through PostgREST, with ANY endpoint text and any created_at, without the
-- opt-in control and without a browser subscription. The push sender
-- (lib/push/sendPush.ts, service role) POSTs to the endpoints it reads, so a
-- row a member wrote by hand made the server call a URL of their choosing.
-- The app now checks every endpoint against the browser push services'
-- hosts at the opt-in and again before each send (lib/push/endpoints.ts),
-- and caps a person's devices; this file closes the door such a row came in
-- by, so a device row exists only because the route stored it.
--
-- What this file does:
--   · DROP POLICY push_sub_insert_own ON push_subscriptions (its newest and
--     only definition is 20260804; no later file re-creates it). With row
--     level security on and no INSERT policy left, a signed-in member's
--     insert is refused; the service role (the route) is not bound by RLS.
--   · Nothing else. push_sub_select_own (the settings card reads its own
--     row) and push_sub_delete_own (a member may remove their own device)
--     stay as they are. No row is changed: no INSERT, UPDATE or DELETE. A row
--     already stored that names no push service is removed by the app (the
--     sender before any send, the maintenance cron's step 7c), never here.
--
-- Not widening (DEC-30): nobody may do more after this file — it only takes
-- a write away from signed-in members. The inventory below (aggregate counts
-- only, read BEFORE the change) sizes what the app's checks bear on.
--
-- PASTE AND DEPLOY ORDER: either order is safe.
--   · The app never inserts a device row as a signed-in member: the opt-in
--     card POSTs /api/push/subscribe, which writes on the service role. So
--     the app works the same before and after this paste.
--   · Before this paste a member can still insert their own row by hand;
--     the deployed sender refuses (and deletes) any row off the push
--     services' hosts and reads at most the 10 newest per person, so such a
--     row can no longer make the server call an address of the member's
--     choosing. After the paste the insert itself is refused.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (the policy is
-- dropped IF EXISTS; the inventory is re-read; a re-run shows inventory row 5
-- as 0). Needs 20260804 (the table): without it the paste stops at the
-- inventory ('relation "push_subscriptions" does not exist'), before BEGIN,
-- and nothing is changed.
--
-- Exercised on PostgreSQL 16 (notifications Round G, N10 fix pass): before
-- the paste a member's own-row insert naming https://10.0.3.7:8443/… landed;
-- after it the same insert is refused (42501, row-level security), the
-- member still reads and deletes only their own rows, updates nothing, and
-- the service role still inserts, hands a row over on matching keys only,
-- and claims a device for a row exactly once; the re-run answers the same.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_211_before;
CREATE TEMP TABLE notif_round_g_211_before AS
SELECT 1 AS ord, 'BEFORE: push_subscriptions rows (device registrations)' AS inventory,
       (SELECT COUNT(*) FROM push_subscriptions)::text AS n
UNION ALL
SELECT 2, 'BEFORE: rows whose endpoint names no browser push service host (fcm.googleapis.com, *.push.services.mozilla.com, *.notify.windows.com, web.push.apple.com / *.push.apple.com — the sender never posts to one and deletes it; the maintenance cron removes the rest; lib/push/endpoints.ts is the authority)',
       (SELECT COUNT(*) FROM push_subscriptions
         WHERE lower(endpoint) !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|[a-z0-9.-]+\.push\.apple\.com)(/|\?|#|$)')::text
UNION ALL
SELECT 3, 'BEFORE: people holding more than 10 registrations (PUSH_DEVICE_CAP — the sender reads only the 10 newest; the next opt-in removes the oldest)',
       (SELECT COUNT(*) FROM (SELECT 1 FROM push_subscriptions GROUP BY user_id HAVING COUNT(*) > 10) d)::text
UNION ALL
SELECT 4, 'BEFORE: rows made before the opt-in control existed (created_at < 2026-10-14, PUSH_OPT_IN_SINCE — never pushed; the maintenance cron removes them)',
       (SELECT COUNT(*) FROM push_subscriptions WHERE created_at < timestamptz '2026-10-14 00:00:00+00')::text
UNION ALL
SELECT 5, 'BEFORE: push_sub_insert_own present (1) or already gone (0)',
       (SELECT COUNT(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'push_subscriptions' AND policyname = 'push_sub_insert_own')::text;

BEGIN;

-- ── 1. The only writer is the service-role route ────────────────────────────
DROP POLICY IF EXISTS push_sub_insert_own ON push_subscriptions;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- Expect: ok = true × 4; then the 5 BEFORE inventory counts (ok NULL).
SELECT 'push_sub_insert_own is gone: a signed-in member can no longer insert a push_subscriptions row directly' AS check,
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
                      AND policyname = 'push_sub_insert_own') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'push_subscriptions has no INSERT, UPDATE or ALL policy at all, so only the service role (POST /api/push/subscribe) writes a device row (false: list pg_policies for the table and remove the stray one)',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
                      AND cmd IN ('INSERT', 'UPDATE', 'ALL')),
       NULL
UNION ALL
SELECT 'push_sub_select_own and push_sub_delete_own still stand, each bound to the member''s own rows (the settings card reads its own row; a member may remove their own device)',
       COALESCE((SELECT COUNT(*) = 2
                   FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
                    AND ((policyname = 'push_sub_select_own' AND cmd = 'SELECT')
                      OR (policyname = 'push_sub_delete_own' AND cmd = 'DELETE'))
                    AND qual LIKE '%auth.uid() = user_id%'), false),
       NULL
UNION ALL
SELECT 'row level security is still enabled on push_subscriptions',
       COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                  WHERE ns.nspname = 'public' AND c.relname = 'push_subscriptions'), false),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_211_before ORDER BY ord) b;
