-- 20261238_ao_roundG_signup_attempts_housekeeping.sql
--
-- admin-and-org Round G, package P5 — ORG-12 / BILL-14 (the attempt log's
-- housekeeping) and ORG-8 (the public request door). DEC-90's rulings for
-- the package, as built.
--
-- WHY A MIGRATION AT ALL: the app half needs none — the maintenance cron now
-- calls prune_signup_attempts() (step 4e, service role) and the two public
-- doors share the window in lib/publicDoorLimiter.ts, before and after this
-- paste. This file only puts right, IN THE DATABASE, three things the
-- function and its tables say about themselves:
--   1. prune_signup_attempts() keeps TWO DAYS (20261010, unchanged here): the
--      one-hour window the doors read plus a short tail an operator can read
--      back when a door is abused. 20261010's comment said the table "only
--      needs a rolling window" and named a cron caller that did not exist;
--      the function's own COMMENT now states the retention, why, and its one
--      caller. The body is NOT re-created (no CREATE OR REPLACE) — the
--      retention stays exactly 2 days, probed below.
--   2. The function was executable by PUBLIC (the default), so anon and every
--      signed-in session could call it over PostgREST. It is SECURITY INVOKER
--      and the table has RLS on with no policy, so such a call deleted
--      nothing — but housekeeping is the service role's alone, as for
--      prune_verify_scans (20261134) and prune_intake_attempts (20261105):
--      EXECUTE is revoked from PUBLIC, anon and authenticated and granted to
--      service_role, and its search_path is pinned (ALTER FUNCTION … SET).
--   3. ORG-8 done-when 4: the anonymous INSERT policy on access_requests
--      (access_requests_anyone_insert, 20260819) was dropped by 20261023
--      (EGRESS-5, LIVE). It is re-asserted here (DROP POLICY IF EXISTS — a
--      no-op where 20261023 ran) and PROBED, so the paste's result says the
--      route is the only way in: the route writes as the service role.
-- The table comment on signup_attempts says what it holds and why it is never
-- exported (lib/exportTables.ts EXPORT_EXCLUDED_TABLES.signup_attempts).
--
-- NOT A WIDENING: it lets nobody do anything new — one EXECUTE grant is
-- narrowed to the service role (which already had it through PUBLIC), and a
-- policy that should not exist is dropped if it does. No row is changed or
-- deleted (the first prune runs from the cron, not from this paste). The
-- before-apply inventory is aggregate counts only; it is dropped and
-- re-captured on every paste.
--
-- NEEDS 20261010 (signup_attempts, prune_signup_attempts) and 20261023
-- (access_requests.org_id; LIVE). MIGRATION-PASTE-ORDER.md row 9 records
-- 20261010 as "ASK / unknown": pasted without it, this file stops at the first
-- statement, names it, and changes nothing. (Until 20261010 is pasted the
-- doors run without a per-IP window — logged — and the cron step is a no-op.)
--
-- WHEN TO PASTE: either order with the A&O P5 deploy. Before the paste, the
-- cron's prune runs as the service role through PUBLIC's grant; after it,
-- through the explicit grant — the same call, the same rows. No app code reads
-- the comments. 42883 / PGRST202 (no function) → the cron step is a no-op, as
-- before.
--
-- ROLLBACK (restores 20261010's grants and comment-less state):
--   GRANT EXECUTE ON FUNCTION prune_signup_attempts() TO PUBLIC;
--   ALTER FUNCTION prune_signup_attempts() RESET search_path;
--   COMMENT ON FUNCTION prune_signup_attempts() IS NULL;
--   COMMENT ON TABLE signup_attempts IS NULL;
-- (Do NOT re-create access_requests_anyone_insert: 20261023 dropped it on
-- purpose.) The app keeps working either way.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count). Until it is pasted, behaviour is unchanged.

DO $$
BEGIN
  IF to_regclass('public.signup_attempts') IS NULL
     OR to_regprocedure('public.prune_signup_attempts()') IS NULL THEN
    RAISE EXCEPTION '20261238 needs 20261010 (signup_attempts and prune_signup_attempts) — paste 20261010_signup_rate_limit.sql first. Nothing was changed.';
  END IF;
  IF to_regclass('public.access_requests') IS NULL THEN
    RAISE EXCEPTION '20261238 needs access_requests (20260819 / 20261023). Nothing was changed.';
  END IF;
END $$;

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ao_g238_before;
CREATE TEMP TABLE _ao_g238_before AS
SELECT 1 AS ord,
       'inventory: signup_attempts rows before this paste' AS inventory,
       (SELECT COUNT(*) FROM signup_attempts)::text AS n
UNION ALL
SELECT 2,
       'inventory: signup_attempts rows older than two days (the first cron prune removes these; this paste deletes nothing)',
       (SELECT COUNT(*) FROM signup_attempts WHERE created_at < NOW() - INTERVAL '2 days')::text
