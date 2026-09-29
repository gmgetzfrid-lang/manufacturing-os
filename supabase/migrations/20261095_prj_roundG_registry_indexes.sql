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
-- NOT widening: no policy, grant or function changes. Plain CREATE INDEX
-- (not CONCURRENTLY) so the whole file runs as one transaction in the SQL
-- editor; the tables are small today (PERF-11: latent, not acute).
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run
-- it once. The final SELECT is the only result set shown — every row must
-- read ok = true.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── 1. party_id joins (PERF-11 / PERF-1) ────────────────────────────────
CREATE INDEX IF NOT EXISTS change_orders_party_idx  ON change_orders  (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS turnover_items_party_idx ON turnover_items (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS punch_items_party_idx    ON punch_items    (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cost_documents_party_idx ON cost_documents (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cost_entries_party_idx   ON cost_entries   (party_id) WHERE party_id IS NOT NULL;

-- ── 2. trigram search columns (PERF-11) ─────────────────────────────────
CREATE INDEX IF NOT EXISTS milestones_responsible_party_trgm_idx
  ON milestones USING GIN (responsible_party gin_trgm_ops);
CREATE INDEX IF NOT EXISTS project_intake_links_company_name_trgm_idx
  ON project_intake_links USING GIN (company_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_title_trgm_idx
  ON documents USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_name_trgm_idx
  ON documents USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_document_number_trgm_idx
  ON documents USING GIN (document_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS companies_name_trgm_idx
  ON companies USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS companies_trade_trgm_idx
  ON companies USING GIN (trade gin_trgm_ops);

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
UNION ALL SELECT 'milestones.responsible_party trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'milestones_responsible_party_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'project_intake_links.company_name trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'project_intake_links_company_name_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'documents.title trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_title_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'documents.name trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_name_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'documents.document_number trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'documents_document_number_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'companies.name trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'companies_name_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'companies.trade trigram index exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'companies_trade_trgm_idx' AND indexdef ILIKE '%gin_trgm_ops%'), NULL
UNION ALL SELECT 'companies.status CHECK constraint exists',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.companies'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'), NULL;
