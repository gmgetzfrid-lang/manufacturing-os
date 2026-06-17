-- 20260803_project_cost_controls.sql
--
-- Enterprise cost controls — the multi-contractor Cost Breakdown Structure.
--
-- The first cost pass modelled a project as ONE blended rate and ONE budget.
-- Real capital projects don't work that way: many contractors and departments,
-- each with their own scope, rate(s), contract value, budget, commitments and
-- invoices. This adds the EVMS structure that scales to that:
--
--   project_parties   OBS — contractors / subcontractors / departments / vendors
--   cost_accounts     Control Accounts (CBS) = WBS phase × party × cost type,
--                     each owning its own budget (BAC) and a responsible CAM.
--                     Variance is measured here and rolls up by WBS and by OBS.
--   cost_entries      the three-way ledger per account: budget / commitment
--                     (PO, subcontract) / actual (invoice, timesheet) / change
--   cost_documents    ingested source docs (quote / PO / invoice / change order)
--                     with the AI-extracted line items, kept for traceability
--
-- The blended-rate model still works when no cost accounts are defined — this
-- is purely additive and the controls dashboard falls back to it. All tables
-- are org-scoped with the same active-member RLS the rest of the app uses.

-- ─── project_parties (OBS) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'contractor'
    CHECK (kind IN ('contractor','subcontractor','department','vendor','internal')),
  trade TEXT,                       -- discipline / scope (Mechanical, Electrical, Civil…)
  default_rate NUMERIC,             -- optional blended labor rate for this party
  contract_value NUMERIC,           -- this party's total contract / award value
  contact_name TEXT,
  contact_email TEXT,
  cam_user_id UUID,                 -- Control Account Manager (an org member)
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

-- ─── cost_accounts (Control Accounts / CBS) ───────────────────────────────
CREATE TABLE IF NOT EXISTS cost_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- OBS (who) and WBS (what) — either may be null while a structure is built.
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,
  wbs_milestone_id UUID REFERENCES milestones(id) ON DELETE SET NULL,

  code TEXT,                        -- CBS / control-account code, e.g. "1.2.3-ELEC"
  name TEXT NOT NULL,
  cost_type TEXT NOT NULL DEFAULT 'labor'
    CHECK (cost_type IN ('labor','material','equipment','subcontract','odc')),
  budget NUMERIC NOT NULL DEFAULT 0,   -- BAC for this account (live, post approved changes)
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

-- ─── cost_entries (budget / commitment / actual / change ledger) ──────────
CREATE TABLE IF NOT EXISTS cost_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_account_id UUID NOT NULL REFERENCES cost_accounts(id) ON DELETE CASCADE,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,  -- denormalized for rollup

  entry_type TEXT NOT NULL DEFAULT 'actual'
    CHECK (entry_type IN ('budget','commitment','actual','change')),
  amount NUMERIC NOT NULL DEFAULT 0,
  entry_date DATE,
  description TEXT,
  reference TEXT,                    -- PO# / invoice# / change-order #
  source_document_id UUID,           -- → cost_documents (kept loose; set null on doc delete)
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

-- ─── cost_documents (ingested quotes / POs / invoices) ────────────────────
CREATE TABLE IF NOT EXISTS cost_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,

  kind TEXT NOT NULL DEFAULT 'invoice'
    CHECK (kind IN ('afe','quote','estimate','po','subcontract','invoice','change_order','other')),
  file_url TEXT,
  file_name TEXT,
  mime_type TEXT,
  doc_number TEXT,
  doc_date DATE,
  vendor_name TEXT,
  currency TEXT,
  total_amount NUMERIC,
  -- uploaded → parsing → parsed → posted (entries created) → rejected
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','parsing','parsed','posted','rejected')),
  parsed JSONB,                      -- the AI extraction (line items + header)
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

-- Ensure the 'afe' kind is allowed even on databases where cost_documents was
-- created before it was added to the CHECK (idempotent).
ALTER TABLE cost_documents DROP CONSTRAINT IF EXISTS cost_documents_kind_check;
ALTER TABLE cost_documents ADD CONSTRAINT cost_documents_kind_check
  CHECK (kind IN ('afe','quote','estimate','po','subcontract','invoice','change_order','other'));

COMMENT ON TABLE project_parties IS 'OBS — contractors/departments/vendors engaged on a project, each with rate(s) and contract value.';
COMMENT ON TABLE cost_accounts  IS 'Control Accounts (CBS): WBS phase × party × cost type, each owning a budget (BAC). EVM rolls up from here.';
COMMENT ON TABLE cost_entries   IS 'Per-account ledger: budget / commitment (PO) / actual (invoice) / change. AC = Σ actuals.';
COMMENT ON TABLE cost_documents IS 'Ingested source docs (quote/PO/invoice/change order) + AI-extracted line items, for traceability.';
