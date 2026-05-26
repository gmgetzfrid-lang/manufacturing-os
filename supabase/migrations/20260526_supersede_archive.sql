-- 20260526_supersede_archive.sql
-- Phase 2 of document control: Supersede, Archive, Revert.
--
-- Supersede is document-level (one whole drawing is replaced by zero or more
-- *different* drawings — e.g. P-101 split into P-101A and P-101B). This is
-- distinct from Rev-Up, which is a new revision of the SAME drawing.
--
-- Revert is version-level and was already supported by the Phase 1 schema:
-- a new document_versions row gets reverted_from_version_id populated and
-- copies the file payload of the old revision. No schema change needed here.
--
-- Archive is a soft-delete on the document with reason + actor recorded.

-- Document-level supersession + archive metadata
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_user UUID,
  ADD COLUMN IF NOT EXISTS supersession_reason TEXT,
  ADD COLUMN IF NOT EXISTS supersession_moc TEXT;

-- Many-to-many: one retired drawing can be replaced by multiple new ones,
-- and one new drawing can supersede multiple legacy ones. Reason is captured
-- per-pairing so the audit can reconstruct "P-101 was replaced by P-101A
-- (north loop split) and P-101B (south loop split)".
CREATE TABLE IF NOT EXISTS document_supersessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  superseded_doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  replacement_doc_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reason TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (superseded_doc_id, replacement_doc_id)
);

CREATE INDEX IF NOT EXISTS document_supersessions_old_idx ON document_supersessions(superseded_doc_id);
CREATE INDEX IF NOT EXISTS document_supersessions_new_idx ON document_supersessions(replacement_doc_id);

-- Helps the default library list filter out archived rows fast.
CREATE INDEX IF NOT EXISTS documents_org_lib_status_idx ON documents(org_id, library_id, status);
