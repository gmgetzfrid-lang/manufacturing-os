-- 20260620_checkout_activity_thread.sql
--
-- Build a unified activity thread per document checkout.
--
-- Today checkout_messages is just chat. We're widening it so the same
-- table can carry:
--   - chat        free-form messages (existing behavior)
--   - system      auto-generated events (started, checked in, etc.)
--   - handoff     a "leaving the document here" note posted on check-in
--   - proposal    a proactive draft / suggestion posted into the thread
--   - question    "is this the latest?" or any other ask
--   - answer      reply to a question (parent_message_id points at it)
--   - markup_ref  pointer to a markup_request row so the thread shows
--                 markup activity inline
--
-- We also make the messages document-scoped (not lock-scoped). A new
-- checkout against the same document keeps the conversation visible so
-- the next person sees the prior crew's notes.
--
-- The table itself may already exist in some envs (it predates the
-- migrations folder), so we use IF NOT EXISTS + ADD COLUMN IF NOT EXISTS
-- to be idempotent.

CREATE TABLE IF NOT EXISTS checkout_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  lock_id UUID,
  text TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat'
  CHECK (kind IN ('chat','system','handoff','proposal','question','answer','markup_ref'));

ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS parent_message_id UUID
  REFERENCES checkout_messages(id) ON DELETE SET NULL;
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE checkout_messages ADD COLUMN IF NOT EXISTS resolved_by_user_id TEXT;

CREATE INDEX IF NOT EXISTS checkout_messages_doc_kind_idx
  ON checkout_messages(document_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS checkout_messages_parent_idx
  ON checkout_messages(parent_message_id);

COMMENT ON COLUMN checkout_messages.kind IS
  'Discriminator. chat=user message, system=auto event, handoff=check-in note, proposal=proactive draft, question=ask, answer=reply, markup_ref=pointer to markup_requests row.';
COMMENT ON COLUMN checkout_messages.metadata IS
  'Kind-specific payload. For proposal: { title }. For markup_ref: { markup_request_id }. For question: { latest_check: true } when the canned "is this latest?" question is used.';
COMMENT ON COLUMN checkout_messages.parent_message_id IS
  'When kind=answer, points at the question it replies to.';

-- RLS — same org-member rule as the rest of the collab tables.
-- NOTE: org_members.uid is the auth.uid() column on this project, NOT
-- user_id. Match the convention used in all earlier migrations.
ALTER TABLE checkout_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkout_messages_org_select ON checkout_messages;
CREATE POLICY checkout_messages_org_select ON checkout_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = checkout_messages.org_id
        AND org_members.uid = auth.uid()
        AND org_members.status = 'active'
    )
  );

DROP POLICY IF EXISTS checkout_messages_org_insert ON checkout_messages;
CREATE POLICY checkout_messages_org_insert ON checkout_messages FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = checkout_messages.org_id
        AND org_members.uid = auth.uid()
        AND org_members.status = 'active'
    )
  );

DROP POLICY IF EXISTS checkout_messages_own_update ON checkout_messages;
CREATE POLICY checkout_messages_own_update ON checkout_messages FOR UPDATE
  USING (
    user_id = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = checkout_messages.org_id
        AND org_members.uid = auth.uid()
        AND org_members.role IN ('Admin','DocCtrl')
        AND org_members.status = 'active'
    )
  );
