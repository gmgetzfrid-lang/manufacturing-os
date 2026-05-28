-- ════════════════════════════════════════════════════════════════════
-- DIAGNOSE_state.sql — read-only state check
-- ════════════════════════════════════════════════════════════════════
--
-- Paste into Supabase SQL Editor. Returns one row per object the
-- 2026-05-28 migration set was supposed to create. `present = true`
-- means the object made it into the DB; `false` means whatever
-- migration introduces it didn't finish.
--
-- Pure SELECT. Touches no data. Safe to run any time.

SELECT 'plants table'                              AS check_name, EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='plants') AS present
UNION ALL SELECT 'units table',                                   EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='units')
UNION ALL SELECT 'systems table',                                 EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='systems')
UNION ALL SELECT 'document_assets table',                         EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='document_assets')
UNION ALL SELECT 'project_documents table',                       EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='project_documents')
UNION ALL SELECT 'document_holds table',                          EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='document_holds')

UNION ALL SELECT 'documents.plant_id',                            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='plant_id')
UNION ALL SELECT 'documents.unit_id',                             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='unit_id')
UNION ALL SELECT 'documents.system_id',                           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='system_id')
UNION ALL SELECT 'documents.search_tsv',                          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='search_tsv')

UNION ALL SELECT 'assets.plant_id',                               EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='assets' AND column_name='plant_id')
UNION ALL SELECT 'assets.search_tsv',                             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='assets' AND column_name='search_tsv')

UNION ALL SELECT 'document_versions.search_tsv',                  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='document_versions' AND column_name='search_tsv')
UNION ALL SELECT 'tickets.search_tsv',                            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tickets' AND column_name='search_tsv')

UNION ALL SELECT 'idx audit_logs_resource_timeline_idx',          EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='audit_logs_resource_timeline_idx')
UNION ALL SELECT 'idx documents_search_tsv_idx',                  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='documents_search_tsv_idx')
UNION ALL SELECT 'idx assets_search_tsv_idx',                     EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='assets_search_tsv_idx')
UNION ALL SELECT 'idx document_versions_search_tsv_idx',          EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='document_versions_search_tsv_idx')
UNION ALL SELECT 'idx tickets_search_tsv_idx',                    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='tickets_search_tsv_idx')
UNION ALL SELECT 'idx document_holds_active_doc_idx',             EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='document_holds_active_doc_idx')

UNION ALL SELECT 'fn normalize_tag',                              EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='normalize_tag')
UNION ALL SELECT 'fn documents_search_tsv_refresh',               EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='documents_search_tsv_refresh')
UNION ALL SELECT 'fn assets_search_tsv_refresh',                  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='assets_search_tsv_refresh')
UNION ALL SELECT 'fn documents_resync_assets',                    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='documents_resync_assets')
UNION ALL SELECT 'fn checkouts_resync_project_documents',         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='checkouts_resync_project_documents')
UNION ALL SELECT 'fn document_versions_search_tsv_refresh',       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='document_versions_search_tsv_refresh')
UNION ALL SELECT 'fn tickets_search_tsv_refresh',                 EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='tickets_search_tsv_refresh')

ORDER BY check_name;

-- Bonus: shows the current body of the documents_search_tsv_refresh
-- function so you can confirm the bugfix landed. Look for
-- `string_agg(value` (correct) vs `string_agg(val` (broken).
SELECT pg_get_functiondef(p.oid) AS documents_search_tsv_refresh_body
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname = 'documents_search_tsv_refresh';
