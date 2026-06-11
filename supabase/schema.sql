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
  -- Request-number config (see migration 20260724_ticket_numbering.sql)
  ticket_prefix TEXT,
  ticket_record_code TEXT NOT NULL DEFAULT 'DDRT',
  ticket_number_pad INT NOT NULL DEFAULT 4 CHECK (ticket_number_pad BETWEEN 1 AND 9),
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
  -- Additive role collection; `role` above is the headline (highest-ranked of
  -- these). See migration 20260722_member_roles_collection.sql.
  roles TEXT[] NOT NULL DEFAULT '{}',
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
  supersession_moc TEXT,
  -- Phase 1 operational entity graph (see migrations/20260606_operational_entity_graph.sql)
  plant_id UUID,
  unit_id UUID,
  system_id UUID,
  -- Phase 2 search foundation (see migrations/20260607_search_foundation.sql)
  search_tsv tsvector
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
CREATE INDEX IF NOT EXISTS documents_plant_idx  ON documents(plant_id)  WHERE plant_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_unit_idx   ON documents(unit_id)   WHERE unit_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_system_idx ON documents(system_id) WHERE system_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_search_tsv_idx ON documents USING GIN(search_tsv);

-- ─── Operational entity graph (Phase 1) ─────────────────────────
-- See migrations/20260606_operational_entity_graph.sql for full design.
CREATE TABLE IF NOT EXISTS plants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,
  description TEXT,
  location    TEXT,
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS plants_org_idx ON plants(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS plants_org_code_uniq
  ON plants(org_id, code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS units (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  plant_id    UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS units_org_idx ON units(org_id);
CREATE INDEX IF NOT EXISTS units_plant_idx ON units(plant_id);
CREATE UNIQUE INDEX IF NOT EXISTS units_plant_code_uniq
  ON units(plant_id, code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS systems (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  plant_id    UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS systems_org_idx ON systems(org_id);
CREATE INDEX IF NOT EXISTS systems_unit_idx ON systems(unit_id);
CREATE INDEX IF NOT EXISTS systems_plant_idx ON systems(plant_id);
CREATE UNIQUE INDEX IF NOT EXISTS systems_unit_code_uniq
  ON systems(unit_id, code) WHERE code IS NOT NULL;

-- ─── Phase 1 normalization (see 20260609_phase1_normalization.sql) ──

-- Tag-normalization function (mirrors lib/assets.ts:normalizeTag)
CREATE OR REPLACE FUNCTION normalize_tag(t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lower(regexp_replace(COALESCE(t,''), '[^a-zA-Z0-9]+', '', 'g'));
$fn$;

-- project_documents — join table populated by checkout_sessions trigger
CREATE TABLE IF NOT EXISTS project_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  source        TEXT NOT NULL DEFAULT 'checkout' CHECK (source IN ('checkout','manual')),
  UNIQUE (project_id, document_id)
);
CREATE INDEX IF NOT EXISTS project_documents_project_idx  ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS project_documents_document_idx ON project_documents(document_id);
CREATE INDEX IF NOT EXISTS project_documents_org_idx      ON project_documents(org_id);

-- document_assets — depends on `assets` table which lives only in
-- migrations/20260603_asset_registry.sql. Wrap in an existence check so
-- a schema.sql-only fresh deploy doesn't blow up. The migration is the
-- complete source of truth.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'assets') THEN
    CREATE TABLE IF NOT EXISTS document_assets (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      asset_id      UUID NOT NULL REFERENCES assets(id)    ON DELETE CASCADE,
      tag_text      TEXT,
      source        TEXT NOT NULL DEFAULT 'jsonb_sync' CHECK (source IN ('jsonb_sync','manual')),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (document_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS document_assets_doc_idx   ON document_assets(document_id);
    CREATE INDEX IF NOT EXISTS document_assets_asset_idx ON document_assets(asset_id);
    CREATE INDEX IF NOT EXISTS document_assets_org_idx   ON document_assets(org_id);
  END IF;
END$$;

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

-- Phase 2 search foundation for revisions (see migrations/20260610_phase2_search_completion.sql)
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS search_tsv tsvector;
CREATE INDEX IF NOT EXISTS document_versions_search_tsv_idx ON document_versions USING GIN(search_tsv);

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
  -- Phase A engineer-routing fields (see migrations/20260528_engineer_review_routing.sql)
  assigned_engineer_id UUID,
  assigned_engineer_name TEXT,
  assigned_engineer_email TEXT,
  engineer_review_requested_at TIMESTAMPTZ,
  engineer_approved_at TIMESTAMPTZ,
  engineer_review_reason TEXT,
  attachments JSONB DEFAULT '[]',
  comments JSONB DEFAULT '[]',
  history JSONB DEFAULT '[]',
  -- Free-form per-request data: custom_categories (admin-defined fields) and
  -- source_document (the doc a request was raised from). See migration
  -- 20260721_tickets_metadata.sql.
  metadata JSONB,
  unread_by UUID[] DEFAULT '{}',
  revision_count INT DEFAULT 0,
  search_keywords TEXT[] DEFAULT '{}',
  -- Phase B fields (see migrations/20260529_phase_b_notifications.sql)
  watchers UUID[] DEFAULT '{}',
  target_completion_at TIMESTAMPTZ,
  sla_breach_warned_at TIMESTAMPTZ,
  sla_breached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_modified TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  UNIQUE(org_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS tickets_org_id_idx ON tickets(org_id);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);
CREATE INDEX IF NOT EXISTS tickets_requester_id_idx ON tickets(requester_id);
CREATE INDEX IF NOT EXISTS tickets_assigned_drafter_id_idx ON tickets(assigned_drafter_id);
CREATE INDEX IF NOT EXISTS tickets_assigned_engineer_idx ON tickets(assigned_engineer_id) WHERE assigned_engineer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_watchers_idx ON tickets USING GIN (watchers);
CREATE INDEX IF NOT EXISTS tickets_target_completion_idx ON tickets(target_completion_at) WHERE target_completion_at IS NOT NULL;

-- Phase 2 search foundation for tickets (see migrations/20260610_phase2_search_completion.sql)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS search_tsv tsvector;
CREATE INDEX IF NOT EXISTS tickets_search_tsv_idx ON tickets USING GIN(search_tsv);

-- Request numbering: atomic per-(org, year) counter + fast number search
-- (see migration 20260724_ticket_numbering.sql).CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS tickets_ticket_id_trgm_idx ON tickets USING GIN (ticket_id gin_trgm_ops);

CREATE TABLE IF NOT EXISTS ticket_number_counters (
  org_id   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  year     INT  NOT NULL,
  next_seq INT  NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id, year)
);
ALTER TABLE ticket_number_counters ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION next_ticket_number(p_org UUID, p_year INT)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_seq INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org AND uid = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'not an active member of this org';
  END IF;
  INSERT INTO ticket_number_counters (org_id, year, next_seq)
  VALUES (p_org, p_year, 1)
  ON CONFLICT (org_id, year) DO UPDATE SET next_seq = ticket_number_counters.next_seq + 1
  RETURNING next_seq INTO v_seq;
  RETURN v_seq;
END$$;
GRANT EXECUTE ON FUNCTION next_ticket_number(UUID, INT) TO authenticated;

-- Ticket comments as a real table + atomic post (see migration
-- 20260726_ticket_comments.sql). The legacy tickets.comments JSONB stays
-- dual-written (atomic `||` append) so existing readers work unchanged.
CREATE TABLE IF NOT EXISTS ticket_comments (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_uid UUID NOT NULL,
  author_email TEXT,
  author_role TEXT,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'General',
  category TEXT,
  mentioned_uids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ticket_comments_ticket_idx ON ticket_comments(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_comments_org_idx ON ticket_comments(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_comments_author_idx ON ticket_comments(author_uid);
ALTER TABLE ticket_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_comments_org_select ON ticket_comments;
CREATE POLICY ticket_comments_org_select ON ticket_comments FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.org_id = ticket_comments.org_id
      AND org_members.uid = auth.uid()
      AND org_members.status = 'active'
  )
);

CREATE OR REPLACE FUNCTION post_ticket_comment(
  p_ticket_id UUID,
  p_comment   JSONB,
  p_unread    UUID[],
  p_watchers  UUID[]
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org UUID;
BEGIN
  SELECT org_id INTO v_org FROM tickets WHERE id = p_ticket_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'ticket not found'; END IF;
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = v_org AND uid = auth.uid() AND status = 'active'
  ) THEN RAISE EXCEPTION 'not an active member of this org'; END IF;

  INSERT INTO ticket_comments (id, org_id, ticket_id, author_uid, author_email, author_role, body, type, category, mentioned_uids, created_at)
  VALUES (
    COALESCE((p_comment->>'id')::uuid, gen_random_uuid()),
    v_org, p_ticket_id,
    COALESCE((p_comment->>'authorUid')::uuid, auth.uid()),
    p_comment->>'user', p_comment->>'role',
    COALESCE(p_comment->>'text', ''),
    COALESCE(p_comment->>'type', 'General'),
    p_comment->>'category',
    COALESCE((SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(p_comment->'mentionedUserIds', '[]'::jsonb)) AS x), '{}'::uuid[]),
    COALESCE((p_comment->>'date')::timestamptz, NOW())
  );

  UPDATE tickets
     SET comments      = COALESCE(comments, '[]'::jsonb) || jsonb_build_array(p_comment),
         unread_by     = COALESCE(p_unread, unread_by),
         watchers      = COALESCE(p_watchers, watchers),
         last_modified = NOW()
   WHERE id = p_ticket_id;
END$$;
GRANT EXECUTE ON FUNCTION post_ticket_comment(UUID, JSONB, UUID[], UUID[]) TO authenticated, service_role;

-- ─── Document holds (Phase 5) ───────────────────────────────────
-- See migrations/20260612_phase5_holds.sql for the full design.
CREATE TABLE IF NOT EXISTS document_holds (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id           UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reason                TEXT NOT NULL,
  notes                 TEXT,
  expected_release_at   TIMESTAMPTZ,
  opened_by             UUID NOT NULL,
  opened_by_name        TEXT,
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by           UUID,
  released_by_name      TEXT,
  released_at           TIMESTAMPTZ,
  released_reason       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS document_holds_open_reason_uniq
  ON document_holds(document_id, reason) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS document_holds_active_doc_idx
  ON document_holds(document_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS document_holds_active_org_idx
  ON document_holds(org_id, opened_at DESC) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS document_holds_org_reason_idx
  ON document_holds(org_id, reason);
CREATE INDEX IF NOT EXISTS document_holds_org_released_idx
  ON document_holds(org_id, released_at) WHERE released_at IS NOT NULL;

-- ─── Milestones (Phase 7) ───────────────────────────────────────
-- See migrations/20260614_phase7_milestones.sql for the full design.
CREATE TABLE IF NOT EXISTS milestones (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id            UUID REFERENCES projects(id) ON DELETE SET NULL,
  document_id           UUID REFERENCES documents(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  weight                NUMERIC NOT NULL DEFAULT 1 CHECK (weight >= 0),
  planned_at            TIMESTAMPTZ NOT NULL,
  actual_at             TIMESTAMPTZ,
  first_completed_at    TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','in_progress','completed','missed','blocked')),
  linked_revision_label TEXT,
  linked_ticket_id      UUID REFERENCES tickets(id) ON DELETE SET NULL,
  source                TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual','p6','msproject','csv')),
  external_ref          TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  created_by            UUID NOT NULL,
  created_by_name       TEXT,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_by            UUID,
  completed_by          UUID,
  completed_by_name     TEXT,
  status_reason         TEXT
);
CREATE INDEX IF NOT EXISTS milestones_org_idx         ON milestones(org_id);
CREATE INDEX IF NOT EXISTS milestones_project_idx     ON milestones(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS milestones_document_idx    ON milestones(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS milestones_org_planned_idx ON milestones(org_id, planned_at);
CREATE INDEX IF NOT EXISTS milestones_org_source_idx  ON milestones(org_id, source);
CREATE UNIQUE INDEX IF NOT EXISTS milestones_external_ref_uniq
  ON milestones(org_id, source, external_ref) WHERE external_ref IS NOT NULL;

-- Phase B email notification queue + user prefs (see migrations/20260529_phase_b_notifications.sql)
CREATE TABLE IF NOT EXISTS email_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  resource_type TEXT,
  resource_id UUID,
  event_type TEXT NOT NULL,
  metadata JSONB,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','suppressed')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_notifications_pending_idx ON email_notifications(status, created_at) WHERE status IN ('queued','failed');
CREATE INDEX IF NOT EXISTS email_notifications_dedupe_idx ON email_notifications(to_user_id, resource_id, event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_mention BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_assignment BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_status_change BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_watched_activity BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_sla_warning BOOLEAN NOT NULL DEFAULT TRUE,
  inapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  digest_frequency TEXT NOT NULL DEFAULT 'instant' CHECK (digest_frequency IN ('instant','hourly','daily','never')),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- In-app notification inbox (the bell). One row per (recipient, event); read
-- state is per-user. Distinct from email_notifications (the outbound queue).
-- See migrations 20260621 / 20260723.
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  resource_type TEXT,
  resource_id TEXT,
  actor_user_id UUID,
  actor_name TEXT,
  metadata JSONB,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_org_resource_idx ON notifications(org_id, resource_type, resource_id, created_at DESC);

-- Generic watch/follow surface. One row per (user, resource); walked by the
-- notification fan-out to find recipients. See migrations 20260622 / 20260723.
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_resource_uniq ON subscriptions(user_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS subscriptions_resource_idx ON subscriptions(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);

-- Phase D3+D4 data-portability tables (see migrations/20260530_data_export_schedules.sql)
CREATE TABLE IF NOT EXISTS export_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('s3','r2','webhook')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  endpoint TEXT,
  region TEXT,
  bucket TEXT,
  prefix TEXT,
  access_key_id_encrypted TEXT,
  secret_access_key_encrypted TEXT,
  webhook_url TEXT,
  webhook_secret_encrypted TEXT,
  schedule_kind TEXT NOT NULL DEFAULT 'manual' CHECK (schedule_kind IN ('manual','daily','weekly','monthly')),
  schedule_hour_utc INT,
  schedule_day_of_week INT,
  schedule_day_of_month INT,
  next_run_at TIMESTAMPTZ,
  include_files BOOLEAN NOT NULL DEFAULT TRUE,
  retention_days INT,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  last_run_error TEXT,
  last_run_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);
CREATE INDEX IF NOT EXISTS export_destinations_org_idx ON export_destinations(org_id);
CREATE INDEX IF NOT EXISTS export_destinations_next_run_idx ON export_destinations(enabled, next_run_at) WHERE enabled = TRUE AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS export_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  destination_id UUID REFERENCES export_destinations(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','api')),
  triggered_by UUID,
  triggered_by_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  table_count INT,
  total_rows INT,
  file_count INT,
  total_bytes BIGINT,
  download_url TEXT,
  download_url_expires_at TIMESTAMPTZ,
  destination_path TEXT,
  destination_type TEXT,
  error_message TEXT,
  diagnostics JSONB,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INT
);
CREATE INDEX IF NOT EXISTS export_runs_org_idx ON export_runs(org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS export_runs_destination_idx ON export_runs(destination_id, started_at DESC);

CREATE TABLE IF NOT EXISTS sla_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL,
  default_days INT NOT NULL,
  warn_before_days INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, request_type)
);

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

-- Checkout Episodes — the checkout "ticket" (see migrations/20260729).
-- Opened by the first checkout on an idle document, joined by concurrent
-- checkouts, closed when the LAST active session ends. The live activity
-- thread is scoped to the active episode; closed episodes are sealed,
-- browsable history records. (Defined before checkout_sessions /
-- checkout_messages, which both reference it.)
CREATE TABLE IF NOT EXISTS checkout_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  library_id UUID REFERENCES libraries(id),
  seq INTEGER NOT NULL DEFAULT 1,                 -- per-document "Checkout #N"
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by TEXT,                                 -- TEXT: "system" is a valid actor
  opened_by_name TEXT,
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  closed_by_name TEXT,
  close_reason TEXT  -- 'checked_in' | 'force_released' | 'expired' | 'reconciled'
);

-- Core invariant, DB-enforced: at most one live episode per document.
CREATE UNIQUE INDEX IF NOT EXISTS checkout_episodes_one_active_per_document
  ON checkout_episodes(document_id) WHERE (status = 'active');
CREATE INDEX IF NOT EXISTS checkout_episodes_doc_idx ON checkout_episodes(document_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS checkout_episodes_org_idx ON checkout_episodes(org_id, status);

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
  ended_at TIMESTAMPTZ,
  -- Phase 3 collaboration fields (see migrations/20260527_projects_and_collaboration.sql)
  project_id UUID,                       -- nullable: ad-hoc checkouts have no project
  purpose TEXT,                          -- richer than `note`
  expected_release_at TIMESTAMPTZ,       -- soft deadline for stale warnings
  auto_expires_at TIMESTAMPTZ,           -- 24h cap for ad-hoc, NULL for project checkouts
  released_at TIMESTAMPTZ,
  released_by UUID,
  released_reason TEXT,
  -- Episode membership (see checkout_episodes / migrations/20260729)
  episode_id UUID REFERENCES checkout_episodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS checkout_sessions_document_id_idx ON checkout_sessions(document_id);
CREATE INDEX IF NOT EXISTS checkout_sessions_user_id_idx ON checkout_sessions(user_id);
CREATE INDEX IF NOT EXISTS checkout_sessions_project_idx ON checkout_sessions(project_id);
CREATE INDEX IF NOT EXISTS checkout_sessions_active_org_idx ON checkout_sessions(org_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS checkout_sessions_episode_idx ON checkout_sessions(episode_id);

-- Checkout Messages — the per-episode activity thread (chat / system events /
-- handoffs / proposals / questions / markup refs). Created originally outside
-- the migrations folder; canonical definition mirrors 20260620 + 20260727 +
-- 20260729. episode_id NULL = legacy pre-episode activity, shown only in the
-- "Earlier activity" history bucket.
CREATE TABLE IF NOT EXISTS checkout_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lock_id UUID,
  text TEXT NOT NULL,
  user_id TEXT NOT NULL,                          -- TEXT: "system" is a valid actor
  user_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  kind TEXT NOT NULL DEFAULT 'chat'
    CHECK (kind IN ('chat','system','handoff','proposal','question','answer','markup_ref')),
  metadata JSONB,
  parent_message_id UUID REFERENCES checkout_messages(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id TEXT,
  episode_id UUID REFERENCES checkout_episodes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS checkout_messages_doc_kind_idx
  ON checkout_messages(document_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS checkout_messages_parent_idx
  ON checkout_messages(parent_message_id);
CREATE INDEX IF NOT EXISTS checkout_messages_episode_idx
  ON checkout_messages(episode_id, created_at);

-- ─── Projects + collaboration (Phase 3) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','cancelled','archived')),
  owner_user_id UUID NOT NULL,
  owner_user_name TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  moc_reference TEXT,
  linked_ticket_id UUID,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  target_completion_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);
CREATE INDEX IF NOT EXISTS projects_org_status_idx ON projects(org_id, status);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_user_id);
CREATE INDEX IF NOT EXISTS projects_last_activity_idx ON projects(org_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  user_name TEXT,
  user_email TEXT,
  role TEXT NOT NULL DEFAULT 'collaborator' CHECK (role IN ('owner','collaborator','observer')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_project_idx ON project_members(project_id);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id);

CREATE TABLE IF NOT EXISTS project_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID,
  user_name TEXT,
  type TEXT NOT NULL,
  body TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_activity_project_idx ON project_activity(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS markup_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  checkout_session_id UUID,
  requested_by_user_id UUID NOT NULL,
  requested_by_name TEXT,
  requested_from_user_id UUID NOT NULL,
  requested_from_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','shared','declined','cancelled')),
  message TEXT,
  response TEXT,
  shared_markup_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS markup_requests_doc_idx ON markup_requests(document_id, status);
CREATE INDEX IF NOT EXISTS markup_requests_to_idx ON markup_requests(requested_from_user_id, status);
CREATE INDEX IF NOT EXISTS markup_requests_project_idx ON markup_requests(project_id);

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
ALTER TABLE checkout_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkout_messages ENABLE ROW LEVEL SECURITY;
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

-- Checkout Episodes (select/insert/update for active org members; any member
-- may close — collaborators, admins, and the maintenance sweep all do)
CREATE POLICY "checkout_episodes_org_select" ON checkout_episodes FOR SELECT
  USING (org_id IN (SELECT my_org_ids()));
CREATE POLICY "checkout_episodes_org_insert" ON checkout_episodes FOR INSERT
  WITH CHECK (org_id IN (SELECT my_org_ids()));
CREATE POLICY "checkout_episodes_org_update" ON checkout_episodes FOR UPDATE
  USING (org_id IN (SELECT my_org_ids()));

-- Checkout Messages (mirrors migrations/20260620 + 20260727)
CREATE POLICY "checkout_messages_org_select" ON checkout_messages FOR SELECT
  USING (org_id IN (SELECT my_org_ids()));
CREATE POLICY "checkout_messages_org_insert" ON checkout_messages FOR INSERT
  WITH CHECK (org_id IN (SELECT my_org_ids()));
CREATE POLICY "checkout_messages_own_update" ON checkout_messages FOR UPDATE
  USING (
    user_id::text = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = checkout_messages.org_id
        AND org_members.uid = auth.uid()
        AND org_members.role IN ('Admin','DocCtrl')
        AND org_members.status = 'active'
    )
  );

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
ALTER PUBLICATION supabase_realtime ADD TABLE checkout_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE checkout_episodes;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE collections;
ALTER PUBLICATION supabase_realtime ADD TABLE org_members;
ALTER PUBLICATION supabase_realtime ADD TABLE libraries;

-- ============================================================
-- DEFERRED FOREIGN KEYS (Phase 1 entity graph)
-- ============================================================
-- documents and assets carry plant/unit/system pointers. The
-- target tables are created later in this file (so inline REFERENCES
-- inside the documents table would forward-reference). Wrap the FK
-- additions in DO blocks so re-running schema.sql is idempotent.

DO $$
BEGIN
  -- documents FKs (documents always exists in schema.sql)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_plant_fk') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_plant_fk
      FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_unit_fk') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_unit_fk
      FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_system_fk') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_system_fk
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE SET NULL;
  END IF;

  -- assets FKs only if the assets table exists. The assets table is
  -- introduced in migrations/20260603_asset_registry.sql and is not
  -- (yet) folded into this schema.sql snapshot.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'assets') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_plant_fk') THEN
      ALTER TABLE assets ADD CONSTRAINT assets_plant_fk
        FOREIGN KEY (plant_id) REFERENCES plants(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_unit_fk') THEN
      ALTER TABLE assets ADD CONSTRAINT assets_unit_fk
        FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_system_fk') THEN
      ALTER TABLE assets ADD CONSTRAINT assets_system_fk
        FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE SET NULL;
    END IF;
  END IF;
END$$;
