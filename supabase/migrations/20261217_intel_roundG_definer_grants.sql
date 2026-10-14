-- ─────────────────────────────────────────────────────────────────────────────
-- 20261217 — intelligence Round G, I-17 DATABASE HARNESS: the SECURITY
-- DEFINER grant census's one narrowing (projects-and-cost INTK-14 done-when
-- 2; the DRLS-16 rule).
--
--   The census (lib/__tests__/rls/definerCensus.test.ts) reads the EXECUTE
--   grants of every SECURITY DEFINER function on a fresh replay of the whole
--   sequence and holds each to a reasoned decision
--   (lib/__tests__/rls/definerDecisions.ts). Supabase's default privileges
--   grant EXECUTE on every function `postgres` creates in public to anon,
--   authenticated and service_role, on top of PostgreSQL's PUBLIC grant, so a
--   `REVOKE … FROM PUBLIC` alone still leaves the anon key able to call it.
--   One function gets a REVOKE here; every other decision is recorded, not
--   changed (a policy helper must stay executable by the roles its policies
--   judge — revoking it would turn an empty answer into an error).
--
--     · member_is_active(uuid, uuid) — 20261042. "Is this uid an active
--       member of this org?" (with a NULL org: of any org) for ANY uid,
--       callable over PostgREST with the public anon key. Nothing calls it but
--       user_is_effective_owner, a SECURITY DEFINER function owned by
--       postgres, which keeps calling it as its owner. No app .rpc( call, no
--       policy, no SECURITY INVOKER function names it. → EXECUTE for
--       service_role only.
--
-- THE MEMBERSHIP ORACLE IS NOT CLOSED BY THIS FILE. It takes away the direct
-- door only. Until projects-and-cost INTK-19 lands, the same answer stays
-- reachable: user_is_effective_owner(X, NULL, <a library>, X), callable with
-- the anon key, returns member_is_active(<that library's org>, X) (with no
-- library, whether X is active in any org), and node_visible's p_owner, which
-- a caller supplies over RPC, tells a signed-in library owner whether X is
-- active (the harness pins both answers as INTK-19's remainder).
--
-- DEC-90 RULING 4. A REVOKE is allowed "only for functions the app never
-- calls as anon/authenticated". The app never calls member_is_active, so it
-- is revoked. next_ticket_number, issue_document_number and
-- force_release_document are called by the app as authenticated
-- (app/api/tickets/create/route.ts:673, lib/ticketNumber.ts:84,
-- lib/libraryNumbering.ts:46, lib/checkoutEpisodes.ts:709), and the
-- integrator RULED (DEC-90 ruling 4): no revoke for them — each body already
-- refuses a caller with no session (next_ticket_number and
-- force_release_document raise; issue_document_number answers NULL), and a
-- revoke would only add a misleading error path. That decision is final, with
-- no owner; this file does not touch them.
--
-- LIVE-DATABASE PRECONDITION (fail-safe; the user's first rule is no
-- regression). The census reasoned "nothing but user_is_effective_owner calls
-- it" on a replay of the repository. The live project may hold something the
-- repository does not, so before the transaction the inventory COUNTS, on the
-- live catalog, everything else that could call member_is_active as a client
-- role: row-level-security policies whose USING / WITH CHECK names it;
-- SECURITY INVOKER functions (any schema but pg_catalog and
-- information_schema) whose body names it; views and materialized views whose
-- definition names it; SECURITY DEFINER functions other than
-- user_is_effective_owner (and member_is_active itself) whose body names it;
-- a user_is_effective_owner whose owner is neither member_is_active's owner
-- nor a superuser (it would lose the call once PUBLIC is revoked); and column
-- defaults, CHECK constraints and trigger definitions that name it. The
-- REVOKE runs only when every one of those counts is 0. Otherwise the file
-- RAISEs a NOTICE, CHANGES NOTHING, and its precondition probe answers false
-- (the counts say what to read).
--
-- NARROWS (nobody signed in loses anything; no app code calls the function).
-- No function, policy or trigger is created or re-created; no row is read.
-- Pre-apply inventory (DEC-30): aggregate COUNTs of the catalog only,
-- captured into a TEMP TABLE before the transaction. Never a customer row.
--
-- BEFORE THE PASTE the app works as today. AFTER IT: every signed-in call
-- answers exactly as before (the harness runs next_ticket_number,
-- issue_document_number, force_release_document and user_is_effective_owner
-- as a member, before and after this file, on a replay of the whole
-- sequence); an anon-key or signed-in call of member_is_active gets 42501. A
-- database without the function is skipped (the REVOKE is guarded by
-- to_regprocedure).
--
-- PASTE FACTS.
--   ORDER: independent of every other pending file.
--   DEPLOY GATE: none — either order with any deploy (no app change depends
--   on it).
--   EXPECTED RESULT (one result set, 13 rows): 3 probes with ok = true (the
--   precondition held; only service_role may execute member_is_active;
--   user_is_effective_owner is still SECURITY DEFINER), n NULL; then 10 count
--   rows (ok NULL): the anon-executable SECURITY DEFINER functions after the
--   paste; member_is_active present (1); the roles of anon / authenticated /
--   PUBLIC that could execute it before (3 on a first paste, 0 on a re-paste);
--   the anon-executable SECURITY DEFINER functions before (one more than after
--   on a first paste: 28 → 27 on the harness's replay); and the six
--   precondition counts, each 0. A precondition count above 0 means nothing
--   was changed: the precondition probe and the member_is_active probe answer
--   false, and the NOTICE gives the total (the six rows say which). ok NULL
--   on a probe only for a database without member_is_active.
--   ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (a re-paste
--   re-checks the precondition and changes nothing more).
--
-- ROLLBACK (restores the pre-paste ACL exactly: PUBLIC, anon, authenticated
-- and service_role; service_role is never revoked):
--   GRANT EXECUTE ON FUNCTION public.member_is_active(uuid, uuid) TO PUBLIC, anon, authenticated;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory and the live-database precondition (counts only) ─
-- `pre` marks a precondition count: the REVOKE runs only when all are 0.
DROP TABLE IF EXISTS intel_i17_20261217_inventory;
CREATE TEMP TABLE intel_i17_20261217_inventory (ord int, check_name text, n bigint, pre boolean);
INSERT INTO intel_i17_20261217_inventory
SELECT 1, 'before: member_is_active(uuid, uuid) present (1) or absent (0)', COUNT(*), false
  FROM (SELECT to_regprocedure('public.member_is_active(uuid,uuid)') AS f) x
 WHERE f IS NOT NULL
UNION ALL
SELECT 2, 'before: roles of anon / authenticated / PUBLIC that may execute member_is_active', COUNT(*), false
  FROM (SELECT to_regprocedure('public.member_is_active(uuid,uuid)') AS f) x
  JOIN pg_proc p ON p.oid = x.f
 CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
 WHERE a.privilege_type = 'EXECUTE'
   AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))
UNION ALL
SELECT 3, 'before: SECURITY DEFINER functions in public the anon role may execute (all of them, for the record)', COUNT(*), false
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
   AND p.prorettype <> 'trigger'::regtype
   AND has_function_privilege('anon', p.oid, 'EXECUTE')
UNION ALL
SELECT 4, 'precondition (expect 0): row-level-security policies whose USING or WITH CHECK names member_is_active(', COUNT(*), true
  FROM pg_policy pol
 WHERE COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') ~ '\mmember_is_active\s*\('
    OR COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ '\mmember_is_active\s*\('
UNION ALL
SELECT 5, 'precondition (expect 0): SECURITY INVOKER functions whose body names member_is_active(', COUNT(*), true
  FROM pg_proc p
 WHERE NOT p.prosecdef
   AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
   AND (COALESCE(p.prosrc, '') ~ '\mmember_is_active\s*\('
        OR COALESCE(CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_function_sqlbody(p.oid) END, '') ~ '\mmember_is_active\s*\(')
UNION ALL
SELECT 6, 'precondition (expect 0): views and materialized views whose definition names member_is_active(', COUNT(*), true
  FROM (SELECT definition FROM pg_views UNION ALL SELECT definition FROM pg_matviews) v
 WHERE COALESCE(v.definition, '') ~ '\mmember_is_active\s*\('
UNION ALL
SELECT 7, 'precondition (expect 0): SECURITY DEFINER functions other than user_is_effective_owner whose body names member_is_active(', COUNT(*), true
  FROM pg_proc p
 WHERE p.prosecdef
   AND p.proname <> 'user_is_effective_owner'
   AND p.oid IS DISTINCT FROM to_regprocedure('public.member_is_active(uuid,uuid)')
   AND (COALESCE(p.prosrc, '') ~ '\mmember_is_active\s*\('
        OR COALESCE(CASE WHEN p.prosqlbody IS NOT NULL THEN pg_get_function_sqlbody(p.oid) END, '') ~ '\mmember_is_active\s*\(')
UNION ALL
SELECT 8, 'precondition (expect 0): user_is_effective_owner functions owned by a role that is neither member_is_active''s owner nor a superuser (they would lose the call)', COUNT(*), true
  FROM pg_proc p
  JOIN pg_roles r ON r.oid = p.proowner
 CROSS JOIN (SELECT to_regprocedure('public.member_is_active(uuid,uuid)') AS f) x
  JOIN pg_proc m ON m.oid = x.f
 WHERE p.proname = 'user_is_effective_owner'
   AND p.proowner <> m.proowner AND NOT r.rolsuper
UNION ALL
SELECT 9, 'precondition (expect 0): column defaults, CHECK constraints and trigger definitions that name member_is_active(', (
         (SELECT COUNT(*) FROM pg_attrdef d WHERE pg_get_expr(d.adbin, d.adrelid) ~ '\mmember_is_active\s*\(')
       + (SELECT COUNT(*) FROM pg_constraint c WHERE c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ '\mmember_is_active\s*\(')
       + (SELECT COUNT(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ~ '\mmember_is_active\s*\(')), true;

BEGIN;

DO $grants$
DECLARE
  v_blockers bigint;
BEGIN
  IF to_regprocedure('public.member_is_active(uuid,uuid)') IS NOT NULL THEN
    SELECT COALESCE(SUM(n), 0) INTO v_blockers FROM intel_i17_20261217_inventory WHERE pre;
    IF v_blockers = 0 THEN
      REVOKE ALL ON FUNCTION public.member_is_active(uuid, uuid) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.member_is_active(uuid, uuid) TO service_role;
    ELSE
      RAISE NOTICE '20261217 changed nothing: % object(s) other than user_is_effective_owner name member_is_active (or its owner would lose the call); read the precondition rows of the result', v_blockers;
    END IF;
  END IF;
END
$grants$;

COMMIT;

-- ── verification + inventory — ONE result set ───────────────────────────────
-- Probes carry ok (expect true; NULL only for a database without
-- member_is_active), n NULL; count rows carry n, ok NULL.
SELECT 'precondition: nothing but user_is_effective_owner names member_is_active (no policy, view, default, CHECK, trigger or other function), and its owner keeps the call — so the REVOKE ran (false: nothing was changed; read the precondition rows)'::text AS "check",
       CASE WHEN to_regprocedure('public.member_is_active(uuid,uuid)') IS NOT NULL
            THEN (SELECT COALESCE(SUM(i.n), 0) = 0 FROM intel_i17_20261217_inventory i WHERE i.pre) END AS ok,
       NULL::text AS n
UNION ALL
SELECT 'member_is_active: only service_role may execute it (PUBLIC, anon, authenticated revoked; false when the precondition is false)',
       (SELECT NOT has_function_privilege('anon', f, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
               AND has_function_privilege('service_role', f, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM (SELECT to_regprocedure('public.member_is_active(uuid,uuid)') AS f) x WHERE f IS NOT NULL),
       NULL
UNION ALL
SELECT 'user_is_effective_owner (the one caller of member_is_active) is still SECURITY DEFINER, so it keeps calling it as its owner',
       (SELECT bool_and(p.prosecdef) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'user_is_effective_owner'),
       NULL
UNION ALL
SELECT 'after: SECURITY DEFINER functions in public the anon role may execute', NULL,
       (SELECT COUNT(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
           AND p.prorettype <> 'trigger'::regtype
           AND has_function_privilege('anon', p.oid, 'EXECUTE'))::text
UNION ALL
SELECT check_name, NULL, n::text FROM (SELECT check_name, n FROM intel_i17_20261217_inventory ORDER BY ord) i;
