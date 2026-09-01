-- Document-control Phase 7e — a pending distribution ack closes when it
-- stops binding (DIST-4).
--
-- distribution_acks rows are keyed to a version_id, and nothing closed them
-- when the document revved forward or retired. The recipient's confirm bar
-- is (correctly) scoped to the CURRENT version, so a Rev-4 row after Rev 5
-- issued was IMMORTAL: it sat in the inbox forever, the cron re-nagged it
-- every 3 days and escalated every 10, and the register's "unconfirmed"
-- pill counted it permanently — while the button that would clear it could
-- never render. Operators learn to ignore the prompt, which is the failure
-- mode acknowledged distribution exists to prevent.
--
-- App half (already on the branch): publish and supersede now stamp
-- superseded_at on out-of-currency pending rows, and every reader (inbox,
-- cron, register, revision impact) scopes to the document's current
-- version. This adds the column and closes the EXISTING orphans.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

ALTER TABLE distribution_acks ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
COMMENT ON COLUMN distribution_acks.superseded_at IS
  'Set when the obligation stopped binding (its version left currency, or the document retired) while still unacknowledged. Acknowledged rows never carry it — they are completed history.';

-- Backfill: close every existing orphan — a pending ack whose version is no
-- longer the document''s current version, or whose document is retired.
UPDATE distribution_acks a SET superseded_at = NOW()
FROM documents d
WHERE d.id = a.document_id
  AND a.acknowledged_at IS NULL
  AND a.superseded_at IS NULL
  AND (a.version_id IS DISTINCT FROM d.current_version_id
       OR d.status IN ('Superseded', 'Void', 'Archived'));

COMMIT;

-- ── Verification (read-only) — expect true / 0 ──────────────────────────────
SELECT 'superseded_at column exists' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'distribution_acks'
                 AND column_name = 'superseded_at')::text AS result
UNION ALL
SELECT 'orphaned pending acks remaining',
       (SELECT COUNT(*) FROM distribution_acks a
         JOIN documents d ON d.id = a.document_id
        WHERE a.acknowledged_at IS NULL
          AND a.superseded_at IS NULL
          AND (a.version_id IS DISTINCT FROM d.current_version_id
               OR d.status IN ('Superseded', 'Void', 'Archived')))::text;
