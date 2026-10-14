-- ─────────────────────────────────────────────────────────────────────────────
-- 20261217 — intelligence Round G, I-17 DATABASE HARNESS: the SECURITY
-- DEFINER grant census's four narrowings (projects-and-cost INTK-14
-- done-when 2; the DRLS-16 rule).
--
--   The census (lib/__tests__/rls/definerCensus.test.ts) reads the EXECUTE
--   grants of every SECURITY DEFINER function on a fresh replay of the whole
--   sequence and holds each to a reasoned decision
--   (lib/__tests__/rls/definerDecisions.ts). Supabase's default privileges
--   grant EXECUTE on every function `postgres` creates in public to anon,
--   authenticated and service_role, on top of PostgreSQL's PUBLIC grant, so a
--   `REVOKE … FROM PUBLIC` alone still leaves the anon key able to call it.
--   Four functions get a REVOKE here; every other decision is recorded, not
--   changed (a policy helper must stay executable by the roles its policies
--   judge — revoking it would turn an empty answer into an error).
--
--     · member_is_active(uuid, uuid) — 20261042. "Is this uid an active
--       member of this org?" for ANY uid, callable over PostgREST with the
--       public anon key. Nothing calls it but user_is_effective_owner, a
--       SECURITY DEFINER function owned by postgres, which keeps calling it
--       as its owner. No app .rpc( call, no policy, no SECURITY INVOKER
--       function names it. → EXECUTE for service_role only.
--     · next_ticket_number(uuid, integer) — schema.sql / 20260724 granted
--       authenticated; PUBLIC and anon kept theirs. Called by a signed-in
--       member (lib/ticketNumber.ts, app/api/tickets/create/route.ts with the
--       caller's JWT); refuses a caller with no active membership.
--     · issue_document_number(uuid) — 20260806, no grant at all. Called by a
--       signed-in member (lib/libraryNumbering.ts); returns NULL without one.
--     · force_release_document(uuid, text) — 20261043 revoked PUBLIC and
--       granted authenticated; anon kept Supabase's default grant. Called by
--       a signed-in member (lib/checkoutEpisodes.ts); raises without one.
--       → for these three: PUBLIC and anon revoked; authenticated and
--         service_role granted by name.
--
-- NARROWS (nobody signed in loses anything). A signed-out caller (the anon
-- key with no session) is the only one refused, and each function already
-- refused it inside its body (or, for member_is_active, has no app caller).
-- No function, policy or trigger is created or re-created; no row is read.
-- Pre-apply inventory (DEC-30): aggregate COUNTs of the grant state only,
-- captured into a TEMP TABLE before the transaction. Never a customer row.
--
-- BEFORE THE PASTE the app works as today. AFTER IT: every signed-in call
-- above answers exactly as before (the harness runs each as a member, before
-- and after this file, on a replay of the whole sequence); an anon-key call
-- gets 42501 instead of the function's own refusal. A function this database
-- does not have is skipped (each REVOKE is guarded by to_regprocedure).
-- ORDER: independent of every other pending file; either order with any
-- deploy (no app change depends on it). ⚠ APPLIED BY HAND (DEC-30). One
-- script; re-running is safe.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION member_is_active(uuid, uuid) TO anon,
--   authenticated; GRANT EXECUTE ON FUNCTION next_ticket_number(uuid, integer),
--   issue_document_number(uuid), force_release_document(uuid, text) TO anon;
--   (and TO PUBLIC for next_ticket_number / issue_document_number).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS intel_i17_20261217_inventory (check_name text, n bigint);
TRUNCATE intel_i17_20261217_inventory;
INSERT INTO intel_i17_20261217_inventory
SELECT 'before: of the four functions, how many this database has', COUNT(*)
  FROM (VALUES ('public.member_is_active(uuid,uuid)'), ('public.next_ticket_number(uuid,integer)'),
               ('public.issue_document_number(uuid)'), ('public.force_release_document(uuid,text)')) v(sig)
 WHERE to_regprocedure(v.sig) IS NOT NULL
UNION ALL
SELECT 'before: of those, how many the anon role may execute', COUNT(*)
  FROM (VALUES ('public.member_is_active(uuid,uuid)'), ('public.next_ticket_number(uuid,integer)'),
               ('public.issue_document_number(uuid)'), ('public.force_release_document(uuid,text)')) v(sig)
 WHERE to_regprocedure(v.sig) IS NOT NULL AND has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
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
  IF to_regprocedure('public.next_ticket_number(uuid,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.next_ticket_number(uuid, integer) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.next_ticket_number(uuid, integer) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.issue_document_number(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.issue_document_number(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.issue_document_number(uuid) TO authenticated, service_role;
  END IF;
  IF to_regprocedure('public.force_release_document(uuid,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.force_release_document(uuid, text) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.force_release_document(uuid, text) TO authenticated, service_role;
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
SELECT 'next_ticket_number: authenticated and service_role may execute it; PUBLIC and anon may not',
       (SELECT has_function_privilege('authenticated', f, 'EXECUTE') AND has_function_privilege('service_role', f, 'EXECUTE')
               AND NOT has_function_privilege('anon', f, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM (SELECT to_regprocedure('public.next_ticket_number(uuid,integer)') AS f) x WHERE f IS NOT NULL),
       NULL
UNION ALL
SELECT 'issue_document_number: authenticated and service_role may execute it; PUBLIC and anon may not',
       (SELECT has_function_privilege('authenticated', f, 'EXECUTE') AND has_function_privilege('service_role', f, 'EXECUTE')
               AND NOT has_function_privilege('anon', f, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM (SELECT to_regprocedure('public.issue_document_number(uuid)') AS f) x WHERE f IS NOT NULL),
       NULL
UNION ALL
SELECT 'force_release_document: authenticated and service_role may execute it; PUBLIC and anon may not',
       (SELECT has_function_privilege('authenticated', f, 'EXECUTE') AND has_function_privilege('service_role', f, 'EXECUTE')
               AND NOT has_function_privilege('anon', f, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM (SELECT to_regprocedure('public.force_release_document(uuid,text)') AS f) x WHERE f IS NOT NULL),
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
SELECT check_name, NULL, n::text FROM intel_i17_20261217_inventory;
