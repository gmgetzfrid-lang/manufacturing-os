-- 20261007_line_traces.sql
--
-- CACHED LINE TRACES — the highlighter stroke over a P&ID.
--
-- Tracing a pipe run (X-32 → X-33) costs a vision call the first time.
-- The path doesn't change until the drawing revision does, so the waypoints
-- are cached per (document, page, from, to) and every later viewer draws
-- the same stroke for free. A new revision is a new knowledge_document row,
-- so stale traces die with the old row via the cascade.
--
-- The trace API works WITHOUT this table (it just re-traces each time);
-- applying it turns repeat traces free and instant.
--
-- Service-role only, same as knowledge_page_entities: traces mirror
-- ACL-protected documents and the API filters per caller.
--
-- Idempotent. Apply after 20260930.

CREATE TABLE IF NOT EXISTS knowledge_line_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  from_tag TEXT NOT NULL,                  -- normalized (uppercase)
  to_tag TEXT NOT NULL,
  points JSONB NOT NULL,                   -- ordered [{nx, ny}, ...], 0..1, origin top-left
  note TEXT,                               -- the model's caveat, verbatim
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_line_traces_key
  ON knowledge_line_traces (document_id, page, from_tag, to_tag);

ALTER TABLE knowledge_line_traces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge_line_traces FROM public, anon, authenticated;
