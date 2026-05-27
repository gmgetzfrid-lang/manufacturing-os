-- 20260602_documents_library_super.sql
-- Schema for all 5 phases of the documents-library upgrade.
--
-- Run this once; the UI for each phase ships in subsequent code pushes
-- but the schema is in place from the start so nothing needs migrating
-- mid-build.

-- ─── Phase 5: per-document admin sort order ─────────────────────────
-- Default sort becomes (sort_order ASC NULLS LAST, updated_at DESC) so
-- admin-pinned documents float to the top and the rest fall back to
-- recency. NULL = no explicit order, sort by date.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS sort_order INTEGER;

CREATE INDEX IF NOT EXISTS documents_sort_order_idx
  ON documents(library_id, sort_order)
  WHERE sort_order IS NOT NULL;

-- ─── Phase 3: per-user document favorites ───────────────────────────
CREATE TABLE IF NOT EXISTS document_favorites (
  user_id     UUID NOT NULL,
  document_id UUID NOT NULL,
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, document_id)
);
CREATE INDEX IF NOT EXISTS document_favorites_user_idx
  ON document_favorites(user_id, org_id);
CREATE INDEX IF NOT EXISTS document_favorites_doc_idx
  ON document_favorites(document_id);

-- ─── Phase 2: curated collections (admin "playbooks") + Phase 3
--   personal collections (scope='user') ─────────────────────────────
-- A curated collection is a named, ordered grouping of specific
-- documents from across the library. Think SharePoint's Document Sets
-- but smarter: ordered, with notes per item, and admins or individuals
-- can build them.
CREATE TABLE IF NOT EXISTS curated_collections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id   UUID REFERENCES libraries(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,                                          -- 'flow', 'reactor', etc.
  color        TEXT,                                          -- hex or palette key
  scope        TEXT NOT NULL DEFAULT 'org'
                CHECK (scope IN ('org','user')),
  owner_user_id UUID,                                         -- required if scope='user'
  sort_order   INTEGER,                                       -- order among collections
  pinned       BOOLEAN NOT NULL DEFAULT TRUE,                 -- show in hero strip
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_by   UUID,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS curated_collections_org_idx
  ON curated_collections(org_id);
CREATE INDEX IF NOT EXISTS curated_collections_library_idx
  ON curated_collections(library_id, scope, pinned, sort_order);
CREATE INDEX IF NOT EXISTS curated_collections_user_idx
  ON curated_collections(owner_user_id) WHERE scope = 'user';

CREATE TABLE IF NOT EXISTS curated_collection_items (
  collection_id UUID NOT NULL REFERENCES curated_collections(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL,
  sort_order    INTEGER NOT NULL,
  notes         TEXT,
  added_by      UUID,
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (collection_id, document_id)
);
CREATE INDEX IF NOT EXISTS curated_collection_items_order_idx
  ON curated_collection_items(collection_id, sort_order);

-- ─── Phase 4: saved views (admin defaults + per-user personal) ──────
-- A view = saved filter + sort + display config that can be applied
-- with one click. Org-scoped views are admin defaults; user-scoped
-- views are personal customizations.
CREATE TABLE IF NOT EXISTS library_views (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id     UUID REFERENCES libraries(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  scope          TEXT NOT NULL DEFAULT 'org'
                  CHECK (scope IN ('org','user')),
  owner_user_id  UUID,
  filter_config  JSONB DEFAULT '{}',         -- {status: ['IFC'], type: 'P&ID', etc}
  sort_config    JSONB DEFAULT '{}',         -- {key: 'updatedAt', dir: 'desc'}
  display_config JSONB DEFAULT '{}',         -- {columns: [...], density: 'compact'}
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  pinned         BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     UUID NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_by     UUID,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS library_views_library_scope_idx
  ON library_views(library_id, scope);
CREATE INDEX IF NOT EXISTS library_views_user_idx
  ON library_views(owner_user_id) WHERE scope = 'user';
