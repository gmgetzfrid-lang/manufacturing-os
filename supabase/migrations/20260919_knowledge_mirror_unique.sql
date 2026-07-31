-- 20260919_knowledge_mirror_unique.sql
--
-- Hardening from the KL-5 audit: one mirror per controlled document per
-- knowledge library, enforced by the database. Without this, a manual
-- "Sync now" racing the nightly cron could insert the same controlled
-- document twice — duplicate passages in answers. The sync treats the
-- resulting 23505 as "already there", so concurrent syncs are now safe.
--
-- Idempotent. Apply after 20260918.

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_mirror_unique_idx
  ON knowledge_documents (library_id, source_document_id)
  WHERE source_document_id IS NOT NULL;
