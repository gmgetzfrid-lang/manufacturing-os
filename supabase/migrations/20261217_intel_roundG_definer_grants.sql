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
-- calls as anon/authenticated"; when unsure, the decision and its owner are
-- recorded instead. The app never calls member_is_active, so it is revoked.
-- next_ticket_number, issue_document_number and force_release_document are
-- called by the app as authenticated (app/api/tickets/create/route.ts:673,
-- lib/ticketNumber.ts:84, lib/libraryNumbering.ts:46,
-- lib/checkoutEpisodes.ts:709), so this file does not touch them: anon keeps
-- Supabase's default grant, and each body already refuses a caller with no
-- session (next_ticket_number and force_release_document raise;
-- issue_document_number answers NULL). Their rows in definerDecisions.ts
-- record that, with the integrator as owner.
--
-- NARROWS (nobody signed in loses anything; no app code calls the function).
-- No function, policy or trigger is created or re-created; no row is read.
-- Pre-apply inventory (DEC-30): aggregate COUNTs of the grant state only,
-- captured into a TEMP TABLE before the transaction. Never a customer row.
--
-- BEFORE THE PASTE the app works as today. AFTER IT: every signed-in call
-- answers exactly as before (the harness runs next_ticket_number,
-- issue_document_number, force_release_document and user_is_effective_owner
-- as a member, before and after this file, on a replay of the whole
-- sequence); an anon-key or signed-in call of member_is_active gets 42501. A
-- database without the function is skipped (the REVOKE is guarded by
-- to_regprocedure). ORDER: independent of every other pending file; either
-- order with any deploy (no app change depends on it). ⚠ APPLIED BY HAND
-- (DEC-30). One script; re-running is safe.
--
-- ROLLBACK (restores the pre-paste ACL exactly: PUBLIC, anon, authenticated
-- and service_role; service_role is never revoked):
--   GRANT EXECUTE ON FUNCTION public.member_is_active(uuid, uuid) TO PUBLIC, anon, authenticated;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS intel_i17_20261217_inventory (check_name text, n bigint);
TRUNCATE intel_i17_20261217_inventory;
INSERT INTO intel_i17_20261217_inventory
SELECT 'before: member_is_active(uuid, uuid) present (1) or absent (0)', COUNT(*)
  FROM (SELECT to_regprocedure('public.member_is_active(uuid,uuid)') AS f) x
 WHERE f IS NOT NULL
UNION ALL
SELECT 'before: roles of anon / authenticated / PUBLIC that may execute member_is_active', COUNT(*)
  FROM (SELECT to_regprocedure('public.member_is_active(uuid,uuid)') AS f) x
  JOIN pg_proc p ON p.oid = x.f
 CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
 WHERE a.privilege_type = 'EXECUTE'
   AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated')))
UNION ALL
SELECT 'before: SECURITY DEFINER functions in public the anon role may execute (all of them, for the record)', COUNT(*)
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
   AND p.prorettype <> 'trigger'::regtype
   AND has_function_privilege('anon', p.oid, 'EXECUTE');

BEGIN;

DO $grants$
BEGIN
  IF to_regprocedure('public.member_is_active(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.member_is_active(uuid, uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.member_is_active(uuid, uuid) TO service_role;
  END IF;
END
$grants$;

COMMIT;

-- ── verification + inventory — ONE result set ───────────────────────────────
-- Probes carry ok (expect true; NULL only for a function this database does
-- not have), n NULL; inventory rows carry n, ok NULL.
SELECT 'member_is_active: only service_role may execute it (PUBLIC, anon, authenticated revoked)'::text AS "check",
       (SELECT NOT has_function_privilege('anon', f, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', f, 'EXECUTE')
               AND has_function_privilege('service_role', f, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM (SELECT to_regprocedure('public.member_is_active(uuid,uuid)') AS f) x WHERE f IS NOT NULL) AS ok,
       NULL::text AS n
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
SELECT check_name, NULL, n::text FROM intel_i17_20261217_inventory;
