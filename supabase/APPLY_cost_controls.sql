-- APPLY_cost_controls.sql  ·  ONE-SHOT MANUAL APPLY (convenience bundle)
-- ─────────────────────────────────────────────────────────────────────────
-- This project has no migration runner — migrations are applied by pasting
-- SQL into the Supabase SQL editor. This file bundles the three migrations the
-- Project Controls / cost features need, so you can apply them in one go:
--
--   20260801  projects.controls_config        (cost model persistence)
--   20260802  milestones.actual_hours         (field-logged actual hours)
--   20260803  project_parties / cost_accounts / cost_entries / cost_documents
--             (the multi-contractor cost structure — clears the banner)
--
-- HOW TO RUN:
--   Supabase dashboard → SQL Editor → New query → paste this whole file → Run.
--
-- It is IDEMPOTENT and ADDITIVE — every statement uses IF NOT EXISTS / DROP
-- POLICY IF EXISTS, so running it once (or again) is safe and touches no
-- existing data. The canonical per-migration files live in supabase/migrations/.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 20260801: project controls cost model ────────────────────────────────
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS controls_config JSONB;
COMMENT ON COLUMN projects.controls_config IS
  'Project-controls cost model (blended rate, budget override, actual cost, contingency, currency). Drives the cost side of the EVM dashboard. NULL = not configured.';

-- ── 20260802: milestone actual hours (ACWP source) ───────────────────────
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS actual_hours NUMERIC;
COMMENT ON COLUMN milestones.actual_hours IS
  'Actual labor hours expended on this task (ACWP source for EVM). NULL until logged from the field. Distinct from duration_hours, which is planned/budgeted work.';

-- ── 20260803: multi-contractor Cost Breakdown Structure ──────────────────

CREATE TABLE IF NOT EXISTS project_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'contractor'
    CHECK (kind IN ('contractor','subcontractor','department','vendor','internal')),
  trade TEXT,
  default_rate NUMERIC,
  contract_value NUMERIC,
  contact_name TEXT,
  contact_email TEXT,
  cam_user_id UUID,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);
CREATE INDEX IF NOT EXISTS project_parties_project_idx ON project_parties(project_id);
CREATE INDEX IF NOT EXISTS project_parties_org_idx ON project_parties(org_id);
ALTER TABLE project_parties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_parties_member_all ON project_parties;
CREATE POLICY project_parties_member_all ON project_parties FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_parties.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_parties.org_id AND uid = auth.uid() AND status = 'active'));

CREATE TABLE IF NOT EXISTS cost_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,
  wbs_milestone_id UUID REFERENCES milestones(id) ON DELETE SET NULL,
  code TEXT,
  name TEXT NOT NULL,
  cost_type TEXT NOT NULL DEFAULT 'labor'
    CHECK (cost_type IN ('labor','material','equipment','subcontract','odc')),
  budget NUMERIC NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  cam_user_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);
CREATE INDEX IF NOT EXISTS cost_accounts_project_idx ON cost_accounts(project_id);
CREATE INDEX IF NOT EXISTS cost_accounts_party_idx ON cost_accounts(party_id);
CREATE INDEX IF NOT EXISTS cost_accounts_wbs_idx ON cost_accounts(wbs_milestone_id);
ALTER TABLE cost_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_accounts_member_all ON cost_accounts;
CREATE POLICY cost_accounts_member_all ON cost_accounts FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = cost_accounts.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = cost_accounts.org_id AND uid = auth.uid() AND status = 'active'));

CREATE TABLE IF NOT EXISTS cost_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_account_id UUID NOT NULL REFERENCES cost_accounts(id) ON DELETE CASCADE,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL DEFAULT 'actual'
    CHECK (entry_type IN ('budget','commitment','actual','change')),
  amount NUMERIC NOT NULL DEFAULT 0,
  entry_date DATE,
  description TEXT,
  reference TEXT,
  source_document_id UUID,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);
CREATE INDEX IF NOT EXISTS cost_entries_account_idx ON cost_entries(cost_account_id);
CREATE INDEX IF NOT EXISTS cost_entries_project_type_idx ON cost_entries(project_id, entry_type);
CREATE INDEX IF NOT EXISTS cost_entries_doc_idx ON cost_entries(source_document_id);
ALTER TABLE cost_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_entries_member_all ON cost_entries;
CREATE POLICY cost_entries_member_all ON cost_entries FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = cost_entries.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = cost_entries.org_id AND uid = auth.uid() AND status = 'active'));

CREATE TABLE IF NOT EXISTS cost_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'invoice'
    CHECK (kind IN ('quote','estimate','po','subcontract','invoice','change_order','other')),
  file_url TEXT,
  file_name TEXT,
  mime_type TEXT,
  doc_number TEXT,
  doc_date DATE,
  vendor_name TEXT,
  currency TEXT,
  total_amount NUMERIC,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','parsing','parsed','posted','rejected')),
  parsed JSONB,
  posted_at TIMESTAMPTZ,
  posted_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_documents_project_idx ON cost_documents(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cost_documents_party_idx ON cost_documents(party_id);
ALTER TABLE cost_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cost_documents_member_all ON cost_documents;
CREATE POLICY cost_documents_member_all ON cost_documents FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = cost_documents.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = cost_documents.org_id AND uid = auth.uid() AND status = 'active'));

-- Done. Reload the Controls tab — the cost structure + ingestion are now live.
