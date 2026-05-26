-- 20260526_document_version_control.sql
-- Phase 1 of the formal document-control system.
--
-- Adds the engineering-signoff and supersession-chain columns to
-- document_versions so we can implement Rev-Up, Supersede, and Revert
-- workflows with a full immutable audit chain. Each column is nullable
-- and additive — no existing row needs backfilling.
--
-- Apply with: psql $DATABASE_URL -f supabase/migrations/20260526_document_version_control.sql
-- (or via the Supabase SQL editor)

ALTER TABLE document_versions
  -- Chain of supersession: every new revision points to the version it replaced
  ADD COLUMN IF NOT EXISTS supersedes_version_id UUID REFERENCES document_versions(id),

  -- Engineering signoff chain. Stored as both the user UUID (for joins) and
  -- the display name captured at the moment of signoff (so the name on the
  -- record is immutable even if the user later changes their profile).
  ADD COLUMN IF NOT EXISTS drawn_by UUID,
  ADD COLUMN IF NOT EXISTS drawn_by_name TEXT,
  ADD COLUMN IF NOT EXISTS checked_by UUID,
  ADD COLUMN IF NOT EXISTS checked_by_name TEXT,
  ADD COLUMN IF NOT EXISTS approved_by_name TEXT,

  -- Lifecycle timestamps
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,

  -- Refinery-standard cross-references
  ADD COLUMN IF NOT EXISTS moc_reference TEXT,         -- Management of Change ticket #
  ADD COLUMN IF NOT EXISTS source_file_name TEXT,     -- e.g. "P-101_Rev3.dwg"

  -- Revert traceability: if this version was created by a Revert action,
  -- the original version it was reverted from is recorded here so the
  -- audit chain is never silent.
  ADD COLUMN IF NOT EXISTS reverted_from_version_id UUID REFERENCES document_versions(id),

  -- SHA-256 hash of the uploaded file. Lets the audit prove that the bytes
  -- attached to this revision haven't been swapped post-hoc.
  ADD COLUMN IF NOT EXISTS file_hash TEXT;

-- Speed up "show me the chain" queries
CREATE INDEX IF NOT EXISTS document_versions_supersedes_idx
  ON document_versions(supersedes_version_id);
CREATE INDEX IF NOT EXISTS document_versions_record_created_idx
  ON document_versions(record_id, created_at DESC);

-- The denormalized documents.revision_history JSONB is being retired in favor
-- of querying document_versions directly. The column stays for now so we don't
-- break legacy reads, but no new code should write to it.
COMMENT ON COLUMN documents.revision_history IS
  'DEPRECATED — use document_versions table instead. Retained for legacy reads only.';
