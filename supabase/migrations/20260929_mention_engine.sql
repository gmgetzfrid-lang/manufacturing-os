-- 20260929_mention_engine.sql
--
-- THE MENTION ENGINE — links derived from text, with the sentence attached.
--
-- Until now every edge in the org graph came from a row somebody created:
-- a tag extraction, a manual pin, a project attachment. That produces a map
-- that is technically correct and practically useless, because an edge with
-- no evidence is an edge nobody trusts. You click it, it says "document ↔
-- asset", and you're no wiser than before.
--
-- This is the Obsidian move, done properly for a plant. A background pass
-- reads the indexed text, matches it against the equipment dictionary
-- (tags + human aliases), and writes one row per (document, page, asset)
-- carrying THE SENTENCE THAT PROVES IT. The graph edge now answers "why?"
-- with a quote, the equipment hub becomes a live backlinks panel, and nobody
-- files anything into a folder ever again.
--
-- Two things this deliberately does NOT do:
--   * It does not invent equipment. Only assets already in the registry can
--     be mentioned, so the AI can't grow the plant.
--   * It does not silently promote low-confidence guesses. Below the
--     auto-link line a mention is evidence for a PROPOSAL, not a link.

-- ── 1. Mentions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

  -- Where the text lives. Knowledge documents are the indexed corpus; the
  -- controlled document is carried alongside when the knowledge doc mirrors
  -- one, so a mention can navigate to either surface.
  knowledge_document_id UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL DEFAULT 1,

  -- The evidence. This column is the entire reason the table exists.
  context_snippet TEXT NOT NULL,
  matched_text TEXT NOT NULL,

  -- How many times this asset appears on this page. A standard that names
  -- E-101 forty times is one link of strength forty, not forty links.
  mention_count INTEGER NOT NULL DEFAULT 1,

  -- 'tag' | 'human' | 'extraction' | 'vision' — see lib/mentionIndex.ts
  origin TEXT NOT NULL DEFAULT 'tag',
  confidence REAL NOT NULL DEFAULT 1.0,
  -- TRUE when a person made this link by hand; those never get swept away
  -- by a re-index.
  is_explicit BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT entity_mentions_has_source
    CHECK (knowledge_document_id IS NOT NULL OR document_id IS NOT NULL)
);

-- Re-indexing a page must replace its mentions, never duplicate them.
CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_unique_idx
  ON entity_mentions (asset_id, COALESCE(knowledge_document_id, document_id), page);

-- The two queries that matter, both hot:
--   asset → every document that mentions it   (the equipment hub)
--   document → every asset it mentions        (the graph edge set)
CREATE INDEX IF NOT EXISTS entity_mentions_asset_idx
  ON entity_mentions (org_id, asset_id, confidence DESC);
CREATE INDEX IF NOT EXISTS entity_mentions_kdoc_idx
  ON entity_mentions (org_id, knowledge_document_id);
CREATE INDEX IF NOT EXISTS entity_mentions_doc_idx
  ON entity_mentions (org_id, document_id);

ALTER TABLE entity_mentions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entity_mentions_read ON entity_mentions;
CREATE POLICY entity_mentions_read ON entity_mentions FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = entity_mentions.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
-- Writes are the indexer's job (service role). A person can pin an explicit
-- mention by hand; controllers only.
DROP POLICY IF EXISTS entity_mentions_write ON entity_mentions;
CREATE POLICY entity_mentions_write ON entity_mentions FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = entity_mentions.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = entity_mentions.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')));

-- ── 2. Asking the graph a question ───────────────────────────────────────
-- "Do I have any standards about pipe supports?"
--
-- The graph's search box was a label filter: it could only find a node whose
-- NAME contained your letters, which is useless for a question, because the
-- answer lives in the text and the node is called "PIP-STE-05121". This
-- searches the indexed corpus and hands back both the evidence AND the
-- document, so the caller can light up the right nodes on the map.
--
-- SECURITY: org-scoped, and restricted to libraries the caller can read via
-- the existing knowledge RLS. SECURITY INVOKER keeps that enforcement.
CREATE OR REPLACE FUNCTION graph_ask(
  p_org_id UUID,
  p_query TEXT,
  p_limit INTEGER DEFAULT 40
)
RETURNS TABLE (
  knowledge_document_id UUID,
  document_name TEXT,
  library_id UUID,
  page INTEGER,
  snippet TEXT,
  rank REAL
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.document_id,
         d.name,
         c.library_id,
         c.page,
         ts_headline('english', c.content, websearch_to_tsquery('english', p_query),
                     'MaxWords=42, MinWords=18, ShortWord=3, MaxFragments=2, FragmentDelimiter=" … "'),
         ts_rank(c.tsv, websearch_to_tsquery('english', p_query))::REAL
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
   WHERE c.org_id = p_org_id
     AND websearch_to_tsquery('english', p_query) IS NOT NULL
     AND c.tsv @@ websearch_to_tsquery('english', p_query)
   ORDER BY ts_rank(c.tsv, websearch_to_tsquery('english', p_query)) DESC, c.page
   LIMIT GREATEST(1, LEAST(p_limit, 200));
$$;

REVOKE ALL ON FUNCTION graph_ask(UUID, TEXT, INTEGER) FROM public, anon;
GRANT EXECUTE ON FUNCTION graph_ask(UUID, TEXT, INTEGER) TO authenticated;

-- ── 3. Audit memory (Pillar D) ───────────────────────────────────────────
-- So the connector audit stops re-reading sheets that haven't been revised.
-- Keyed by (sheet, revision): a new revision is new work, the same revision
-- never is.
CREATE TABLE IF NOT EXISTS drawing_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  sheet_number TEXT NOT NULL,
  revision_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('passed', 'broken_connectors', 'flagged', 'skipped')),
  audit_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS drawing_audit_logs_sheet_rev_idx
  ON drawing_audit_logs (org_id, sheet_number, revision_code);
CREATE INDEX IF NOT EXISTS drawing_audit_logs_doc_idx
  ON drawing_audit_logs (org_id, document_id);

ALTER TABLE drawing_audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS drawing_audit_logs_read ON drawing_audit_logs;
CREATE POLICY drawing_audit_logs_read ON drawing_audit_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = drawing_audit_logs.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
