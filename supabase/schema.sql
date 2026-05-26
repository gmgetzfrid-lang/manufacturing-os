-- Manufacturing OS — PostgreSQL schema for Supabase
-- Run this in the Supabase SQL editor to set up your database.

-- ============================================================
-- TABLES
-- ============================================================

-- User profiles (synced from auth.users)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  default_org_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Organizations
CREATE TABLE IF NOT EXISTS orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'business' CHECK (type IN ('personal', 'business')),
  billing JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID
);

-- Org Members
CREATE TABLE IF NOT EXISTS org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  uid UUID NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'Viewer',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'inactive')),
  display_name TEXT,
  invited_at TIMESTAMPTZ,
  invited_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID,
  UNIQUE(org_id, uid)
);

-- Org Configurations (e.g. drafting settings)
CREATE TABLE IF NOT EXISTS org_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, key)
);

-- Libraries
CREATE TABLE IF NOT EXISTS libraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  visibility TEXT DEFAULT 'normal',
  acl JSONB,
  acl_index JSONB,
  folder_security TEXT DEFAULT 'Inherit',
  default_new_visibility TEXT DEFAULT 'normal',
  default_new_acl JSONB,
  custom_columns JSONB DEFAULT '[]',
  read_access JSONB,
  write_access JSONB,
  admin_access JSONB,
  visible_to JSONB,
  column_widths JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID
);

-- Backfill for existing deployments where libraries was created before column_widths was added.
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS column_widths JSONB DEFAULT '{}';

-- Collections (folders within libraries)
CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT[] DEFAULT '{}',
  path_ids UUID[] DEFAULT '{}',
  path_names TEXT[] DEFAULT '{}',
  visibility TEXT DEFAULT 'normal',
  acl JSONB,
  acl_index JSONB,
  column_overrides JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID
);

CREATE INDEX IF NOT EXISTS collections_library_id_idx ON collections(library_id);
CREATE INDEX IF NOT EXISTS collections_parent_id_idx ON collections(parent_id);
CREATE INDEX IF NOT EXISTS collections_path_ids_idx ON collections USING GIN(path_ids);

-- Document Sets
CREATE TABLE IF NOT EXISTS document_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  current_set_rev TEXT,
  sheet_count INT DEFAULT 0,
  asset_index JSONB DEFAULT '{}',
  visibility TEXT DEFAULT 'normal',
  acl JSONB,
  acl_index JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- Documents
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  collection_id UUID REFERENCES collections(id) ON DELETE SET NULL,
  set_id UUID REFERENCES document_sets(id) ON DELETE SET NULL,
  sheet_number INT,
  sheet_total INT,
  name TEXT,
  document_number TEXT,
  title TEXT,
  rev TEXT,
  revision TEXT,
  status TEXT DEFAULT 'Draft',
  current_version_id UUID,
  metadata JSONB DEFAULT '{}',
  metadata_template_id UUID,
  metadata_tags JSONB DEFAULT '{}',
  ingestion JSONB,
  asset_tags JSONB DEFAULT '[]',
  tags TEXT[] DEFAULT '{}',
  download_policy JSONB,
  watermark_policy_id UUID,
  checked_out_by UUID,
  checked_out_by_name TEXT,
  checked_out_at TIMESTAMPTZ,
  current_lock_id TEXT,
  checkout_note TEXT,
  active_collaborators TEXT[] DEFAULT '{}',
  revision_history JSONB DEFAULT '[]',
  visibility TEXT DEFAULT 'normal',
  acl JSONB,
  acl_index JSONB,
  is_private BOOLEAN DEFAULT FALSE,
  scope TEXT DEFAULT 'org',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  -- Phase 2 document-control fields (see migrations/20260526_supersede_archive.sql)
  archived_at TIMESTAMPTZ,
  archived_by UUID,
  archive_reason TEXT,
  superseded_at TIMESTAMPTZ,
  superseded_by_user UUID,
  supersession_reason TEXT,
  supersession_moc TEXT
);

CREATE TABLE IF NOT EXISTS document_supersessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  superseded_doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  replacement_doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reason TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (superseded_doc_id, replacement_doc_id)
);
CREATE INDEX IF NOT EXISTS document_supersessions_old_idx ON document_supersessions(superseded_doc_id);
CREATE INDEX IF NOT EXISTS document_supersessions_new_idx ON document_supersessions(replacement_doc_id);

CREATE INDEX IF NOT EXISTS documents_library_id_idx ON documents(library_id);
CREATE INDEX IF NOT EXISTS documents_collection_id_idx ON documents(collection_id);
CREATE INDEX IF NOT EXISTS documents_org_id_idx ON documents(org_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents(status);
CREATE INDEX IF NOT EXISTS documents_org_lib_status_idx ON documents(org_id, library_id, status);

-- Document Versions
CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision_label TEXT NOT NULL,
  issue_type TEXT,
  change_type TEXT,
  file_url TEXT NOT NULL,
  file_type TEXT,
  size BIGINT,
  is_flattened BOOLEAN DEFAULT FALSE,
  has_watermark BOOLEAN DEFAULT FALSE,
  watermark_policy_id UUID,
  download_policy JSONB,
  change_log TEXT,
  related_ticket_id UUID,
  created_by UUID NOT NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_by UUID,
  -- Phase 1 document-control fields (see migrations/20260526_document_version_control.sql)
  supersedes_version_id UUID REFERENCES document_versions(id),
  drawn_by UUID,
  drawn_by_name TEXT,
  checked_by UUID,
  checked_by_name TEXT,
  approved_by_name TEXT,
  approved_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  moc_reference TEXT,
  source_file_name TEXT,
  reverted_from_version_id UUID REFERENCES document_versions(id),
  file_hash TEXT
);

