-- 20261172_ao_roundG_export_run_retention.sql
--
-- admin-and-org Round G, package P3 (fix pass 7) — BKP-6 Done-when 3:
-- "retention failures and deletion counts are surfaced on the run row
-- instead of only in diagnostics". A bucket push's retention purge reports
-- what it deleted and what it could not delete; this gives the run row
-- (export_runs) a column for each.
--
-- WHY: the purge's outcome (lib/exportRunner.ts s3PurgeOlderThan →
-- ExportRunResult.retention: { keepDays, scanned, deleted, failed, error? })
-- reached the run row only as a sentence when it did not finish
-- (retentionProblem → error_message) and as a step in the run's trace
-- (diagnostics: "s3:retention:done" / "s3:retention:err", "scanned N,
-- deleted M app archive(s), K could not be deleted"). A clean purge's count
-- lived only in the trace. export_runs (20260530_data_export_schedules.sql,
-- the only definition; 20260605 and 20261154 change its policy and
-- privileges, no migration adds a column) had nowhere else to hold it.
--
-- WHAT:
--   export_runs.retention_deleted INTEGER — the archives the run's purge
--     deleted (counted from each DeleteObjects answer, never the candidates).
--   export_runs.retention_failed INTEGER — the archives it chose but storage
--     did not delete (a key storage refused, or the rest of a purge a delete
--     call stopped).
--   Both nullable, no default. NULL: no purge ran on this run (a webhook, a
--   bucket with no retention, a download, a failed run), or the run was
--   closed before this paste. Every existing row keeps NULL: its counts stay
--   in its trace, where the data-export page reads them; nothing is
--   backfilled. Why a purge stopped stays in error_message, as before.
--   Written by app/api/data-export/run and run-scheduled when a succeeded
--   run closes (lib/exportRunner.ts closeSucceededRun); shown on the
--   data-export page's run list (app/(protected)/admin/data-export/page.tsx
--   retentionOf).
--   Nothing else changes: no function, policy, trigger, grant or index is
--   created, dropped or re-created. RLS stays on; export_runs_member_select
--   (20260605:147-150) is untouched. No grant is made on the new columns:
--   nothing reads export_runs with a member's session (every reader is a
--   service-role route under app/api/data-export —
--   lib/__tests__/aoRoundGExportDestinationsMigration.test.ts pins it). So a
--   member reads these two exactly as far as the table-level privilege goes:
--   before 20261154 is pasted, authenticated holds table-level SELECT and
--   reads them (two counts, no coordinate); after it, authenticated reads
--   only 20261154's card columns, not these. The service role's table
--   privileges cover the new columns.
--
-- WIDENING? No. Two nullable integer columns; no privilege changes. The
-- before-apply inventory says whether this paste is a first apply or a
-- re-run and counts the rows the columns land on and the runs whose trace
-- records a purge (aggregate counts only); it is dropped and re-captured on
-- every paste.
--
-- NEEDS 20260530 (export_runs). Pasted without it, this file stops at the
-- first statement and says so; nothing is changed.
--
-- WHEN TO PASTE: either order is safe, and either order with 20261154.
-- The app with this fix deploys first: before the paste, its run-row update
-- names the two columns, PostgREST answers PGRST204 (or Postgres 42703),
-- and the same update is written again without them — the run closes
-- exactly as it did before, its counts in its trace, and the page shows
-- them from there. A run with no purge never names the columns. The code
-- before this fix never names them, so pasting first changes nothing.
--
-- ROLLBACK:
--   ALTER TABLE export_runs DROP COLUMN IF EXISTS retention_deleted,
--                           DROP COLUMN IF EXISTS retention_failed;
-- The app keeps working (its write retries without the columns); the page
-- falls back to each run's trace.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count). Until it is pasted, behaviour is unchanged.

DO $$
BEGIN
  IF to_regclass('public.export_runs') IS NULL THEN
    RAISE EXCEPTION '20261172 needs 20260530 (export_runs) — paste 20260530_data_export_schedules.sql first. Nothing was changed.';
  END IF;
END $$;

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ao_g72_before;
CREATE TEMP TABLE _ao_g72_before AS
SELECT 'columns' AS k,
       'inventory: export_runs retention columns already present before this paste (0 = a first apply, 2 = a re-run)' AS inventory,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'export_runs'
           AND column_name IN ('retention_deleted', 'retention_failed'))::text AS n
UNION ALL
SELECT 'rows',
       'inventory: export_runs rows before this paste (on a first apply each keeps both columns NULL — closed before they existed)',
       (SELECT COUNT(*) FROM export_runs)::text
UNION ALL
SELECT 'purge_done',
       'inventory: of them, runs whose trace records a finished purge (an s3:retention:done step) — the count stays in diagnostics, where the page reads it, not backfilled',
       (SELECT COUNT(*) FROM export_runs
         WHERE diagnostics @> '[{"step": "s3:retention:done"}]'::jsonb)::text
UNION ALL
SELECT 'purge_err',
       'inventory: of them, runs whose trace records a purge that did not finish (an s3:retention:err step, its error_message says why)',
       (SELECT COUNT(*) FROM export_runs
         WHERE diagnostics @> '[{"step": "s3:retention:err"}]'::jsonb)::text
