-- 20261097_prj_roundG_import_identity.sql
--
-- projects Round G — PT SCH-3 / SCH-14 (GAP-403): import provenance.
--
-- Row identity for re-import is the 20260704 project-scoped unique index on
-- (org_id, project_id, source, external_ref). What changes in this round is
-- WHAT the importer writes into external_ref for a keyless CSV row: a hash of
-- the row's own content ("csv-key:<fnv1a>") instead of its position
-- ("csv-row:<n>"), so inserting a row above cannot re-point any other row.
-- Existing positional refs are NOT rewritten here — a position cannot be
-- mapped to content after the fact — they are inventoried (DEC-30) and the
-- next re-import of that file adds content-keyed rows beside them.
--
-- import_batch_id tags every row an import inserted or updated, so a
-- cancelled or interrupted import is visible and reversible (SCH-14).
--
-- NOT widening: no policy, grant or function changes. Apply after 20261066.

-- ── DEC-30 inventory, captured BEFORE the transaction ─────────────────────
CREATE TEMP TABLE prj_roundg_import_inventory AS
SELECT 'inventory: rows keyed by position (csv-row / msp-row) before this migration' AS check,
       COUNT(*)::text AS n
  FROM milestones
 WHERE external_ref LIKE 'csv-row:%' OR external_ref LIKE 'msp-row:%'
UNION ALL
SELECT 'inventory: projects holding position-keyed rows', COUNT(DISTINCT project_id)::text
  FROM milestones
 WHERE (external_ref LIKE 'csv-row:%' OR external_ref LIKE 'msp-row:%') AND project_id IS NOT NULL;

BEGIN;

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS import_batch_id TEXT;

COMMENT ON COLUMN milestones.import_batch_id IS
  'Tag of the schedule import that last inserted or updated this row. A cancelled import leaves its rows tagged so the partial state is visible and reversible.';

CREATE INDEX IF NOT EXISTS milestones_import_batch_idx
  ON milestones(import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMIT;

-- ── Verification + inventory (one result set) ────────────────────────────
SELECT 'milestones.import_batch_id exists' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'milestones' AND column_name = 'import_batch_id') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'milestones_import_batch_idx exists',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'milestones_import_batch_idx'),
       NULL
UNION ALL
SELECT 'milestones_external_ref_per_project_uniq still present (the identity rail)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'milestones_external_ref_per_project_uniq'),
       NULL
UNION ALL
SELECT "check", NULL::boolean, n FROM prj_roundg_import_inventory;
