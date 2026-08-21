-- 20261013_project_controls_program.sql
--
-- THE PROJECT CONTROLS PROGRAM — one migration, six pillars:
--
--   1. WIZARD FIELDS on projects: purpose, goals, success criteria, job kind
--      (small | standard | capital — sizes defaults downstream), Summary-of-
--      Work pointer, lessons learned, and setup_state (which wizard steps the
--      creator completed/skipped — the coach picks up the skipped ones).
--
--   2. KNOWN COMPANIES — the org-level contractor/vendor/rental/internal-crew
--      registry. Scores are NOT stored as opinions: every dimension is
--      computed from evidence rows (bids, change orders, turnover reviews,
--      milestones, safety events) so a score can always show its work.
--      company_events is the safety/performance log (recordables, near
--      misses, warnings, stop-works, commendations).
--
--   3. CHANGE ORDERS — first-class, never a silent budget edit. Reason codes
--      score the contractor (scope_gap) AND us (design_error, owner_request).
--      Approval posts a typed cost entry; the CO row stays as the paper.
--
--   4. CHECKLIST ENGINE — project_checklists + checklist_items: a PSSR / MI /
--      QA-QC checklist parsed into discrete items, each with applicability,
--      status, evidence links, and an AI rationale that a human can override.
--      "The checklist tells the system what's needed; the system tells you
--      what's missing."
--
--   5. TURNOVER & PUNCH — turnover_items (the quality-package contents the
--      job requires, received/accepted per item with reviewer sign-off) and
--      punch_items (the closeout snag list).
--
--   6. INBOUND QUOTES — cost_documents (already in schema, previously
--      code-dead) gains rfq_group so competing quotes tabulate together, and
--      intake links gain purpose='quote' so contractors can submit quotes
--      through their existing tokened portal.
--
-- ACCESS MODEL SHIFT: cost writes open to the PROJECT OWNER (previously
-- controller-only) — org controllers keep full power; owners gain it on
-- their own projects. Helper user_owns_project() keeps the policies short.

-- ── 1. Wizard fields on projects ─────────────────────────────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS purpose TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS goals JSONB;              -- ["goal", ...]
ALTER TABLE projects ADD COLUMN IF NOT EXISTS success_criteria TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS job_kind TEXT;            -- small | standard | capital
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sow_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lessons_learned TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_state JSONB;        -- {budget:"done"|"skipped", schedule:..., ...}

COMMENT ON COLUMN projects.job_kind IS 'Wizard sizing: small | standard | capital. Drives defaults (turnover seeds, gate strictness), never permissions.';
COMMENT ON COLUMN projects.setup_state IS 'Wizard step outcomes; the project coach re-surfaces skipped steps.';

-- ── Ownership helper (used by every owner-write policy below) ────────────
-- Ownership alone isn't enough: the owner must also still be an ACTIVE org
-- member, so offboarding someone (status != 'active') revokes their write
-- access to cost/controls tables immediately, whatever projects still name
-- them owner. search_path pinned per the house SECURITY DEFINER pattern.
CREATE OR REPLACE FUNCTION user_owns_project(p_project UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
    JOIN org_members m
      ON m.org_id = p.org_id AND m.uid = auth.uid() AND m.status = 'active'
    WHERE p.id = p_project AND p.owner_user_id = auth.uid()
  );
$$;

-- ── 2. Known Companies registry ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'contractor' CHECK (kind IN ('contractor','vendor','rental','internal')),
  trade TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','do_not_use')),
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  -- Quality-manual evaluation: the manual lives in doc control; the score +
  -- cited gaps are AI-proposed and HUMAN-CONFIRMED before they land here.
  quality_manual_doc_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  quality_manual_score NUMERIC,          -- 0..100 coverage
  quality_manual_gaps JSONB,             -- [{area, finding}]
  quality_manual_reviewed_at TIMESTAMPTZ,
  quality_manual_reviewed_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_org_name_key ON companies (org_id, lower(name));
CREATE INDEX IF NOT EXISTS companies_org_idx ON companies (org_id, status);

CREATE TABLE IF NOT EXISTS company_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recordable','near_miss','warning','stop_work','commendation','other')),
  event_date DATE NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  created_by_name TEXT
);
CREATE INDEX IF NOT EXISTS company_events_company_idx ON company_events (company_id, event_date DESC);

-- Project parties link to the registry so per-project performance rolls up
-- to the company's permanent record.
ALTER TABLE project_parties ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS project_parties_company_idx ON project_parties (company_id);

-- ── 3. Change orders ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS change_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_account_id UUID REFERENCES cost_accounts(id) ON DELETE SET NULL,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,
  co_number TEXT NOT NULL,               -- CO-001 … generated per project
  title TEXT NOT NULL,
  description TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,     -- signed; negative = credit
  reason_code TEXT NOT NULL CHECK (reason_code IN ('scope_gap','field_condition','owner_request','design_error','other')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','void')),
  decided_at TIMESTAMPTZ,
  decided_by UUID,
  decided_by_name TEXT,
  decision_note TEXT,
  posted_entry_id UUID,                  -- cost_entries row created on approval
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  created_by_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS change_orders_project_number_key ON change_orders (project_id, co_number);
CREATE INDEX IF NOT EXISTS change_orders_project_idx ON change_orders (project_id, status);

-- ── 4. Checklist engine (PSSR / MI / QA-QC / custom) ─────────────────────
CREATE TABLE IF NOT EXISTS project_checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pssr' CHECK (kind IN ('pssr','mi','qaqc','custom')),
  source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete','void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  created_by_name TEXT
);
CREATE INDEX IF NOT EXISTS project_checklists_project_idx ON project_checklists (project_id, status);

