-- 20260727_checkout_activity_fix.sql
-- The per-document checkout activity thread was effectively broken in two ways:
--   1. checkout_messages (and notifications) were never added to the realtime
--      publication, so posting a message pushed nothing — the thread looked
--      frozen and the toast listener never fired ("messages don't post").
--   2. depending on whether 20260620 was applied, the table could be missing
--      the kind/metadata/etc columns and/or the RLS policies, which would make
--      every insert fail.
--
-- This migration is idempotent and self-contained: it (re)asserts the columns
-- + RLS the app needs AND publishes the tables for realtime. Safe to run
-- regardless of prior state.

-- ─── Columns (mirrors 20260620; ADD COLUMN IF NOT EXISTS = no-op if present) ──
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS parent_message_id UUID;
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS resolved_by_user_id TEXT;

CREATE INDEX IF NOT EXISTS checkout_messages_doc_kind_idx ON checkout_messages(document_id, kind, created_at DESC);

-- ─── RLS (active org members read + post; author/Admin/DocCtrl update) ────────
ALTER TABLE checkout_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkout_messages_org_select ON checkout_messages;
CREATE POLICY checkout_messages_org_select ON checkout_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = checkout_messages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

DROP POLICY IF EXISTS checkout_messages_org_insert ON checkout_messages;
CREATE POLICY checkout_messages_org_insert ON checkout_messages FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = checkout_messages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

DROP POLICY IF EXISTS checkout_messages_own_update ON checkout_messages;
CREATE POLICY checkout_messages_own_update ON checkout_messages FOR UPDATE USING (
  user_id::text = auth.uid()::text
  OR EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = checkout_messages.org_id
             AND org_members.uid = auth.uid() AND org_members.role IN ('Admin','DocCtrl')
             AND org_members.status = 'active')
);

-- ─── Realtime: publish the tables the live UIs subscribe to ──────────────────
-- (idempotent — only ADD if not already published).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'checkout_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE checkout_messages;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END$$;

-- FULL replica identity so UPDATE/DELETE realtime rows carry the filtered cols.
ALTER TABLE checkout_messages REPLICA IDENTITY FULL;
ALTER TABLE notifications REPLICA IDENTITY FULL;
