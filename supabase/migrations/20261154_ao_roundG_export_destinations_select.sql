-- 20261154_ao_roundG_export_destinations_select.sql
--
-- admin-and-org Round G — package P2, BKP-11 Done-when 1. Decision:
-- DEC-44 (A&O P2) — a provisional number; the integrator renumbers.
--
-- WHY:
--   export_dest_member_select (20260605_rls_policies_new_tables.sql:141-144,
--   the only definition in the sequence) lets EVERY active member of an org
--   SELECT every column of export_destinations — the three *_encrypted
--   credential columns included — while the API deliberately strips them
--   ("Sensitive fields are NEVER returned to the client after creation",
--   app/api/data-export/destinations/route.ts). A Viewer reads the bucket
--   keys' and the webhook secret's ciphertext straight from supabase-js.
--   The table is service-role-only by design (20260605's own header: "Client
--   never directly touches them"): every read in the app is the service role
--   behind a role-gated route (app/api/data-export/destinations*, run,
--   run-scheduled, runs). Nothing reads it with a member's session.
--
-- WHAT (the reversible narrowing, the plan's fail-safe default — a
-- column-level privilege, not a dropped policy):
--   1. The member policy is KEPT as it is (not dropped, not re-created).
--   2. The table-level SELECT privilege is revoked from PUBLIC, anon and
--      authenticated, and SELECT is granted back to authenticated on the
--      destination's CARD columns only: what it is called, its kind, whether
--      it is on, its schedule and its last run. NOT granted:
--        - the credentials: access_key_id_encrypted,
--          secret_access_key_encrypted, webhook_secret_encrypted;
--        - the destination's coordinates: endpoint, region, bucket, prefix,
--          webhook_url (a webhook URL can carry its own secret in the path or
--          query; an Admin / Manager / DocCtrl reads them through the
--          role-gated API, which is where they belong).
--      A member's `select('*')` on the table is now refused (42501); a
--      select of the card columns still answers, for their own org only (the
--      policy). The service role is untouched.
--   The export half (BKP-11 Done-when 2: credentials nulled in every export)
--   is document-control XEDGE-10's REDACT_COLUMNS; the restore half (Done-when
--   3: restored destinations land disabled, no next run, no credentials) is
--   admin-and-org P1's landRestoredRow.
--
-- WIDENING? No — it narrows what `authenticated` and `anon` may read. The
-- before-apply inventory (aggregate counts only, never rows) records what the
-- members could read before this paste.
--
-- ROLLBACK (one line, restores the previous privileges exactly):
--   GRANT SELECT ON export_destinations TO anon, authenticated;
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the final
-- SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count). Until it is pasted, behaviour is unchanged.

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ao_g54_before;
CREATE TEMP TABLE _ao_g54_before AS
SELECT 'inventory: export_destinations rows' AS inventory,
       COUNT(*)::text AS n FROM export_destinations
UNION ALL
SELECT 'inventory: rows holding at least one encrypted credential (readable by every active member before this paste)',
       COUNT(*)::text FROM export_destinations
        WHERE access_key_id_encrypted IS NOT NULL OR secret_access_key_encrypted IS NOT NULL OR webhook_secret_encrypted IS NOT NULL
UNION ALL
SELECT 'inventory: active members in an org that holds such a row (who could read the ciphertext before this paste)',
       COUNT(*)::text FROM org_members m
        WHERE m.status = 'active'
          AND EXISTS (SELECT 1 FROM export_destinations d
                       WHERE d.org_id = m.org_id
                         AND (d.access_key_id_encrypted IS NOT NULL OR d.secret_access_key_encrypted IS NOT NULL OR d.webhook_secret_encrypted IS NOT NULL))
UNION ALL
SELECT 'inventory: authenticated held table-level SELECT before this paste (1 = yes; 0 = a re-run)',
       (CASE WHEN has_table_privilege('authenticated', 'public.export_destinations', 'SELECT') THEN 1 ELSE 0 END)::text;

BEGIN;

REVOKE SELECT ON TABLE export_destinations FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, org_id, name, destination_type, enabled,
  schedule_kind, schedule_hour_utc, schedule_day_of_week, schedule_day_of_month, next_run_at,
  include_files, retention_days,
  last_run_at, last_run_status, last_run_error, last_run_bytes,
  created_at, created_by, updated_at, updated_by
) ON TABLE export_destinations TO authenticated;

COMMENT ON TABLE export_destinations IS
  'Scheduled-export destinations. Service role only by design; members may SELECT the card columns of their own org (export_dest_member_select + a column grant, 20261154). Credentials and the destination''s coordinates are never readable by a member (BKP-11).';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'export_destinations: RLS still on' AS check,
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.export_destinations')), false) AS ok,
       NULL::text AS n
UNION ALL SELECT 'export_dest_member_select is kept: a SELECT policy for authenticated bound to the caller''s active membership',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'export_destinations' AND policyname = 'export_dest_member_select'
                  AND cmd = 'SELECT' AND 'authenticated' = ANY (roles)
                  AND qual LIKE '%org_members%' AND qual LIKE '%auth.uid()%' AND qual LIKE '%active%'), NULL
UNION ALL SELECT 'authenticated and anon hold no table-level SELECT',
       NOT has_table_privilege('authenticated', 'public.export_destinations', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.export_destinations', 'SELECT'), NULL
UNION ALL SELECT 'anon can SELECT no column at all',
       NOT has_any_column_privilege('anon', 'public.export_destinations', 'SELECT'), NULL
UNION ALL SELECT 'authenticated can SELECT no credential column (access_key_id / secret_access_key / webhook_secret _encrypted)',
       NOT has_column_privilege('authenticated', 'public.export_destinations', 'access_key_id_encrypted', 'SELECT')
       AND NOT has_column_privilege('authenticated', 'public.export_destinations', 'secret_access_key_encrypted', 'SELECT')
       AND NOT has_column_privilege('authenticated', 'public.export_destinations', 'webhook_secret_encrypted', 'SELECT'), NULL
UNION ALL SELECT 'authenticated can SELECT none of the coordinates (endpoint, region, bucket, prefix, webhook_url)',
       NOT has_column_privilege('authenticated', 'public.export_destinations', 'endpoint', 'SELECT')
       AND NOT has_column_privilege('authenticated', 'public.export_destinations', 'region', 'SELECT')
       AND NOT has_column_privilege('authenticated', 'public.export_destinations', 'bucket', 'SELECT')
       AND NOT has_column_privilege('authenticated', 'public.export_destinations', 'prefix', 'SELECT')
       AND NOT has_column_privilege('authenticated', 'public.export_destinations', 'webhook_url', 'SELECT'), NULL
UNION ALL SELECT 'authenticated can SELECT the card columns (id, org_id, name, type, enabled, schedule, last run)',
       has_column_privilege('authenticated', 'public.export_destinations', 'id', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_destinations', 'org_id', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_destinations', 'name', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_destinations', 'destination_type', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_destinations', 'enabled', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_destinations', 'schedule_kind', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_destinations', 'next_run_at', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_destinations', 'last_run_status', 'SELECT'), NULL
UNION ALL SELECT 'service_role keeps SELECT on the whole table',
       has_table_privilege('service_role', 'public.export_destinations', 'SELECT'), NULL
UNION ALL SELECT inventory, NULL, n FROM _ao_g54_before;
