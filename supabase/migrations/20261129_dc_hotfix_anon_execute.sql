-- 20261129 — document-control DRLS-16 HOTFIX: anon may not execute the
-- SECURITY DEFINER functions that treat a NULL auth.uid() as the service role.
--
-- Why: Supabase's default privileges grant EXECUTE on every new function in
-- `public` to anon, authenticated and service_role explicitly, and
-- `REVOKE … FROM PUBLIC` does not remove an explicit role grant. No migration
-- that defines publish_revision ever revoked anon, and its body lets a caller
-- whose auth.uid() IS NULL — the service role, but also anon — name the
-- acting member (p_actor). With the public anon key (shipped in every page)
-- and a document id, an outsider could publish bytes as any member.
-- post_ticket_comment (20260810) skips its membership check for a NULL uid
-- the same way. Both are called by the app only as a signed-in member or on
-- the service role (app/api/tickets/comment uses supabaseAdmin), so revoking
-- anon removes no legitimate path.
--
-- What: restate GRANT EXECUTE … TO authenticated, service_role, then
-- REVOKE EXECUTE … FROM anon (and PUBLIC) on EVERY overload of publish_revision and
-- post_ticket_comment present in this database (whatever signature is live —
-- 20261049 / 20261105 / 20261130's), then probes, then the live
-- sweep: every SECURITY DEFINER function in `public` anon can still execute
-- (signatures only — schema, never rows), each to be read for a NULL-uid
-- branch (DRLS-16 done-when 2).
--
-- Narrows only; idempotent; safe to run before or after 20261130 (which also
-- revokes anon for its new signature). Independent of every other pending
-- migration — paste it now.

BEGIN;

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('publish_revision', 'post_ticket_comment')
  LOOP
    -- Restate the two legitimate grants first (every defining migration
    -- grants them explicitly; restating keeps them if a database only ever
    -- had them through PUBLIC), then take anon and PUBLIC away.
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;

COMMIT;

-- ── Verification + sweep (the only result set the SQL editor shows) ───────
SELECT 'publish_revision: no overload is executable by anon (expect ok = true)' AS check,
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'publish_revision'
                      AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'post_ticket_comment: no overload is executable by anon (expect ok = true)',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'post_ticket_comment'
                      AND has_function_privilege('anon', p.oid, 'EXECUTE')),
       NULL::text
UNION ALL
SELECT 'publish_revision: a signed-in member can still execute every overload (expect ok = true)',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'publish_revision'
                      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')),
       NULL::text
UNION ALL
SELECT 'post_ticket_comment: the service role can still execute every overload (expect ok = true)',
       NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'post_ticket_comment'
                      AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')),
       NULL::text
UNION ALL
SELECT 'sweep (DRLS-16 done-when 2): SECURITY DEFINER functions anon can still execute — count',
       NULL::boolean,
       (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
           AND has_function_privilege('anon', p.oid, 'EXECUTE'))::text
UNION ALL
SELECT * FROM (
  SELECT 'sweep: anon can execute SECURITY DEFINER ' || p.oid::regprocedure::text AS check,
         NULL::boolean AS ok,
         'read it for an auth.uid() IS NULL branch'::text AS n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
   ORDER BY 1
) sweep_rows;
