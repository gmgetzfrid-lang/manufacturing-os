-- 20260707_teams.sql
-- Teams: named groups of users that can be used as a subject in document
-- ACLs (the `team` PermissionSubjectType already existed in the app but
-- had no backing table). An admin builds teams once, then grants whole
-- teams access to libraries/folders/files instead of naming each user.

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,                       -- hex or palette key for chips
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS teams_org_idx ON teams(org_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  uid UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  added_by UUID REFERENCES users(id),
  PRIMARY KEY (team_id, uid)
);
CREATE INDEX IF NOT EXISTS team_members_uid_idx ON team_members(uid);
CREATE INDEX IF NOT EXISTS team_members_org_idx ON team_members(org_id);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

-- Any org member can read teams in their org (needed to render ACLs).
CREATE POLICY "teams_org_read" ON teams FOR SELECT
  USING (org_id IN (SELECT my_org_ids()));
-- Only Admin/Manager manage teams.
CREATE POLICY "teams_admin_write" ON teams FOR ALL
  USING (org_id IN (
    SELECT org_id FROM org_members
    WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin', 'Manager')
  ));

CREATE POLICY "team_members_org_read" ON team_members FOR SELECT
  USING (org_id IN (SELECT my_org_ids()));
CREATE POLICY "team_members_admin_write" ON team_members FOR ALL
  USING (org_id IN (
    SELECT org_id FROM org_members
    WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin', 'Manager')
  ));

-- Team ids the current user belongs to (used by ACL enforcement below).
CREATE OR REPLACE FUNCTION my_team_ids()
RETURNS SETOF UUID LANGUAGE SQL SECURITY DEFINER STABLE AS $$
  SELECT team_id FROM team_members WHERE uid = auth.uid();
$$;
