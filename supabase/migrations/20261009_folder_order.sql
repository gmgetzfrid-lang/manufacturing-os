-- Manual folder ordering. Folders were hard-sorted by name — documents can
-- be arranged, folders couldn't. sort_order is per parent; NULL sorts last
-- (alphabetical among themselves), so existing libraries keep their familiar
-- A-Z until someone drags a folder somewhere on purpose.
ALTER TABLE collections ADD COLUMN IF NOT EXISTS sort_order INTEGER;
CREATE INDEX IF NOT EXISTS collections_order_idx
  ON collections (library_id, parent_id, sort_order NULLS LAST, name);
