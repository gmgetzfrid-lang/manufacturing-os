-- 20260802_curated_collection_backfill_folder.sql
--
-- Folder scoping (20260801) added curated_collections.folder_id, defaulting
-- every pre-existing book to NULL = library root. But those books were really
-- curated inside a folder — the old schema just never recorded which one. So a
-- book made in .../p&ids/crude-unit suddenly showed only at the library root.
--
-- Recover the intended home from the book's own contents: set folder_id to the
-- folder where most of its documents live. Only touches books still at NULL, so
-- anything explicitly placed (new books, or a book intentionally left at the
-- root) is left alone.

UPDATE curated_collections cc
SET folder_id = sub.folder_id,
    updated_at = NOW()
FROM (
  SELECT
    cci.collection_id AS curated_id,
    d.collection_id   AS folder_id,
    ROW_NUMBER() OVER (
      PARTITION BY cci.collection_id
      ORDER BY COUNT(*) DESC, MIN(cci.sort_order)
    ) AS rn
  FROM curated_collection_items cci
  JOIN documents d ON d.id = cci.document_id
  WHERE d.collection_id IS NOT NULL
  GROUP BY cci.collection_id, d.collection_id
) sub
WHERE cc.id = sub.curated_id
  AND sub.rn = 1
  AND cc.folder_id IS NULL;
