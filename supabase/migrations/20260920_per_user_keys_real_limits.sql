-- 20260920_per_user_keys_real_limits.sql
--
--   1. PER-USER API KEYS ONLY. The workspace ("org default") AI connection
--      is retired: every member brings their own key, period. Existing
--      org-default rows are deleted — they are no longer reachable by any
--      code path, and a dead secret should not sit in a table.
--   2. platform_settings — tiny service-role-only key/value store for
--      deployment-wide settings. First use: the hosting-plan storage
--      ceilings (R2 / database), editable from the admin storage page so a
--      plan upgrade is a 5-second UI change, not a redeploy. Usage is
--      always MEASURED; only the ceiling is a setting.
--   3. knowledge_chunks integrity: remove any duplicate (document, page,
--      seq) rows left by interrupted ingest retries, then lock uniqueness
--      in with an index. (The ingest engine is now idempotent per batch —
--      it clears a page range before rewriting it.)
--
-- Idempotent. Apply after 20260919.

-- ── 1. Workspace AI connections retired ──────────────────────────────────
DELETE FROM ai_connections WHERE user_id IS NULL;

-- ── 2. Deployment settings (service-role only) ───────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_settings FROM public, anon, authenticated;

-- ── 3. Chunk integrity: dedupe, then guard ───────────────────────────────
DELETE FROM knowledge_chunks a
  USING knowledge_chunks b
  WHERE a.document_id = b.document_id
    AND a.page = b.page
    AND a.seq = b.seq
    AND a.id > b.id;
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_doc_page_seq_idx
  ON knowledge_chunks (document_id, page, seq);
