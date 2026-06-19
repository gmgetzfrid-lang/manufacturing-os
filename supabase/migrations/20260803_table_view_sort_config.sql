-- Per-folder default sort for the documents table.
--
-- table_views already stores the per-folder column layout (scoped by
-- org/user/library/collection, where collection = folder). This adds a
-- nullable sort_config so a folder can remember its own default row order
-- (e.g. "Sheet Number, ascending — sheet 1 at the top"). NULL = use the
-- app default. The application reads/writes this defensively, so it keeps
-- working whether or not this migration has been applied yet.

ALTER TABLE table_views
  ADD COLUMN IF NOT EXISTS sort_config JSONB DEFAULT NULL;
