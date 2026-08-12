-- Conversations, not one-shot questions.
--
-- Every ask was an island: the history panel stacked preview cards nobody
-- could reopen, and a follow-up question ("what about 1 inch?") started
-- from zero context. thread_id groups asks into conversations so a past
-- chat can be reopened in full and CONTINUED — the way every chat product
-- works, and the way people actually interrogate a standard.
ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS thread_id UUID;
CREATE INDEX IF NOT EXISTS knowledge_questions_thread_idx
  ON knowledge_questions (library_id, thread_id, created_at);
