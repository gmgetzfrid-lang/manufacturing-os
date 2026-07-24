-- 20260626_asset_files.sql
-- Linked drawings for tags — the "file reference" counterpart to asset_photos.
--
-- A tag column can be configured (custom_columns[].referenceKind = "files") so
-- its pills link to OTHER documents in the system — e.g. a circuit id whose pill
-- opens that circuit's scoped isometric — instead of an Asset-Registry photo
-- gallery. Each row links an asset (tag) to an existing document. Mirrors the
-- asset_photos table; like the rest of the asset registry, access is enforced at
-- the app layer (no RLS here).

CREATE TABLE IF NOT EXISTS asset_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  caption     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  metadata    JSONB DEFAULT '{}',
  UNIQUE (org_id, asset_id, document_id)   -- a doc links to a tag at most once
);
CREATE INDEX IF NOT EXISTS asset_files_asset_idx ON asset_files(asset_id, sort_order);
CREATE INDEX IF NOT EXISTS asset_files_document_idx ON asset_files(document_id);
CREATE INDEX IF NOT EXISTS asset_files_org_idx ON asset_files(org_id);
