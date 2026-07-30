-- 20260912_knowledge_mode.sql
--
-- Ask-mode toggle: 'library' answers come ONLY from the indexed documents
-- (page-cited); 'internet' answers come from the provider's live web tool /
-- model knowledge (web-cited) and are labeled as NOT from controlled docs.
-- Column also folded into 20260911 for fresh installs — this covers DBs
-- that ran 20260911 before the toggle existed. Idempotent either way.

ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS mode TEXT;
