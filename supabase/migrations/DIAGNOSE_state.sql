-- ════════════════════════════════════════════════════════════════════
-- DIAGNOSE_state.sql — read-only health check
-- ════════════════════════════════════════════════════════════════════
--
-- Paste into Supabase SQL Editor. Runs as multiple SELECTs — each
-- returns a labeled result block. Touches no data.
--
-- Designed to surface the most common drift problems:
--   1. Tables with RLS enabled but no policies (silent denial)
--   2. Missing 2026-05-28 catch-up objects
--   3. Asset / document drift (deleted assets vs JSONB tag strings
--      still referenced on documents)
--   4. Trigger-maintained tables (document_assets, project_documents)
--      out of sync with their source

-- ─── (1) Object presence — did the catch-up succeed? ──────────
SELECT '== (1) Object presence ==' AS section;

SELECT 'plants table'                              AS check_name, EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='plants') AS present
UNION ALL SELECT 'units table',                                   EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='units')
UNION ALL SELECT 'systems table',                                 EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='systems')
UNION ALL SELECT 'document_assets table',                         EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='document_assets')
UNION ALL SELECT 'project_documents table',                       EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='project_documents')
UNION ALL SELECT 'document_holds table',                          EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='document_holds')
UNION ALL SELECT 'milestones table',                              EXISTS (SELECT 1 FROM information_schema.tables  WHERE table_schema='public' AND table_name='milestones')

UNION ALL SELECT 'documents.search_tsv',                          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='search_tsv')
UNION ALL SELECT 'documents.plant_id',                            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='documents' AND column_name='plant_id')
UNION ALL SELECT 'assets.search_tsv',                             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='assets' AND column_name='search_tsv')
UNION ALL SELECT 'document_versions.search_tsv',                  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='document_versions' AND column_name='search_tsv')
UNION ALL SELECT 'tickets.search_tsv',                            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tickets' AND column_name='search_tsv')

UNION ALL SELECT 'fn normalize_tag',                              EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='normalize_tag')
UNION ALL SELECT 'fn documents_search_tsv_refresh',               EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='documents_search_tsv_refresh')

ORDER BY check_name;

-- ─── (2) RLS audit — find tables with the silent-denial bug ───
-- A table with rowsecurity=true and ZERO policies rejects every
-- INSERT/SELECT/UPDATE/DELETE from authenticated users.
SELECT '== (2) RLS coverage (tables with RLS but no policies are broken) ==' AS section;

SELECT
  c.relname                                                AS table_name,
  c.relrowsecurity                                         AS rls_enabled,
  c.relforcerowsecurity                                    AS rls_forced,
  COUNT(p.polname)                                         AS policy_count,
  CASE
    WHEN c.relrowsecurity AND COUNT(p.polname) = 0 THEN '⚠ BROKEN: RLS on, no policies'
    WHEN c.relrowsecurity = false THEN '— RLS off (default-allow)'
    ELSE 'ok'
  END                                                      AS status
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
ORDER BY
  CASE WHEN c.relrowsecurity AND COUNT(p.polname) = 0 THEN 0 ELSE 1 END,
  c.relname;

-- ─── (3) Asset registry / JSONB drift ─────────────────────────
-- These three counts help diagnose "I deleted assets but they still
-- show up":
--
--   a. assets row count (canonical registry)
--   b. distinct tag strings present in documents.asset_tags JSONB
--      that have NO matching asset row (orphan JSONB tags)
--   c. document_assets join rows whose asset_id no longer exists
--      (should be zero — FK is ON DELETE CASCADE, so if non-zero
--      something is wrong)
SELECT '== (3) Asset drift ==' AS section;

SELECT
  (SELECT COUNT(*) FROM assets)                                                  AS assets_total,
  (SELECT COUNT(*) FROM assets WHERE archived = TRUE)                            AS assets_archived,
  (SELECT COUNT(*) FROM assets WHERE archived = FALSE)                           AS assets_active;

-- Orphan JSONB tag strings — tags present in documents.asset_tags
-- that no longer have a matching assets row.
SELECT 'orphan_jsonb_tag' AS kind, tag_text, doc_count
FROM (
  SELECT DISTINCT elem->>'tag' AS tag_text,
                  COUNT(DISTINCT d.id) AS doc_count
  FROM documents d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.asset_tags, '[]'::jsonb)) AS elem
  WHERE elem ? 'tag'
    AND lower(regexp_replace(elem->>'tag', '[^a-zA-Z0-9]+', '', 'g')) NOT IN (
      SELECT a.tag_normalized FROM assets a WHERE a.org_id = d.org_id
    )
  GROUP BY elem->>'tag'
  ORDER BY doc_count DESC
  LIMIT 20
) t;

-- ─── (4) Trigger sync — document_assets vs documents.asset_tags ─
SELECT '== (4) Trigger-maintained join health ==' AS section;

SELECT
  (SELECT COUNT(*) FROM document_assets)                                          AS document_assets_total,
  (SELECT COUNT(*) FROM project_documents)                                        AS project_documents_total,
  (SELECT COUNT(DISTINCT d.id) FROM documents d
     WHERE jsonb_typeof(d.asset_tags) = 'array'
       AND jsonb_array_length(d.asset_tags) > 0)                                  AS documents_with_jsonb_tags,
  (SELECT COUNT(DISTINCT da.document_id) FROM document_assets da)                 AS documents_with_join_rows;

-- ─── (5) Recent rows in each new table ────────────────────────
-- Quick sanity check on data volume.
SELECT '== (5) Row counts ==' AS section;

SELECT 'projects' AS tbl, COUNT(*) AS rows FROM projects
UNION ALL SELECT 'project_members',   COUNT(*) FROM project_members
UNION ALL SELECT 'project_activity',  COUNT(*) FROM project_activity
UNION ALL SELECT 'project_documents', COUNT(*) FROM project_documents
UNION ALL SELECT 'markup_requests',   COUNT(*) FROM markup_requests
UNION ALL SELECT 'document_holds',    COUNT(*) FROM document_holds
UNION ALL SELECT 'document_assets',   COUNT(*) FROM document_assets
UNION ALL SELECT 'document_supersessions', COUNT(*) FROM document_supersessions
UNION ALL SELECT 'milestones',        COUNT(*) FROM milestones
UNION ALL SELECT 'plants',            COUNT(*) FROM plants
UNION ALL SELECT 'units',             COUNT(*) FROM units
UNION ALL SELECT 'systems',           COUNT(*) FROM systems
UNION ALL SELECT 'assets',            COUNT(*) FROM assets
ORDER BY tbl;
