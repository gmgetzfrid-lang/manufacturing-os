-- 20260619_document_uniqueness_configurable.sql
--
-- Make document_number uniqueness configurable per library.
--
-- The 20260618 migration enforced (library_id, document_number) as the
-- uniqueness tuple. That broke real-world libraries where many
-- documents legitimately share a doc number (e.g. a P&ID set where
-- sheets 1..8 all carry the same number and "sheet" is the
-- differentiator).
--
-- New design:
--   - documents.uniqueness_key (TEXT, app-computed, lowercased)
--   - Unique partial index on (library_id, uniqueness_key)
--   - Application reads library.uniqueness_keys (TEXT[]) to compute
--     the key as the lowercased "::"-joined tuple of the configured
--     field values. Default is ["documentNumber"] — preserves the old
--     behavior for libraries that don't configure anything.
--   - Empty array on the library = no uniqueness enforced.

-- 1. Drop the old hardcoded constraint.
DROP INDEX IF EXISTS documents_library_docnumber_uniq;

-- 2. New uniqueness column.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS uniqueness_key TEXT;

-- 3. Library-level config: which field keys compose the tuple. NULL or
--    empty array = use the default behavior (documentNumber only).
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS uniqueness_keys TEXT[];

-- 4. Backfill existing rows so the new partial unique index can be
--    created without duplicate-row failures. Use the lowercased doc
--    number, matching the legacy semantics.
UPDATE documents
SET uniqueness_key = LOWER(document_number)
WHERE uniqueness_key IS NULL AND document_number IS NOT NULL;

-- 5. New partial unique index. Same status carve-out as before:
--    Archived/Superseded rows can share a key with active rows so
--    retired numbers can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS documents_library_uniqkey_uniq
  ON documents(library_id, uniqueness_key)
  WHERE uniqueness_key IS NOT NULL AND status NOT IN ('Archived', 'Superseded');

COMMENT ON COLUMN documents.uniqueness_key IS
  'App-computed lowercased tuple key for partial uniqueness within a library. Composed from the field values named in libraries.uniqueness_keys (default: just documentNumber). NULL opts the row out of the uniqueness check.';

COMMENT ON COLUMN libraries.uniqueness_keys IS
  'Field keys that compose the document uniqueness tuple. Default (NULL or empty) = documentNumber only. Use ["documentNumber","sheet"] to allow many sheets per number.';
