-- ─────────────────────────────────────────────────────────────────────────────
-- document-control Round F (P4 REVIEW) — REV-7: two ACTIVE rows on one
-- document cannot carry the same revision_label, branch or not.
--
-- 20260823's document_versions_active_label_uniq excluded branches
-- (WHERE superseded_at IS NULL AND is_branch = FALSE), so after a stale-base
-- conflict a branch could be published carrying the identical active label
-- as the controlled copy ("Rev 3" twice in Version History), and the RPC's
-- duplicate-label backstop (EXCEPTION WHEN unique_violation → 'duplicate_label'
-- in publish_revision, whose INSERT covers the branch row too) could never
-- fire for it. The index is re-created WITHOUT the branch exclusion under a
-- new name; the old index is dropped only once the new one exists.
--
-- DEC-30: if ANY document already holds two active rows with one label the
-- CREATE fails — the DO block downgrades that to a NOTICE, the 20260823
-- index (if present) is kept, and the probe below reads ok = false with the
-- duplicate count in the inventory. Reconcile those rows (supersede or
-- relabel the stale one) and re-run this file. Deployment check (REV-7
-- done-when 3): the first probe is the assertion that the index exists.
--
-- NARROWING (a label collision is now refused for branches too). Single
-- paste: temp-table inventory → BEGIN/DDL/COMMIT → one SELECT
-- (check text, ok boolean, n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _dc_f71_before AS
SELECT 'active (record_id, revision_label) pairs held by MORE THAN ONE row, branches included — must be 0 for the index to build' AS what, COUNT(*) AS n
  FROM (SELECT record_id, revision_label FROM document_versions
         WHERE superseded_at IS NULL GROUP BY record_id, revision_label HAVING COUNT(*) > 1) dup
UNION ALL
SELECT 'of those pairs, ones that involve a branch row (the REV-7 shape)', COUNT(*)
  FROM (SELECT record_id, revision_label FROM document_versions
         WHERE superseded_at IS NULL GROUP BY record_id, revision_label
        HAVING COUNT(*) > 1 AND bool_or(COALESCE(is_branch, FALSE))) dupb
UNION ALL
SELECT 'active branch rows (is_branch, not superseded)', COUNT(*)
  FROM document_versions WHERE superseded_at IS NULL AND COALESCE(is_branch, FALSE)
UNION ALL
SELECT '20260823 index present before apply (0 = it never built: duplicates existed then)', COUNT(*)
  FROM pg_indexes WHERE tablename = 'document_versions' AND indexname = 'document_versions_active_label_uniq';

BEGIN;

DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS document_versions_active_label_uniq_v2
    ON document_versions(record_id, revision_label)
    WHERE (superseded_at IS NULL);
  -- Only once the branch-inclusive index exists is the branch-excluding one
  -- redundant.
  DROP INDEX IF EXISTS document_versions_active_label_uniq;
EXCEPTION WHEN unique_violation OR others THEN
  RAISE NOTICE 'document_versions_active_label_uniq_v2 NOT created (duplicate active labels exist — see the inventory row): %. The 20260823 index, if present, is kept.', SQLERRM;
END$$;

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 3 (the first is the deployment check).
SELECT 'document_versions_active_label_uniq_v2 exists and covers branches (no is_branch term)' AS check,
       (SELECT COUNT(*) = 1 FROM pg_indexes
         WHERE tablename = 'document_versions' AND indexname = 'document_versions_active_label_uniq_v2'
           AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%(superseded_at IS NULL)%' AND indexdef NOT LIKE '%is_branch%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the branch-excluding 20260823 index is gone',
       NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'document_versions' AND indexname = 'document_versions_active_label_uniq'),
       NULL::text
UNION ALL
SELECT 'publish_revision still turns a unique_violation into status duplicate_label (the branch INSERT is inside that block)',
       (SELECT prosrc LIKE '%EXCEPTION WHEN unique_violation THEN%' AND prosrc LIKE '%''duplicate_label''%'
          FROM pg_proc WHERE proname = 'publish_revision'),
       NULL::text
UNION ALL
SELECT 'inventory (before apply): ' || what, NULL::boolean, n::text FROM _dc_f71_before
UNION ALL
SELECT 'inventory (after apply): active (record_id, revision_label) pairs held by more than one row', NULL::boolean,
       (SELECT COUNT(*) FROM (SELECT record_id, revision_label FROM document_versions
                               WHERE superseded_at IS NULL GROUP BY record_id, revision_label HAVING COUNT(*) > 1) dup)::text;