CREATE INDEX IF NOT EXISTS document_versions_record_id_idx ON document_versions(record_id);
CREATE INDEX IF NOT EXISTS document_versions_supersedes_idx ON document_versions(supersedes_version_id);
CREATE INDEX IF NOT EXISTS document_versions_record_created_idx ON document_versions(record_id, created_at DESC);

-- Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  request_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  priority INT,
  requester_id UUID NOT NULL,
  requester_name TEXT,
  requester_email TEXT,
  requester_role TEXT,
  assigned_drafter_id UUID,
  assigned_drafter_name TEXT,
  attachments JSONB DEFAULT '[]',
  comments JSONB DEFAULT '[]',
  history JSONB DEFAULT '[]',
  unread_by UUID[] DEFAULT '{}',
  revision_count INT DEFAULT 0,
  search_keywords TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_modified TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  UNIQUE(org_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS tickets_org_id_idx ON tickets(org_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);
CREATE INDEX IF NOT EXISTS tickets_requester_id_idx ON tickets(requester_id);
CREATE INDEX IF NOT EXISTS tickets_assigned_drafter_id_idx ON tickets(assigned_drafter_id);

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  org_id UUID,
  user_id UUID,
  user_email TEXT,
  user_role TEXT,
  details JSONB,
  metadata JSONB,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_org_id_idx ON audit_logs(org_id);
CREATE INDEX IF NOT EXISTS audit_logs_resource_id_idx ON audit_logs(resource_id);

-- Download Audits
CREATE TABLE IF NOT EXISTS download_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version_id UUID REFERENCES document_versions(id),
  user_id UUID NOT NULL,
  user_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  watermark_policy_id UUID
);

-- Checkout Sessions
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  library_id UUID REFERENCES libraries(id),
  user_id UUID NOT NULL,
  user_name TEXT,
  mode TEXT NOT NULL DEFAULT 'view',
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  linked_ticket_id UUID REFERENCES tickets(id),
  lock_id TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS checkout_sessions_document_id_idx ON checkout_sessions(document_id);
CREATE INDEX IF NOT EXISTS checkout_sessions_user_id_idx ON checkout_sessions(user_id);

-- Table Views (deterministic TEXT id)
CREATE TABLE IF NOT EXISTS table_views (
  id TEXT PRIMARY KEY,
  org_id UUID REFERENCES orgs(id),
  owner_user_id UUID,
  name TEXT NOT NULL DEFAULT 'My View',
  library_id UUID REFERENCES libraries(id),
  collection_id UUID REFERENCES collections(id),
  columns TEXT[] NOT NULL DEFAULT '{}',
  column_config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Metadata Templates
CREATE TABLE IF NOT EXISTS metadata_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  library_id UUID REFERENCES libraries(id),
  collection_id UUID REFERENCES collections(id),
  fields JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- Watermark Policies
CREATE TABLE IF NOT EXISTS watermark_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),
  name TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  stamp JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE download_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadata_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE watermark_policies ENABLE ROW LEVEL SECURITY;

-- Helper: active orgs for current user
CREATE OR REPLACE FUNCTION my_org_ids()
RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER AS $$
  SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active';
$$;

-- Users
CREATE POLICY "users_own" ON users FOR ALL USING (id = auth.uid());

-- Orgs
CREATE POLICY "orgs_member_access" ON orgs FOR SELECT
  USING (id IN (SELECT my_org_ids()));
CREATE POLICY "orgs_admin_write" ON orgs FOR UPDATE
  USING (id IN (
    SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'
  ));

-- Org Members
CREATE POLICY "org_members_read" ON org_members FOR SELECT
  USING (uid = auth.uid() OR org_id IN (SELECT my_org_ids()));
CREATE POLICY "org_members_write" ON org_members FOR ALL
  USING (org_id IN (
    SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin', 'Manager')
  ));

-- Org Configurations
CREATE POLICY "org_configurations_access" ON org_configurations FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Libraries
CREATE POLICY "libraries_org_access" ON libraries FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Collections
CREATE POLICY "collections_org_access" ON collections FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Documents
CREATE POLICY "documents_org_access" ON documents FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Document Versions
CREATE POLICY "document_versions_org_access" ON document_versions FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Document Sets
CREATE POLICY "document_sets_org_access" ON document_sets FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Tickets
CREATE POLICY "tickets_org_access" ON tickets FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Audit Logs
CREATE POLICY "audit_logs_org_access" ON audit_logs FOR SELECT
  USING (org_id IN (SELECT my_org_ids()));
CREATE POLICY "audit_logs_insert" ON audit_logs FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Download Audits
CREATE POLICY "download_audits_org_access" ON download_audits FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Checkout Sessions
CREATE POLICY "checkout_sessions_org_access" ON checkout_sessions FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Table Views
CREATE POLICY "table_views_access" ON table_views FOR ALL
  USING (org_id IN (SELECT my_org_ids()) OR owner_user_id = auth.uid());

-- Metadata Templates
CREATE POLICY "metadata_templates_org_access" ON metadata_templates FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- Watermark Policies
CREATE POLICY "watermark_policies_org_access" ON watermark_policies FOR ALL
  USING (org_id IN (SELECT my_org_ids()));

-- ============================================================
-- REAL-TIME
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE tickets;
ALTER PUBLICATION supabase_realtime ADD TABLE documents;
ALTER PUBLICATION supabase_realtime ADD TABLE checkout_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE collections;
ALTER PUBLICATION supabase_realtime ADD TABLE org_members;
ALTER PUBLICATION supabase_realtime ADD TABLE libraries;
