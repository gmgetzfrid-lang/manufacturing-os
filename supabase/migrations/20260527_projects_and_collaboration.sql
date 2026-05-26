-- 20260527_projects_and_collaboration.sql
-- The collaboration layer that sits on top of checkouts.
--
-- A "project" is a unit of work that owns one or more checkouts. Anyone in
-- the org can see the project list and find out who's working on what.
-- Owners can opt a project into "private" visibility (members + admins only).
-- Ad-hoc (no-project) checkouts still exist for quick reviews and auto-expire
-- after 24 hours; project-tied checkouts live until released.

-- ─── projects ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','cancelled','archived')),

  -- Owner is the user who created or currently owns the project (transferable).
  owner_user_id UUID NOT NULL,
  owner_user_name TEXT,

  -- Visibility: 'public' = anyone in the org sees it; 'private' = members +
  -- admins only. Admins always see private projects in audit views.
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public','private')),

  -- Cross-references
  moc_reference TEXT,
  linked_ticket_id UUID,

  -- Schedule
  started_at TIMESTAMPTZ DEFAULT NOW(),
  target_completion_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_reason TEXT,

  -- Last activity drives "stale" warnings and sort order on the project list.
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);

CREATE INDEX IF NOT EXISTS projects_org_status_idx ON projects(org_id, status);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_user_id);
CREATE INDEX IF NOT EXISTS projects_last_activity_idx ON projects(org_id, last_activity_at DESC);

-- ─── project_members ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  user_name TEXT,
  user_email TEXT,
  role TEXT NOT NULL DEFAULT 'collaborator'
    CHECK (role IN ('owner','collaborator','observer')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_project_idx ON project_members(project_id);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id);

-- ─── project_activity ─────────────────────────────────────────────────────
-- Public activity feed: comments + system events. Anyone who can see the
-- project can read it; only members can comment. System events are written
-- by the helper library, never directly by the UI.
CREATE TABLE IF NOT EXISTS project_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID,
  user_name TEXT,
  -- Event types: 'comment' | 'checkout_added' | 'checkout_released' |
  -- 'member_joined' | 'member_left' | 'status_changed' | 'markup_requested' |
  -- 'markup_shared' | 'doc_added' | 'doc_removed' | 'ownership_transferred'
  type TEXT NOT NULL,
  body TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_activity_project_idx ON project_activity(project_id, created_at DESC);

-- ─── markup_requests ──────────────────────────────────────────────────────
-- "Hey, can I see your markups on this checked-out document?" A public,
-- threaded ask between users. Resolutions are visible on the project feed.
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

  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','shared','declined','cancelled')),

  message TEXT,
  response TEXT,
  shared_markup_url TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS markup_requests_doc_idx ON markup_requests(document_id, status);
CREATE INDEX IF NOT EXISTS markup_requests_to_idx ON markup_requests(requested_from_user_id, status);
CREATE INDEX IF NOT EXISTS markup_requests_project_idx ON markup_requests(project_id);

-- ─── checkout_sessions additions ──────────────────────────────────────────
-- Link a checkout to a project (nullable for ad-hoc). Capture richer
-- purpose text. Auto-expiry timestamp powers the 24h ad-hoc rule and the
-- soft stale-warning UI for project checkouts.
ALTER TABLE checkout_sessions
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS expected_release_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_by UUID,
  ADD COLUMN IF NOT EXISTS released_reason TEXT;

CREATE INDEX IF NOT EXISTS checkout_sessions_project_idx ON checkout_sessions(project_id);
CREATE INDEX IF NOT EXISTS checkout_sessions_active_org_idx
  ON checkout_sessions(org_id, status) WHERE status = 'active';
