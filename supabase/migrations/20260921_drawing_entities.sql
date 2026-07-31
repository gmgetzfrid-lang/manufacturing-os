-- 20260921_drawing_entities.sql
--
-- DRAWING INTELLIGENCE — the structured layer under P&ID/drawing libraries.
-- Passage retrieval can find where something is WRITTEN; it cannot count
-- vessels or audit off-page connectors. This table holds what ingestion
-- EXTRACTS from drawing-like pages (sparse text = drawing, dense = prose):
--
--   kind 'equipment' — tag occurrences (V-3, P-101A, PSV-2001) with the
--                      page position, so "show me V-3" can jump and every
--                      census/register is computed, not guessed
--   kind 'ref'       — drawing-number references found on a sheet (the
--                      text behind off-page connectors and continuations),
--                      powering the broken/missing-reference audit
--
-- Service-role only: entities mirror ACL-protected documents; the drawing
-- API filters per caller through the real ACL engine, same as ask.
--
-- Idempotent. Apply after 20260920.

CREATE TABLE IF NOT EXISTS knowledge_page_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('equipment', 'ref')),
  tag TEXT NOT NULL,                       -- normalized (uppercase)
  raw TEXT,                                -- the text item it appeared in
  x REAL,                                  -- PDF text position (viewer jump)
  y REAL
);
CREATE INDEX IF NOT EXISTS knowledge_page_entities_lib_idx
  ON knowledge_page_entities (library_id, kind, tag);
CREATE INDEX IF NOT EXISTS knowledge_page_entities_doc_idx
  ON knowledge_page_entities (document_id, page);

ALTER TABLE knowledge_page_entities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge_page_entities FROM public, anon, authenticated;
