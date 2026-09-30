-- 20261095_prj_roundG_registry_indexes.sql
--
-- projects Round G — J4 BID-TAB-AND-REGISTRY (projects-tab PERF-11, with
-- the REL-4 / REL-9 registry-status half).
--
-- WHAT: the join and search columns the Known Companies gather and the
-- document type-ahead filter on, none of which had an index:
--   * btree on party_id for change_orders, turnover_items, punch_items,
--     cost_documents and cost_entries (the batched gather in
--     lib/companies.ts reads all five by party_id);
--   * pg_trgm GIN on the ILIKE / leading-wildcard columns:
--     milestones.responsible_party, project_intake_links.company_name,
--     documents.title / name / document_number, and companies.name /
--     companies.trade (the registry's server-side search, 20261095 pairs
--     with lib/companies.listCompaniesPage);
--   * companies.status CHECK — present inline since 20261013; this guards
--     a database where the table predates that file (REL-4 / REL-9).
--
-- NOT widening: no policy, grant or function changes.
--
-- LOCKING (DEC-30 inventory before apply): a plain CREATE INDEX holds a
-- SHARE lock — writes to the table wait for the whole build. The small
-- registry tables build inside the one transaction. `documents` (the core
-- document table: uploads, check-ins and publishes write it) and
-- `milestones` (one row per imported schedule activity) are COUNTED
-- first, before the transaction, and their trigram indexes are built here
-- only at or below 50,000 rows — a GIN build of that size holds the lock
-- for seconds. Above it the build is skipped, the probe below reads false
-- and names the fix: the CREATE INDEX CONCURRENTLY statements at the foot
-- of this file, pasted ONE STATEMENT PER RUN (CONCURRENTLY cannot run
-- inside a transaction or beside other statements), which never block
-- writes.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run
-- it once (a second run in the same session is safe — the temp table is
-- dropped first). The final SELECT is the only result set shown — probe
-- rows must read ok = true (a documents / milestones trigram probe that
-- reads false means its table was above the threshold: run the foot
-- block, then its stand-alone probe SELECT); inventory rows carry ok NULL
-- and a row count in n.

-- ── DEC-30 inventory, captured BEFORE the transaction (counts only) ─────
DROP TABLE IF EXISTS pg_temp.prj_g_index_inventory;
CREATE TEMP TABLE prj_g_index_inventory AS
SELECT 'inventory: documents rows (trigram indexes built in this transaction only at or below 50000)' AS inventory,
       COUNT(*)::text AS n
  FROM documents
UNION ALL
SELECT 'inventory: milestones rows (trigram index built in this transaction only at or below 50000)', COUNT(*)::text
  FROM milestones;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 1. party_id joins (PERF-11 / PERF-1) ────────────────────────────────
