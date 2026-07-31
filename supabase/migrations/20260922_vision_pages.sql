-- 20260922_vision_pages.sql
--
-- VISION INGESTION bookkeeping. Pages with no text layer — AutoCAD exports
-- whose SHX text plots as line-work rather than text objects, and scanned
-- sheets — are now READ by the model during indexing and transcribed into
-- the normal chunk/tag pipeline. This column records how many pages of a
-- document were read that way, so the UI can say "42 pages read by AI
-- vision" instead of leaving people wondering why indexing cost anything.
--
-- Idempotent. Apply after 20260921.

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS vision_pages INTEGER NOT NULL DEFAULT 0;
