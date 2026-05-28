-- 20260621_in_app_notifications.sql
--
-- In-app notification feed for the bell icon. Distinct from
-- email_notifications, which is a delivery queue for outbound email;
-- this table is the user's persistent in-app inbox.
--
-- Every meaningful event in the product writes a row here for each
-- intended recipient: ticket comments, status changes, mentions,
-- checkout-conflict alerts, project-member changes, hold opens, etc.
-- The bell UI reads from here, badges unread count, and offers a
-- click-through link to the relevant resource.

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,                       -- recipient
  kind TEXT NOT NULL,                          -- ticket_comment | ticket_mention | ticket_status | checkout_conflict | project_member | hold_opened | …
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                                   -- e.g. /requests/<id>?focus=comment-<id>
  resource_type TEXT,                          -- ticket | document | project | …
  resource_id TEXT,
  actor_user_id UUID,                          -- who triggered it (null for system)
  actor_name TEXT,
  metadata JSONB,                              -- kind-specific payload
  read_at TIMESTAMPTZ,                         -- null = unread
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_org_resource_idx
  ON notifications(org_id, resource_type, resource_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Users can read and update (mark read) their own notifications.
DROP POLICY IF EXISTS notifications_own_select ON notifications;
CREATE POLICY notifications_own_select ON notifications FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_own_update ON notifications;
CREATE POLICY notifications_own_update ON notifications FOR UPDATE
  USING (user_id = auth.uid());

-- Org members can insert notifications for anyone in the org. This is
-- so a client-side action (post comment, open hold, etc.) can fan out
-- the notification to the recipient. The kind/body are validated at
-- the app layer.
DROP POLICY IF EXISTS notifications_org_insert ON notifications;
CREATE POLICY notifications_org_insert ON notifications FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = notifications.org_id
        AND org_members.uid = auth.uid()
        AND org_members.status = 'active'
    )
  );

-- Optional: let users hard-delete their own notifications. Useful for a
-- "clear all" UI action.
DROP POLICY IF EXISTS notifications_own_delete ON notifications;
CREATE POLICY notifications_own_delete ON notifications FOR DELETE
  USING (user_id = auth.uid());

COMMENT ON TABLE notifications IS
  'In-app notification inbox. One row per (recipient, event). Read state is per-user. Distinct from email_notifications which is the outbound-email queue.';
