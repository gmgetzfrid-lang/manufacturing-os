-- 20260924_entity_positions.sql
--
-- WHERE a tag sits on the sheet, so the app can point at it.
--
-- Citations on a text document highlight by matching the quoted passage
-- against the PDF's text layer. On an AutoCAD P&ID that layer is empty (SHX
-- fonts plot as line-work) or meaningless, so "show me V-3 on the drawing"
-- had nothing to highlight — the sheet opened and the engineer hunted for
-- the tag by eye. That's half the tool missing.
--
-- Positions are stored NORMALIZED — 0..1 across the page, origin top-left —
-- so they survive any zoom, any render width, any page size, and can come
-- from either source:
--
--   text-layer sheets  → computed free at ingest from the text item's own
--                        coordinates (exact)
--   vision-read sheets → located on demand by the model when someone first
--                        asks to see that tag, then cached here forever
--                        (approximate, and labeled as such in the UI)
--
-- Idempotent. Apply after 20260923.

ALTER TABLE knowledge_page_entities
  ADD COLUMN IF NOT EXISTS nx REAL,          -- 0..1 from the left edge
  ADD COLUMN IF NOT EXISTS ny REAL,          -- 0..1 from the TOP edge
  -- 'text' = exact, from the PDF's own coordinates.
  -- 'vision' = approximate, located by the model on the rendered page.
  ADD COLUMN IF NOT EXISTS pos_source TEXT;

-- Lookups are always "this document, this page, these tags".
CREATE INDEX IF NOT EXISTS knowledge_page_entities_locate_idx
  ON knowledge_page_entities (document_id, page, tag);