UNION ALL
SELECT 'auth_select',
       'inventory: authenticated held table-level SELECT on export_runs before this paste (1 = 20261154 not yet pasted, 0 = it is)',
       (CASE WHEN has_table_privilege('authenticated', 'public.export_runs', 'SELECT') THEN 1 ELSE 0 END)::text
UNION ALL
SELECT 'anon_select',
       'inventory: anon held table-level SELECT on export_runs before this paste (1 = 20261154 not yet pasted, 0 = it is)',
       (CASE WHEN has_table_privilege('anon', 'public.export_runs', 'SELECT') THEN 1 ELSE 0 END)::text;

BEGIN;

-- ── the counts ───────────────────────────────────────────────────────────
ALTER TABLE export_runs
  ADD COLUMN IF NOT EXISTS retention_deleted INTEGER,
  ADD COLUMN IF NOT EXISTS retention_failed INTEGER;

COMMENT ON COLUMN export_runs.retention_deleted IS
  'BKP-6: the archives this run''s retention purge deleted (counted from storage''s answers). NULL: no purge ran on this run, or it was closed before 20261172 (its count is in diagnostics). Written by app/api/data-export/run and run-scheduled (lib/exportRunner.ts closeSucceededRun).';
COMMENT ON COLUMN export_runs.retention_failed IS
  'BKP-6: the archives this run''s retention purge chose but storage did not delete. NULL: no purge ran on this run, or it was closed before 20261172. Why a purge stopped is in error_message.';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'export_runs.retention_deleted exists: integer, nullable, no default, commented' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'export_runs' AND column_name = 'retention_deleted'
                  AND data_type = 'integer' AND is_nullable = 'YES' AND column_default IS NULL)
       AND COALESCE(col_description(to_regclass('public.export_runs'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = to_regclass('public.export_runs') AND attname = 'retention_deleted' AND NOT attisdropped)) LIKE 'BKP-6:%', false) AS ok,
       NULL::text AS n
UNION ALL SELECT 'export_runs.retention_failed exists: integer, nullable, no default, commented',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'export_runs' AND column_name = 'retention_failed'
                  AND data_type = 'integer' AND is_nullable = 'YES' AND column_default IS NULL)
       AND COALESCE(col_description(to_regclass('public.export_runs'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = to_regclass('public.export_runs') AND attname = 'retention_failed' AND NOT attisdropped)) LIKE 'BKP-6:%', false),
       NULL
UNION ALL SELECT 'export_runs: RLS still on',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.export_runs')), false), NULL
UNION ALL SELECT 'export_runs_member_select is kept (this file creates, drops or alters no policy)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'export_runs' AND policyname = 'export_runs_member_select'
                  AND cmd = 'SELECT' AND 'authenticated' = ANY (roles)), NULL
UNION ALL SELECT 'no grant changed: authenticated and anon hold table-level SELECT on export_runs exactly as before this paste',
       (CASE WHEN has_table_privilege('authenticated', 'public.export_runs', 'SELECT') THEN '1' ELSE '0' END)
         = (SELECT n FROM _ao_g72_before WHERE k = 'auth_select')
       AND (CASE WHEN has_table_privilege('anon', 'public.export_runs', 'SELECT') THEN '1' ELSE '0' END)
         = (SELECT n FROM _ao_g72_before WHERE k = 'anon_select'), NULL
UNION ALL SELECT 'no column grant: authenticated reads the new columns exactly as far as its table-level SELECT goes (before 20261154 yes, after it no)',
       has_column_privilege('authenticated', 'public.export_runs', 'retention_deleted', 'SELECT')
         = has_table_privilege('authenticated', 'public.export_runs', 'SELECT')
       AND has_column_privilege('authenticated', 'public.export_runs', 'retention_failed', 'SELECT')
         = has_table_privilege('authenticated', 'public.export_runs', 'SELECT'), NULL
UNION ALL SELECT 'the service role may read and write both columns',
       has_column_privilege('service_role', 'public.export_runs', 'retention_deleted', 'SELECT')
       AND has_column_privilege('service_role', 'public.export_runs', 'retention_deleted', 'UPDATE')
       AND has_column_privilege('service_role', 'public.export_runs', 'retention_failed', 'SELECT')
       AND has_column_privilege('service_role', 'public.export_runs', 'retention_failed', 'UPDATE'), NULL
UNION ALL SELECT 'after: export_runs rows carrying retention counts (closed by the app since this paste, 0 on a first apply)', NULL,
       (SELECT COUNT(*) FROM export_runs WHERE retention_deleted IS NOT NULL)::text
UNION ALL SELECT 'after: of them, runs whose purge could not delete everything it chose (retention_failed > 0)', NULL,
       (SELECT COUNT(*) FROM export_runs WHERE retention_failed > 0)::text
UNION ALL SELECT 'after: runs whose trace records a purge but whose columns are NULL (closed before this paste, or written without the columns) — the page reads their trace', NULL,
       (SELECT COUNT(*) FROM export_runs
         WHERE retention_deleted IS NULL
           AND (diagnostics @> '[{"step": "s3:retention:done"}]'::jsonb OR diagnostics @> '[{"step": "s3:retention:err"}]'::jsonb))::text
UNION ALL SELECT inventory, NULL, n FROM _ao_g72_before;