CREATE INDEX IF NOT EXISTS change_orders_party_idx  ON change_orders  (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS turnover_items_party_idx ON turnover_items (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS punch_items_party_idx    ON punch_items    (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cost_documents_party_idx ON cost_documents (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cost_entries_party_idx   ON cost_entries   (party_id) WHERE party_id IS NOT NULL;

-- ── 2. trigram search columns (PERF-11) ─────────────────────────────────
CREATE INDEX IF NOT EXISTS project_intake_links_company_name_trgm_idx
  ON project_intake_links USING GIN (company_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS companies_name_trgm_idx
  ON companies USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS companies_trade_trgm_idx
  ON companies USING GIN (trade gin_trgm_ops);

-- The two write-heavy tables: built here only when small (see LOCKING).
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM milestones) <= 50000 THEN
    CREATE INDEX IF NOT EXISTS milestones_responsible_party_trgm_idx
      ON milestones USING GIN (responsible_party gin_trgm_ops);
  ELSE
    RAISE NOTICE 'milestones is above 50000 rows: build milestones_responsible_party_trgm_idx CONCURRENTLY (foot of this file)';
  END IF;
  IF (SELECT COUNT(*) FROM documents) <= 50000 THEN
    CREATE INDEX IF NOT EXISTS documents_title_trgm_idx
      ON documents USING GIN (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS documents_name_trgm_idx
      ON documents USING GIN (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS documents_document_number_trgm_idx
      ON documents USING GIN (document_number gin_trgm_ops);
  ELSE
    RAISE NOTICE 'documents is above 50000 rows: build its three trigram indexes CONCURRENTLY (foot of this file)';
  END IF;
END $$;

-- ── 3. companies.status CHECK (REL-4 / REL-9 registry half) ────────────
-- 20261013 declares it inline; a table created earlier by hand may lack
-- it. Add the named constraint only when no CHECK on status exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.companies'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  ) THEN
    ALTER TABLE companies ADD CONSTRAINT companies_status_check
      CHECK (status IN ('active','inactive','do_not_use'));
  END IF;
END $$;

COMMIT;

-- ── Verification (the only result set the SQL editor shows) ─────────────
SELECT 'pg_trgm extension installed' AS check,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ok, NULL::text AS n
UNION ALL SELECT 'change_orders_party_idx exists',  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'change_orders_party_idx'), NULL
UNION ALL SELECT 'turnover_items_party_idx exists', EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'turnover_items_party_idx'), NULL
UNION ALL SELECT 'punch_items_party_idx exists',    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'punch_items_party_idx'), NULL
UNION ALL SELECT 'cost_documents_party_idx exists', EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'cost_documents_party_idx'), NULL
UNION ALL SELECT 'cost_entries_party_idx exists',   EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'cost_entries_party_idx'), NULL
UNION ALL SELECT 'milestones.responsible_party trigram index exists (false = above 50000 rows: run the foot block)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'milestones_responsible_party_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'project_intake_links.company_name trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'project_intake_links_company_name_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'documents.title trigram index exists (false = above 50000 rows: run the foot block)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_title_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'documents.name trigram index exists (false = above 50000 rows: run the foot block)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_name_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'documents.document_number trigram index exists (false = above 50000 rows: run the foot block)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_document_number_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'companies.name trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'companies_name_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'companies.trade trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'companies_trade_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'companies.status CHECK constraint exists',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.companies'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'), NULL
UNION ALL SELECT inventory, NULL::boolean, n FROM prj_g_index_inventory;

-- ── Large-table builds — ONLY when a trigram probe above read false ─────
-- Paste and run ONE statement at a time (CREATE INDEX CONCURRENTLY cannot
-- share a run with anything else); each builds without blocking writes.
-- Then paste the stand-alone probe SELECT below it (it reads no temp
-- table, so it runs in a fresh session); every row must read ok = true.
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS milestones_responsible_party_trgm_idx ON milestones USING GIN (responsible_party gin_trgm_ops);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_title_trgm_idx ON documents USING GIN (title gin_trgm_ops);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_name_trgm_idx ON documents USING GIN (name gin_trgm_ops);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_document_number_trgm_idx ON documents USING GIN (document_number gin_trgm_ops);
--
-- Stand-alone probe (after the CONCURRENTLY builds):
--
-- SELECT 'milestones.responsible_party trigram index exists' AS check,
--        EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'milestones_responsible_party_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%') AS ok, NULL::text AS n
-- UNION ALL SELECT 'documents.title trigram index exists',
--        EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_title_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
-- UNION ALL SELECT 'documents.name trigram index exists',
--        EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_name_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
-- UNION ALL SELECT 'documents.document_number trigram index exists',
--        EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_document_number_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
-- UNION ALL SELECT 'no invalid (half-built) index left by an interrupted CONCURRENTLY build',
--        NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--                     WHERE NOT i.indisvalid AND c.relname IN ('milestones_responsible_party_trgm_idx', 'documents_title_trgm_idx',
--                                                             'documents_name_trgm_idx', 'documents_document_number_trgm_idx')), NULL;
