-- 20260908_cost_control.sql
--
-- COST CONTROL v1 — the audit found four orphan tables with no UI, no
-- validation, no indexes, and no constraints. The module now exists
-- (project Costs tab: budgets vs committed vs actuals, CPI); this
-- migration gives the reconstructed tables the guardrails a financial
-- record needs. Everything is exception-guarded because the tables were
-- reverse-engineered from production — a live row that predates a rule
-- must not abort the migration (CHECKs go on NOT VALID: they bind new
-- writes immediately, old rows are grandfathered until validated).
--
-- Write access became controller-only in 20260906. Apply after 20260907.

-- ── value-set CHECKs (NOT VALID: enforce going forward) ─────────────────
DO $$ BEGIN
  ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_entry_type_check
    CHECK (entry_type IN ('commitment','actual','adjustment')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_status_check
    CHECK (status IN ('posted','void')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE cost_accounts ADD CONSTRAINT cost_accounts_budget_check
    CHECK (budget >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE cost_accounts ADD CONSTRAINT cost_accounts_status_check
    CHECK (status IN ('active','closed')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE project_parties ADD CONSTRAINT project_parties_status_check
    CHECK (status IN ('active','inactive')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── uniqueness: one account code per project ────────────────────────────
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS cost_accounts_project_code_key
    ON cost_accounts (project_id, lower(code)) WHERE project_id IS NOT NULL AND code IS NOT NULL;
EXCEPTION WHEN others THEN RAISE NOTICE 'cost_accounts code uniqueness skipped: %', SQLERRM; END $$;

-- ── indexes for the rollup queries ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS cost_entries_account_idx ON cost_entries(cost_account_id);
CREATE INDEX IF NOT EXISTS cost_entries_project_idx ON cost_entries(project_id);
CREATE INDEX IF NOT EXISTS cost_entries_date_idx    ON cost_entries(entry_date);
CREATE INDEX IF NOT EXISTS cost_accounts_project_idx ON cost_accounts(project_id);
CREATE INDEX IF NOT EXISTS cost_documents_project_idx ON cost_documents(project_id);
CREATE INDEX IF NOT EXISTS project_parties_project_idx ON project_parties(project_id);

-- ── dangling reference fixed: entries → cost_documents ──────────────────
DO $$ BEGIN
  ALTER TABLE cost_entries ADD CONSTRAINT cost_entries_source_document_fk
    FOREIGN KEY (source_document_id) REFERENCES cost_documents(id) ON DELETE SET NULL NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
          WHEN others THEN RAISE NOTICE 'cost_entries source FK skipped: %', SQLERRM; END $$;
