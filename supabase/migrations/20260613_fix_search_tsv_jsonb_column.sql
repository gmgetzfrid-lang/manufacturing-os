-- 20260613_fix_search_tsv_jsonb_column.sql
--
-- BUGFIX for 20260607_search_foundation.sql.
--
-- The original documents_search_tsv_refresh() function referenced a
-- column named `val` inside its `jsonb_each_text(...)` subquery.
-- jsonb_each_text actually returns rows of (key text, value text) —
-- the column is `value`, not `val`. The function compiled fine
-- (Postgres doesn't validate column references in function bodies
-- until execution) but the first UPDATE to fire the trigger errored
-- with:
--
--   42703: column "val" does not exist
--
-- That UPDATE happened to be the migration's own backfill statement
-- (UPDATE documents SET title = title WHERE search_tsv IS NULL),
-- which aborted the CATCHUP run mid-way.
--
-- This migration:
--   1. Re-creates the function with the correct column name.
--   2. Re-runs the search_tsv backfill that the broken function
--      blocked.
--   3. Is idempotent — safe to run on an env that never hit the
--      bug (the corrected function is a no-op overwrite).

CREATE OR REPLACE FUNCTION documents_search_tsv_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  asset_tag_text TEXT;
  metadata_text  TEXT;
BEGIN
  asset_tag_text := COALESCE(
    (SELECT string_agg(elem->>'tag', ' ')
       FROM jsonb_array_elements(COALESCE(NEW.asset_tags, '[]'::jsonb)) AS elem
      WHERE elem ? 'tag'),
    ''
  );

  metadata_text := COALESCE(
    (SELECT string_agg(value, ' ')
       FROM jsonb_each_text(COALESCE(NEW.metadata, '{}'::jsonb))),
    ''
  );

  NEW.search_tsv :=
      setweight(to_tsvector('english', COALESCE(NEW.title, '')),           'A')
   || setweight(to_tsvector('english', COALESCE(NEW.document_number, '')), 'A')
   || setweight(to_tsvector('english', COALESCE(NEW.name, '')),            'A')
   || setweight(to_tsvector('english', COALESCE(NEW.rev, '')),             'B')
   || setweight(to_tsvector('english', COALESCE(NEW.status, '')),          'B')
   || setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B')
   || setweight(to_tsvector('english', asset_tag_text),                    'B')
   || setweight(to_tsvector('english', metadata_text),                     'C');

  RETURN NEW;
END$$;

-- Re-run the backfill. WHERE keeps it idempotent — rows whose
-- search_tsv was already populated by some other path are skipped.
UPDATE documents SET title = title WHERE search_tsv IS NULL;