UNION ALL
SELECT 3,
       'inventory: signup_attempts rows inside the one-hour window the doors read',
       (SELECT COUNT(*) FROM signup_attempts WHERE created_at >= NOW() - INTERVAL '1 hour')::text
UNION ALL
SELECT 4,
       'inventory: client roles (public, anon, authenticated) able to EXECUTE prune_signup_attempts() before this paste (3 = 20261010''s default grant)',
       (SELECT COUNT(*) FROM (VALUES ('public'), ('anon'), ('authenticated')) r(role)
         WHERE (r.role = 'public' AND EXISTS (
                  SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = 'public.prune_signup_attempts()'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
            OR (r.role <> 'public' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role)
                AND has_function_privilege(r.role, 'public.prune_signup_attempts()', 'EXECUTE')))::text
UNION ALL
SELECT 5,
       'inventory: INSERT / ALL policies on access_requests before this paste (0 = as 20261023 left it)',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'access_requests' AND cmd IN ('INSERT', 'ALL'))::text;

BEGIN;

-- ── 1–2. the prune is the service role's, its retention stated ───────────
ALTER FUNCTION prune_signup_attempts() SET search_path = public;
REVOKE ALL ON FUNCTION prune_signup_attempts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_signup_attempts() TO service_role;

COMMENT ON FUNCTION prune_signup_attempts() IS
  'Keeps two days of signup_attempts: the one-hour per-IP window the two public sign-up doors read (lib/publicDoorLimiter.ts) plus a short tail an operator can read back when a door is abused. Called daily by /api/cron/maintenance (step 4e) as the service role; EXECUTE is service_role only (ORG-12 / BILL-14, 20261238).';

COMMENT ON TABLE signup_attempts IS
  'Per-IP attempt log for /api/auth/signup and /api/auth/request-access (client IP, the address typed at the door, an outcome). Service role only (RLS on, no policy). Kept two days by prune_signup_attempts(); never part of the data-portability export — it is personal data about people who may never have joined (20261010, 20261238).';

-- ── 3. ORG-8: no anonymous door around the request route ────────────────
DROP POLICY IF EXISTS access_requests_anyone_insert ON access_requests;

COMMIT;

-- ── One result set: probes (ok, n NULL) then the inventory (ok NULL, n) ──
SELECT check_name AS "check", ok, n FROM (
  SELECT 1 AS ord, 'prune_signup_attempts() still keeps exactly two days (its body is not re-created)' AS check_name,
         (SELECT prosrc LIKE '%DELETE FROM signup_attempts WHERE created_at < NOW() - INTERVAL ''2 days''%'
            FROM pg_proc WHERE oid = 'public.prune_signup_attempts()'::regprocedure) AS ok, NULL::text AS n
  UNION ALL
  SELECT 2, 'prune_signup_attempts() is SECURITY INVOKER, search_path pinned to public',
         (SELECT NOT prosecdef AND COALESCE('search_path=public' = ANY (proconfig), false)
            FROM pg_proc WHERE oid = 'public.prune_signup_attempts()'::regprocedure), NULL
  UNION ALL
  SELECT 3, 'PUBLIC holds no EXECUTE on prune_signup_attempts()',
         NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                      WHERE p.oid = 'public.prune_signup_attempts()'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), NULL
  UNION ALL
  SELECT 4, 'anon and authenticated cannot EXECUTE prune_signup_attempts()',
         NOT has_function_privilege('anon', 'public.prune_signup_attempts()', 'EXECUTE')
         AND NOT has_function_privilege('authenticated', 'public.prune_signup_attempts()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 5, 'service_role can EXECUTE prune_signup_attempts() (the cron''s step 4e)',
         has_function_privilege('service_role', 'public.prune_signup_attempts()', 'EXECUTE'), NULL
  UNION ALL
  SELECT 6, 'the function''s comment states the two-day retention and its caller',
         COALESCE(obj_description('public.prune_signup_attempts()'::regprocedure, 'pg_proc') LIKE 'Keeps two days of signup_attempts:%step 4e%', false), NULL
  UNION ALL
  SELECT 7, 'signup_attempts: RLS on, no policy (service role only), commented',
         (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.signup_attempts'::regclass)
         AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'signup_attempts')
         AND COALESCE(obj_description('public.signup_attempts'::regclass, 'pg_class') LIKE 'Per-IP attempt log%', false), NULL
  UNION ALL
  SELECT 8, 'ORG-8: access_requests has no INSERT / ALL policy — the route (service role) is the only way in',
         NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'access_requests' AND cmd IN ('INSERT', 'ALL')), NULL
  UNION ALL
  SELECT 9, 'access_requests: RLS on (anon and members cannot read or write it around the route)',
         (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.access_requests'::regclass), NULL
  UNION ALL
  SELECT 100 + ord, inventory, NULL, n FROM _ao_g238_before
  UNION ALL
  SELECT 200, 'after: signup_attempts rows (this paste deletes nothing — equal to the first inventory row)', NULL,
         (SELECT COUNT(*) FROM signup_attempts)::text
) probes
ORDER BY ord;
