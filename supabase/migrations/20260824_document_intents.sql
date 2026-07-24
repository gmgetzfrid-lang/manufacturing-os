-- 20260824_document_intents.sql
--
-- INTENT LAYER — the system records who is working on what, from which
-- revision, WITHOUT asking anyone to declare anything.
--
-- The binary lock ("checked out: yes/no") is too coarse to drive signaling:
-- it can't tell a glance from an edit, it misses everyone who never touches
-- the checkout button, and it records nothing about which revision a piece
-- of work started from (the root cause of the lost-update bug).
--
-- Every content touchpoint now writes an intent row, fire-and-forget:
--
--   viewer open (view)    → kind 'view'       decays 4h
--   download / print      → kind 'reference'  decays 72h  ('edit' if the
--                           actor holds a checkout on the doc)
--   viewer markup mode    → kind 'edit'       decays 24h, refreshed on use
--   checkout session      → kind 'edit'       pinned until check-in
--   ticket → DRAFTING     → kind 'edit'       decays with ticket activity
--
-- base_version_id (the revision the intent is anchored to) is the key field:
-- it feeds the publish contract's expected-base resolution and makes
-- "two people are editing from the same base" detectable BEFORE either
-- uploads. Overlap signals fire on edit×edit only — views never ping anyone.
--
-- Rows are cheap and disposable: refreshed in place per (doc,user,kind,source),
-- pruned by the maintenance cron once expired. This is operational signal,
-- not an audit record — audit_logs remains the journal.
--
-- Additive + idempotent. Apply manually in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS document_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  library_id UUID REFERENCES libraries(id),
  user_id UUID NOT NULL,
  user_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('view','reference','edit')),
  source TEXT NOT NULL CHECK (source IN ('viewer','download','print','checkout','ticket','declared','source_pull')),
  -- The revision this intent is anchored to (what the user's copy is based
  -- on). NULL when the document had no current version at capture time.
  base_version_id UUID REFERENCES document_versions(id) ON DELETE SET NULL,
  ticket_id UUID,
  session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- One live row per (doc, user, kind, source); repeats refresh it in place.
  UNIQUE (document_id, user_id, kind, source)
);

-- The hot read: "fresh edit intents on this document".
CREATE INDEX IF NOT EXISTS document_intents_doc_live_idx
  ON document_intents(document_id, kind, expires_at);
-- Org sweep for overlap detection + cron pruning.
CREATE INDEX IF NOT EXISTS document_intents_org_idx
  ON document_intents(org_id, kind, expires_at);
CREATE INDEX IF NOT EXISTS document_intents_expiry_idx
  ON document_intents(expires_at);

ALTER TABLE document_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_intents_org_select ON document_intents;
CREATE POLICY document_intents_org_select ON document_intents FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = document_intents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

-- You may only write intent rows about yourself.
DROP POLICY IF EXISTS document_intents_self_insert ON document_intents;
CREATE POLICY document_intents_self_insert ON document_intents FOR INSERT WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = document_intents.org_id
              AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

DROP POLICY IF EXISTS document_intents_self_update ON document_intents;
CREATE POLICY document_intents_self_update ON document_intents FOR UPDATE USING (
  user_id = auth.uid()
);

-- Own rows deletable (e.g. explicit "I'm done"); expired rows are pruned by
-- the cron via service role, which bypasses RLS.
DROP POLICY IF EXISTS document_intents_self_delete ON document_intents;
CREATE POLICY document_intents_self_delete ON document_intents FOR DELETE USING (
  user_id = auth.uid()
);

COMMENT ON TABLE document_intents IS
  'Ambient work-in-progress signal, captured automatically at every content touchpoint (viewer/download/checkout/ticket). base_version_id anchors the intent to the revision the user started from — feeds the publish contract and edit-overlap advisories. Decays via expires_at; pruned by the maintenance cron. Not an audit record.';
COMMENT ON COLUMN document_intents.base_version_id IS
  'documents.current_version_id at capture time — "what this person''s copy is based on".';