CREATE TABLE IF NOT EXISTS checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  checklist_id UUID NOT NULL REFERENCES project_checklists(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0,
  section TEXT,
  text TEXT NOT NULL,
  applicability TEXT NOT NULL DEFAULT 'unknown' CHECK (applicability IN ('applies','na','unknown')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','needs_evidence','satisfied','na')),
  evidence JSONB,                        -- [{label, documentId?, href?, source:'auto'|'manual'}]
  ai_rationale TEXT,                     -- why the assessment thinks so (cited)
  manual_note TEXT,                      -- human override note — always wins
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  updated_by_name TEXT
);
CREATE INDEX IF NOT EXISTS checklist_items_checklist_idx ON checklist_items (checklist_id, seq);

-- ── 5. Turnover package + punch list ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS turnover_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,
  name TEXT NOT NULL,                    -- "Weld map", "NDE reports", "Material certs (MTRs)"
  description TEXT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','received','accepted','rejected','waived')),
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  reviewed_by_name TEXT,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);
CREATE INDEX IF NOT EXISTS turnover_items_project_idx ON turnover_items (project_id, status);

CREATE TABLE IF NOT EXISTS punch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  party_id UUID REFERENCES project_parties(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','void')),
  due_date DATE,
  closed_at TIMESTAMPTZ,
  closed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  created_by_name TEXT
);
CREATE INDEX IF NOT EXISTS punch_items_project_idx ON punch_items (project_id, status);

-- ── 6. Inbound quotes ────────────────────────────────────────────────────
ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS rfq_group TEXT;      -- bids in one group tabulate together
COMMENT ON COLUMN cost_documents.rfq_group IS 'Scope label grouping competing quotes into one bid tabulation.';
-- Quotes arriving through the tokened intake portal have no account behind
-- them: created_by goes nullable, and the submitting link is stamped so the
-- portal can show the company its own submissions (and the responsiveness
-- clock has real timestamps).
ALTER TABLE cost_documents ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE cost_documents ADD COLUMN IF NOT EXISTS intake_link_id UUID REFERENCES project_intake_links(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS cost_documents_intake_link_idx ON cost_documents (intake_link_id);

ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'documents';
ALTER TABLE project_intake_links ADD COLUMN IF NOT EXISTS rfq_group TEXT;
COMMENT ON COLUMN project_intake_links.purpose IS 'documents (drawings/revisions — the original portal) | quote (uploads land as cost_documents for bid tabulation).';

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE companies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE turnover_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE punch_items        ENABLE ROW LEVEL SECURITY;

-- Members read; controllers write (companies are ORG-level records).
DO $$ BEGIN
  CREATE POLICY companies_member_read ON companies FOR SELECT
    USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = companies.org_id AND m.uid = auth.uid() AND m.status = 'active'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY companies_controller_write ON companies FOR ALL
    USING (is_org_controller(org_id)) WITH CHECK (is_org_controller(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY company_events_member_read ON company_events FOR SELECT
    USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = company_events.org_id AND m.uid = auth.uid() AND m.status = 'active'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY company_events_controller_write ON company_events FOR ALL
    USING (is_org_controller(org_id)) WITH CHECK (is_org_controller(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Project-scoped tables: members read; controllers OR the project owner write.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['change_orders','project_checklists','checklist_items','turnover_items','punch_items'] LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I_member_read ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = %I.org_id AND m.uid = auth.uid() AND m.status = ''active''))',
        t, t, t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;

DO $$ BEGIN
  CREATE POLICY change_orders_write ON change_orders FOR ALL
    USING (is_org_controller(org_id) OR user_owns_project(project_id))
    WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY project_checklists_write ON project_checklists FOR ALL
    USING (is_org_controller(org_id) OR user_owns_project(project_id))
    WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY checklist_items_write ON checklist_items FOR ALL
    USING (is_org_controller(org_id) OR EXISTS (
      SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)))
    WITH CHECK (is_org_controller(org_id) OR EXISTS (
      SELECT 1 FROM project_checklists c WHERE c.id = checklist_items.checklist_id AND user_owns_project(c.project_id)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY turnover_items_write ON turnover_items FOR ALL
    USING (is_org_controller(org_id) OR user_owns_project(project_id))
    WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY punch_items_write ON punch_items FOR ALL
    USING (is_org_controller(org_id) OR user_owns_project(project_id))
    WITH CHECK (is_org_controller(org_id) OR user_owns_project(project_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Cost-table schema reconciliation ─────────────────────────────────────
-- The 20260819 backfill reconstruction of cost_entries missed the
-- created_by_name column addEntry has always written — add it idempotently
-- so environments rebuilt from migrations match the live schema. And the
-- reconstructed NOT NULLs on created_by are relaxed to match cost_documents:
-- attribution lives in audit_logs; a missing uid must never eat a budget row.
ALTER TABLE cost_entries ADD COLUMN IF NOT EXISTS created_by_name TEXT;
ALTER TABLE cost_accounts   ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE project_parties ALTER COLUMN created_by DROP NOT NULL;

-- ── THE UNGATING: cost writes open to the project owner ──────────────────
-- 20260906 hardened cost tables to controller-only writes. The audit's
-- verdict: that gate is why "the meat and potatoes" was invisible. Owners
-- now write costs on their own projects; controllers keep org-wide power.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_parties','cost_accounts','cost_documents','cost_entries'] LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY %I_owner_write ON %I FOR ALL USING (user_owns_project(project_id)) WITH CHECK (user_owns_project(project_id))',
        t, t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END LOOP;
END $$;
