-- 20261024_knowledge_retire.sql
--
-- "Retired" index entries: when a document leaves a knowledge library's
-- linked sources (moved out, held back from AI, archived, deleted), its
-- index — pages, tags, meaning-index vectors — is SET ASIDE instead of
-- deleted. Every search function only reads status 'ready'/'indexing', so a
-- retired entry is never searched or cited. If the document comes back
-- (moved back, moved into another linked library, re-included), the sync
-- restores it as it was and nothing is paid for twice.
--
-- Idempotent. Until this runs, the sync keeps its old behaviour (delete).

ALTER TABLE knowledge_documents DROP CONSTRAINT IF EXISTS knowledge_documents_status_check;
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_status_check
  CHECK (status IN ('pending', 'indexing', 'ready', 'stale', 'error', 'retired'));

ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS retired_reason TEXT;

CREATE INDEX IF NOT EXISTS knowledge_documents_retired_idx
  ON knowledge_documents (org_id, source_document_id) WHERE status = 'retired';

-- "Last changed", so the health check can tell a document that's being read
-- right now from one that started reading and never finished ("stuck").
ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE OR REPLACE FUNCTION knowledge_documents_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_knowledge_documents_touch ON knowledge_documents;
CREATE TRIGGER trg_knowledge_documents_touch
  BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION knowledge_documents_touch();
