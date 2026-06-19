-- 20260801_curated_collection_folder_scope.sql
--
-- Curated collections ("books") were scoped to the whole library, so a book
-- curated inside one folder showed up everywhere in that library. Scope each
-- book to a specific FOLDER (a row in `collections`) instead, so it only
-- appears when you're browsing that directory.
--
-- folder_id NULL = the library root. Every existing book has NULL here, so they
-- all stay visible at the top level exactly as before — only newly-created or
-- re-homed books become folder-scoped.

ALTER TABLE curated_collections
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES collections(id) ON DELETE CASCADE;

-- Folder-aware lookup index (replaces the old library-wide one in spirit; the
-- previous index is left in place — harmless and still useful for root lookups).
CREATE INDEX IF NOT EXISTS curated_collections_folder_idx
  ON curated_collections(library_id, folder_id, scope, pinned, sort_order);

COMMENT ON COLUMN curated_collections.folder_id IS
  'Folder (collections.id) this curated book is pinned to. NULL = library root. The library page only lists books whose folder_id matches the directory being viewed.';
