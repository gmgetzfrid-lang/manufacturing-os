-- 20260622_subscriptions.sql
--
-- Generic "watch/follow" surface. One row per (user, resource).
-- When meaningful events happen on a resource (comment, revision,
-- status change), the notification fan-out walks this table to find
-- everyone subscribed and writes a row to `notifications` for each.
--
-- Tickets already had a `watchers` array on the row itself — that
-- still works for backwards compatibility but new resources (docs,
-- projects, assets) use this table so we don't bloat every resource
-- with a watchers column.

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  resource_type TEXT NOT NULL,         -- 'document' | 'project' | 'asset' | 'library'
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One subscription per (user, resource). Re-following is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_resource_uniq
  ON subscriptions(user_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS subscriptions_resource_idx
  ON subscriptions(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx
  ON subscriptions(user_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_own ON subscriptions;
CREATE POLICY subscriptions_own ON subscriptions FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Org members can SELECT all subscriptions in their org so the fan-out
-- query can find followers (which runs as the actor, not the recipient).
DROP POLICY IF EXISTS subscriptions_org_select ON subscriptions;
CREATE POLICY subscriptions_org_select ON subscriptions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = subscriptions.org_id
        AND org_members.uid = auth.uid()
        AND org_members.status = 'active'
    )
  );

COMMENT ON TABLE subscriptions IS
  'Generic watch/follow surface. One row per (user, resource). Walked by notification fan-out to find recipients on events.';
