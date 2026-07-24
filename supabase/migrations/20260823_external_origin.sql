-- 20260823_external_origin.sql
--
-- Documents of external origin. ISO 9001 §7.5.3 requires controlled documents
-- that ORIGINATE OUTSIDE the organization — OEM equipment manuals, API/ASME
-- standards, regulatory documents, vendor drawings, client specs — to be
-- identified and controlled. This records where a document came from and its
-- SOURCE's own identifier + edition, so you can tell a controlled external copy
-- from an internally-authored one and know which external edition you're holding.
--
-- Additive + idempotent. `origin` gets a constant default so this is a fast
-- metadata-only column add (no table rewrite). Dated after 20260822.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'internal'
  CHECK (origin IN ('internal', 'external'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS external_source TEXT;      -- e.g. 'API', 'Emerson', 'OSHA'
ALTER TABLE documents ADD COLUMN IF NOT EXISTS external_reference TEXT;   -- the source's own number, e.g. 'API 610'
ALTER TABLE documents ADD COLUMN IF NOT EXISTS external_edition TEXT;     -- the source's own edition/rev, e.g. '11th Ed'
ALTER TABLE documents ADD COLUMN IF NOT EXISTS external_url TEXT;         -- link to the source, if any

CREATE INDEX IF NOT EXISTS documents_external_origin_idx ON documents(org_id) WHERE origin = 'external';
