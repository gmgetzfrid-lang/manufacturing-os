-- 20260618_document_number_unique.sql
--
-- Phase-0-aligned cleanup: prevent the same "typo causes silent DB
-- conflict" pattern on documents that bit us on assets earlier.
--
-- The schema until now placed no uniqueness constraint on
-- documents.document_number. A user could type "P-001-3" twice and
-- the DB would happily create two rows with identical numbers,
-- breaking the supersede-by-document_number lookup in
-- lib/revisions.ts and the SetManager replacement resolution.
--
-- This migration adds a partial unique index scoped to library —
-- different libraries can legitimately share document numbers (e.g.
-- HR's "P-001" is different from Engineering's "P-001"). Partial
-- because document_number is nullable on the documents table
-- (older or scratch rows may lack one).
--
-- Will fail if existing data has duplicates within a library. If
-- that happens in a non-wiped environment, the operator needs to
-- rename or delete the duplicates first — there's no automatic
-- "pick the survivor" rule we can apply that's universally correct.

CREATE UNIQUE INDEX IF NOT EXISTS documents_library_docnumber_uniq
  ON documents(library_id, document_number)
  WHERE document_number IS NOT NULL AND status NOT IN ('Archived', 'Superseded');

COMMENT ON INDEX documents_library_docnumber_uniq IS
  'Partial uniqueness on document_number within a library. Excludes Archived + Superseded so retired rows don''t block reuse of their number. Added to prevent silent typo-driven duplicate documents.';
