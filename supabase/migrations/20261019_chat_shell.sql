-- 20261019_chat_shell.sql
--
-- One chat, every source. The Ask tab (tool-calling controller) kept its
-- conversations in React state — gone on reload — and the library chat
-- kept only a question log. Both now share one conversation model:
--
--   chat_threads        — a conversation: its scope (library / tools /
--                         internet), the library it reads, who started it,
--                         pin + settle state, and per-thread instructions.
--   chat_messages       — the turns, in order. User turns carry their
--                         attachments; assistant turns carry the full reply
--                         payload (citations, tool steps, pending actions…)
--                         so a past conversation reopens exactly as it was.
--   chat_user_profiles  — the asker's standing context (discipline, units,
--                         default library). Plain, editable, visible.
--
-- knowledge_questions stays exactly as it is: it is still the retrieval
-- memory (ratings, proven ground, FTS) and every library ask still writes
-- it. The backfill below turns the existing log into threads so nothing
-- anyone asked before disappears from the new rail.
--
-- Additive + idempotent. Apply after 20261013_answer_feedback.sql.

-- ── Threads ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'library'
    CHECK (scope IN ('library', 'tools', 'internet')),
  -- Required for library/internet scopes (the ask route records against a
  -- library); NULL for the tool-calling controller.
  library_id UUID REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  -- Standing instructions for THIS conversation only. Appended to the
  -- system prompt on every turn; promotable to an Org Playbook by admins.
  instructions TEXT,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  -- Settled = answered and shelved. NULL = active.
  settled_at TIMESTAMPTZ,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_threads_org_recent_idx
  ON chat_threads (org_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS chat_threads_library_idx
  ON chat_threads (library_id, last_message_at DESC) WHERE library_id IS NOT NULL;

-- ── Messages ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- user: the question. assistant: the answer text.
  content TEXT NOT NULL DEFAULT '',
  -- assistant: the whole reply (citations, steps, pending, mentionedDocs,
  -- provider, model, mode, questionId, equipmentTable, missingDocs,
  -- retrieval, liveWeb, stoppedBecause, question).
  -- user: { focus, inputs } when the turn answered a clarify/need round.
  payload JSONB,
  -- user turns: [{ id, kind: 'image'|'pdf', name, path, size, mediaType }]
  -- Context for THIS chat only — never indexed, never a controlled document.
  attachments JSONB,
  user_id UUID,
  user_name TEXT,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'error')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Asked-before memory across every scope: the question (user turns, and
  -- the question copied onto its assistant turn) plus the answer.
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(content, '') || ' ' || coalesce(payload->>'question', ''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx
  ON chat_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_org_recent_idx
  ON chat_messages (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_messages_tsv_idx
  ON chat_messages USING GIN (search_tsv);

-- ── Asker profile ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_user_profiles (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  discipline TEXT,              -- "Mechanical / rotating equipment"
  units TEXT,                   -- "US customary" | "SI" | free text
  default_library_id UUID REFERENCES knowledge_libraries(id) ON DELETE SET NULL,
  notes TEXT,                   -- anything else the asker wants every answer to know
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_user_profiles ENABLE ROW LEVEL SECURITY;

-- Conversations are org knowledge — every active member reads them (the
-- question log always was). Starting one, renaming, pinning, settling: any
-- member; deleting: the person who started it or a controller.
DROP POLICY IF EXISTS chat_threads_select ON chat_threads;
CREATE POLICY chat_threads_select ON chat_threads FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = chat_threads.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS chat_threads_insert ON chat_threads;
CREATE POLICY chat_threads_insert ON chat_threads FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = chat_threads.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS chat_threads_update ON chat_threads;
CREATE POLICY chat_threads_update ON chat_threads FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = chat_threads.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS chat_threads_delete ON chat_threads;
CREATE POLICY chat_threads_delete ON chat_threads FOR DELETE USING (
  created_by = auth.uid() OR is_org_controller(org_id)
);

DROP POLICY IF EXISTS chat_messages_select ON chat_messages;
CREATE POLICY chat_messages_select ON chat_messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = chat_messages.org_id
          AND uid = auth.uid() AND status = 'active')
);
-- Turns are written by the chat route (service role). Members may insert
-- replayed turns (asked-before reuse) directly.
DROP POLICY IF EXISTS chat_messages_insert ON chat_messages;
CREATE POLICY chat_messages_insert ON chat_messages FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = chat_messages.org_id
          AND uid = auth.uid() AND status = 'active')
);
-- A confirmed action's outcome is written onto its turn by the person who
-- confirmed it — any member of the org may update.
DROP POLICY IF EXISTS chat_messages_update ON chat_messages;
CREATE POLICY chat_messages_update ON chat_messages FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = chat_messages.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS chat_messages_delete ON chat_messages;
CREATE POLICY chat_messages_delete ON chat_messages FOR DELETE USING (
  EXISTS (SELECT 1 FROM chat_threads t WHERE t.id = chat_messages.thread_id
          AND (t.created_by = auth.uid() OR is_org_controller(t.org_id)))
);

DROP POLICY IF EXISTS chat_user_profiles_own ON chat_user_profiles;
CREATE POLICY chat_user_profiles_own ON chat_user_profiles FOR ALL USING (
  user_id = auth.uid()
) WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM org_members WHERE org_id = chat_user_profiles.org_id
              AND uid = auth.uid() AND status = 'active')
);

-- ── Backfill: every past library conversation becomes a thread ───────────
-- Thread id = the knowledge thread_id where one exists, else the question's
-- own id (pre-thread history = one-turn conversations). Message ids are
-- derived deterministically from the question id so re-running is a no-op.
INSERT INTO chat_threads (id, org_id, scope, library_id, title, created_by, created_by_name, created_at, updated_at, last_message_at)
SELECT
  coalesce(q.thread_id, q.id) AS id,
  min(q.org_id::text)::uuid,
  CASE WHEN min(q.mode) = 'internet' THEN 'internet' ELSE 'library' END,
  min(q.library_id::text)::uuid,
  left((array_agg(q.question ORDER BY q.created_at))[1], 120),
  (array_agg(q.user_id ORDER BY q.created_at))[1],
  (array_agg(q.user_name ORDER BY q.created_at))[1],
  min(q.created_at), max(q.created_at), max(q.created_at)
FROM knowledge_questions q
WHERE q.answer IS NOT NULL
GROUP BY coalesce(q.thread_id, q.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO chat_messages (id, org_id, thread_id, role, content, payload, user_id, user_name, status, created_at)
SELECT
  uuid_in(md5('chat-user:' || q.id::text)::cstring),
  q.org_id, coalesce(q.thread_id, q.id), 'user', q.question, NULL,
  q.user_id, q.user_name, 'done', q.created_at
FROM knowledge_questions q
WHERE q.answer IS NOT NULL
ON CONFLICT (id) DO NOTHING;

INSERT INTO chat_messages (id, org_id, thread_id, role, content, payload, user_id, user_name, status, created_at)
SELECT
  uuid_in(md5('chat-assistant:' || q.id::text)::cstring),
  q.org_id, coalesce(q.thread_id, q.id), 'assistant', q.answer,
  jsonb_build_object(
    'kind', 'library',
    'question', q.question,
    'citations', coalesce(q.citations, '[]'::jsonb),
    'provider', q.provider, 'model', q.model,
    'mode', coalesce(q.mode, 'library'),
    'questionId', q.id
  ),
  q.user_id, q.user_name, 'done', q.created_at + interval '1 millisecond'
FROM knowledge_questions q
WHERE q.answer IS NOT NULL
ON CONFLICT (id) DO NOTHING;
