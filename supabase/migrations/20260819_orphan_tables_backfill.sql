-- 20260819_orphan_tables_backfill.sql
--
-- Reproducibility backfill: CREATE TABLE statements for 11 tables that exist
-- in the production database but had no migration in the repo (they were
-- created ad-hoc), so a fresh `supabase db reset` was missing them.
--
-- All statements are IF NOT EXISTS, so on the live DB (where these tables
-- already exist) this migration is a no-op. It only takes effect on a fresh
-- rebuild. FIDELITY NOTE: columns/types/PK/FK/NOT-NULL are reconstructed from
-- the live schema; exact DEFAULT expressions, CHECK constraints, and secondary
-- indexes may differ from production — the live database remains the source of
-- truth. RLS is enabled with an org-member policy so a fresh rebuild is
-- secure by default (matching the production policies).

-- ── access_requests (public sign-up requests; no org_id) ─────────
CREATE TABLE IF NOT EXISTS access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  email text NOT NULL,
  org_name text NOT NULL,
  message text,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_requests_anyone_insert ON access_requests;
CREATE POLICY access_requests_anyone_insert ON access_requests FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS access_requests_admin_select ON access_requests;
CREATE POLICY access_requests_admin_select ON access_requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'));

-- ── access_recertification_events ───────────────────────────────
CREATE TABLE IF NOT EXISTS access_recertification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id uuid REFERENCES libraries(id) ON DELETE SET NULL,
  action text NOT NULL,
  grants_snapshot jsonb,
  grant_count integer,
  note text,
  next_recertification_date date,
  performed_by uuid,
  performed_by_name text,
  performed_at timestamptz NOT NULL DEFAULT now()
);

-- ── asset_files ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  caption text,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  metadata jsonb
);

-- ── document_acknowledgments ────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id uuid,
  revision_label text,
  content_hash text,
  assignee_user_id uuid NOT NULL,
  assignee_name text,
  assignee_role text,
  source text NOT NULL,
  status text NOT NULL,
  signature_id uuid,
  acknowledged_at timestamptz,
  waived_by uuid,
  waived_reason text,
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── document_disposition_events ─────────────────────────────────
CREATE TABLE IF NOT EXISTS document_disposition_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  scope_type text,
  scope_id uuid,
  action text NOT NULL,
  matter text,
  reason text,
  detail jsonb,
  performed_by uuid,
  performed_by_name text,
  performed_at timestamptz NOT NULL DEFAULT now()
);

-- ── document_review_events (org_id nullable, no FK in prod) ──────
CREATE TABLE IF NOT EXISTS document_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  document_id uuid NOT NULL,
  action text NOT NULL,
  outcome text,
  note text,
  next_review_date date,
  performed_by uuid,
  performed_by_name text,
  performed_at timestamptz DEFAULT now()
);

-- ── document_review_signoffs ────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_review_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version_id uuid,
  revision_label text,
  content_hash text,
  reviewer_user_id uuid NOT NULL,
  reviewer_name text,
  reviewer_role text,
  slot text NOT NULL,
  source text NOT NULL,
  activated boolean NOT NULL DEFAULT true,
  status text NOT NULL,
  signature_id uuid,
  signed_at timestamptz,
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── project_parties (FK target for cost_* tables) ───────────────
CREATE TABLE IF NOT EXISTS project_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  trade text,
  default_rate numeric,
  contract_value numeric,
  contact_name text,
  contact_email text,
  cam_user_id uuid,
  notes text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz,
  updated_by uuid
);

-- ── cost_accounts (refs project_parties, milestones) ────────────
CREATE TABLE IF NOT EXISTS cost_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  party_id uuid REFERENCES project_parties(id) ON DELETE SET NULL,
  wbs_milestone_id uuid REFERENCES milestones(id) ON DELETE SET NULL,
  code text,
  name text NOT NULL,
  cost_type text NOT NULL,
  budget numeric NOT NULL DEFAULT 0,
  currency text,
  cam_user_id uuid,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz,
  updated_by uuid
);

-- ── cost_documents ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  party_id uuid REFERENCES project_parties(id) ON DELETE SET NULL,
  kind text NOT NULL,
  file_url text,
  file_name text,
  mime_type text,
  doc_number text,
  doc_date date,
  vendor_name text,
  currency text,
  total_amount numeric,
  status text NOT NULL DEFAULT 'draft',
  parsed jsonb,
  posted_at timestamptz,
  posted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL
);

-- ── cost_entries (refs cost_accounts, project_parties) ──────────
CREATE TABLE IF NOT EXISTS cost_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_account_id uuid NOT NULL REFERENCES cost_accounts(id) ON DELETE CASCADE,
  party_id uuid REFERENCES project_parties(id) ON DELETE SET NULL,
  entry_type text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  entry_date date,
  description text,
  reference text,
  source_document_id uuid,
  status text NOT NULL DEFAULT 'posted',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz,
  updated_by uuid
);

-- ── RLS: enable + standard org-member policy on the org-scoped tables ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'access_recertification_events','asset_files','document_acknowledgments',
    'document_disposition_events','document_review_events','document_review_signoffs',
    'project_parties','cost_accounts','cost_documents','cost_entries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_member_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO authenticated '
      || 'USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = %I.org_id AND uid = auth.uid() AND status = ''active'')) '
      || 'WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = %I.org_id AND uid = auth.uid() AND status = ''active''))',
      t || '_member_all', t, t, t);
  END LOOP;
END $$;
