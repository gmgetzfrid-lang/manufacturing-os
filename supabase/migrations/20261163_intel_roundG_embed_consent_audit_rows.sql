-- 20261163_intel_roundG_embed_consent_audit_rows.sql
--
-- intelligence Round G — package I-20 (AI UI REMAINDERS), GOV-14 done-when 3
-- (I-20 fix pass 3).
--
-- WHY:
--   /api/knowledge/embed records each background consent it stamps with one
--   EMBED_BUILD_CONSENT_RECORDED row in audit_logs (service role), naming the
--   request that stamped it. It also READS those rows: a pass that renews the
--   caller's own consent writes nothing new once a row names that payer on
--   that library (consentRows), and a put-back raced by another pass treats
--   the consent as audited when a row carries the live stamp's instant.
--   But audit_logs_insert (20260813_acl_close_gaps_and_audit_scope.sql:85-90,
--   the newest definition) lets any signed-in member insert ANY row with
--   user_id = auth.uid() into their own org — any action, any resource_id,
--   any details. A member could write an EMBED_BUILD_CONSENT_RECORDED row for
--   their own consent (copying the marker's instant, which every member can
--   read in knowledge_libraries.ai_features) naming a request that never
--   happened; the route would then take it for its own record and write
--   none. Only the forger's own consents are affected, but an auditor looking
--   a consent up by library and payer could not tell that row from the
--   route's.
--
-- WHAT (one RESTRICTIVE INSERT policy; nothing else is touched):
--   audit_logs_embed_consent_route_only refuses an INSERT of an
--   EMBED_BUILD_CONSENT_RECORDED row by anon or authenticated. Restrictive
--   policies AND with the permissive ones, so every other row a member may
--   insert today (audit_logs_insert: their own uid, their own org or none) is
--   inserted exactly as before. The service role (the embed route) bypasses
--   RLS and keeps writing the row. No app code inserts this action with a
--   member's session (grep: only app/api/knowledge/embed/route.ts, on the
--   service role). No SELECT, UPDATE or DELETE rule changes; audit_logs stays
--   append-only for members (no UPDATE / DELETE policy exists).
--
-- WIDENING? No — it narrows what anon and authenticated may insert. The
-- before-apply inventory (aggregate counts only, never rows) records how many
-- such rows already exist: the route's and any a member wrote before this
-- paste, which no query can tell apart. A row written before this paste stays
-- (audit rows are never deleted); from this paste on, every new row of this
-- action is the route's.
--
-- NOTE: 20261142's final probe ("one permissive SELECT, one INSERT, one
-- RESTRICTIVE" on audit_logs) reads false if 20261142 is re-pasted after this
-- file — this file adds a second INSERT policy and a second RESTRICTIVE one.
-- That is expected; pasted in order (20261142 first) both probes read true.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS audit_logs_embed_consent_route_only ON audit_logs;
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the final
-- SELECT carries every probe (ok true/false, n NULL) and the inventory counts
-- (ok NULL, n the count). Until it is pasted, behaviour is unchanged.

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._intel_g63_before;
CREATE TEMP TABLE _intel_g63_before AS
SELECT 'inventory: EMBED_BUILD_CONSENT_RECORDED rows already present (the route''s, and any a member wrote before this paste — no query tells them apart)' AS inventory,
       COUNT(*)::text AS n
  FROM audit_logs WHERE action = 'EMBED_BUILD_CONSENT_RECORDED'
UNION ALL
SELECT 'inventory: of those, rows naming no route-generated request id (details.request.requestId missing — not the route''s shape)',
       COUNT(*)::text
  FROM audit_logs WHERE action = 'EMBED_BUILD_CONSENT_RECORDED' AND (details -> 'request' ->> 'requestId') IS NULL
UNION ALL
SELECT 'inventory: INSERT policies on audit_logs before this paste (1 = audit_logs_insert alone; 2 = a re-run)',
       COUNT(*)::text
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs' AND cmd = 'INSERT';

BEGIN;

DROP POLICY IF EXISTS audit_logs_embed_consent_route_only ON audit_logs;
CREATE POLICY audit_logs_embed_consent_route_only ON audit_logs
  AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (action IS DISTINCT FROM 'EMBED_BUILD_CONSENT_RECORDED');

COMMENT ON POLICY audit_logs_embed_consent_route_only ON audit_logs IS
  'GOV-14 (20261163): only /api/knowledge/embed (service role) writes EMBED_BUILD_CONSENT_RECORDED rows. The route reads them to decide whether a background consent is already recorded, so a member-written one would pass for its record. Every other row a member may insert is unaffected (restrictive: ANDs with audit_logs_insert).';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
--    pg_policies.qual / with_check are DEPARSED.
SELECT 'audit_logs: RLS still on' AS check,
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.audit_logs')), false) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'audit_logs_embed_consent_route_only is a RESTRICTIVE INSERT policy for anon and authenticated refusing EMBED_BUILD_CONSENT_RECORDED, with no USING clause',
       COALESCE((SELECT permissive = 'RESTRICTIVE' AND cmd = 'INSERT'
                        AND 'authenticated' = ANY (roles) AND 'anon' = ANY (roles)
                        AND qual IS NULL
                        AND with_check LIKE '%action IS DISTINCT FROM ''EMBED_BUILD_CONSENT_RECORDED''%'
                   FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_embed_consent_route_only'), false),
       NULL::text
UNION ALL
SELECT 'audit_logs_insert is untouched: the permissive INSERT policy still binds the row to the caller''s uid and org',
       COALESCE((SELECT permissive = 'PERMISSIVE' AND cmd = 'INSERT'
                        AND with_check LIKE '%auth.uid()%' AND with_check LIKE '%my_org_ids()%'
                   FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_logs_insert'), false),
       NULL::text
UNION ALL
SELECT 'the SELECT rules are untouched: the member read audit_logs_org_access and the restrictive overlay audit_logs_admin_trail are both still there',
       (SELECT COUNT(*) FILTER (WHERE policyname = 'audit_logs_org_access' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE') = 1
               AND COUNT(*) FILTER (WHERE policyname = 'audit_logs_admin_trail' AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE') = 1
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_logs'),
       NULL::text
UNION ALL
SELECT 'no UPDATE or DELETE policy on audit_logs (rows stay append-only for members)',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND cmd IN ('UPDATE', 'DELETE', 'ALL')),
       NULL::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM _intel_g63_before;
