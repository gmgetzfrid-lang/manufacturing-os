-- 20260723_notifications_unify.sql
-- Phase 1 of notification unification.
--
-- 1. Guarantees the in-app bell (`notifications`) and follow (`subscriptions`)
--    tables exist. They previously lived ONLY in 20260621 / 20260622, which
--    may never have been applied — that's why the bell shows nothing. This
--    re-creates them idempotently (safe if already present).
-- 2. Adds per-channel preference switches the unified dispatcher honors.
--
-- Fully idempotent + additive. Reversible:
--   ALTER TABLE notification_preferences DROP COLUMN inapp_enabled, DROP COLUMN push_enabled;
--   DROP TABLE subscriptions; DROP TABLE notifications;   (only if you want them gone)

-- ─── In-app notification inbox (the bell). Mirrors 20260621. ────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,                       -- recipient
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  resource_type TEXT,
  resource_id TEXT,
  actor_user_id UUID,
  actor_name TEXT,
  metadata JSONB,
  read_at TIMESTAMPTZ,                          -- null = unread
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_org_resource_idx ON notifications(org_id, resource_type, resource_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_own_select ON notifications;
CREATE POLICY notifications_own_select ON notifications FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS notifications_own_update ON notifications;
CREATE POLICY notifications_own_update ON notifications FOR UPDATE USING (user_id = auth.uid());
DROP POLICY IF EXISTS notifications_own_delete ON notifications;
CREATE POLICY notifications_own_delete ON notifications FOR DELETE USING (user_id = auth.uid());
-- Any active org member may insert a notification for any recipient in the org
-- (so a client action can fan out to others). Validated at the app layer.
DROP POLICY IF EXISTS notifications_org_insert ON notifications;
CREATE POLICY notifications_org_insert ON notifications FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.org_id = notifications.org_id
      AND org_members.uid = auth.uid()
      AND org_members.status = 'active'
  )
);

-- ─── Generic watch/follow surface. Mirrors 20260622. ────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  resource_type TEXT NOT NULL,                  -- 'document' | 'project' | 'asset' | 'library' | 'ticket'
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_user_resource_uniq ON subscriptions(user_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS subscriptions_resource_idx ON subscriptions(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_own ON subscriptions;
CREATE POLICY subscriptions_own ON subscriptions FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- Org members can read all subscriptions in their org so the fan-out (running
-- as the actor, not the recipient) can find followers.
DROP POLICY IF EXISTS subscriptions_org_select ON subscriptions;
CREATE POLICY subscriptions_org_select ON subscriptions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.org_id = subscriptions.org_id
      AND org_members.uid = auth.uid()
      AND org_members.status = 'active'
  )
);

-- ─── Per-channel preference switches for the unified dispatcher. ────────────
-- Default TRUE so existing users see no behavior change.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS inapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS push_enabled  BOOLEAN NOT NULL DEFAULT TRUE;
