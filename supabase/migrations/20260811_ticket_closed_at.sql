-- 20260811_ticket_closed_at.sql
-- Add a dedicated terminal-state clock for archive eligibility.
-- Additive + idempotent; safe on a live DB.
--
-- WHY: the closed-ticket archiver measured "quiet since" off last_modified, a
-- generic any-touch column. Posting/editing a comment on a CLOSED ticket bumps
-- last_modified (post_ticket_comment sets it), so a long-closed ticket that gets
-- the occasional note never ages into eligibility — the feature silently misses
-- exactly the tickets it exists to reclaim. closed_at is stamped once when the
-- ticket enters CLOSED/CANCELED (and cleared on reopen) by computeTransition, and
-- the selection brain measures quiet-since off COALESCE(closed_at, last_modified).

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Backfill existing terminal tickets so the feature works on historical data the
-- moment it ships. last_modified is the best available proxy for when they closed
-- (there's no prior signal); going forward the value is exact.
UPDATE tickets
   SET closed_at = COALESCE(last_modified, created_at)
 WHERE status IN ('CLOSED', 'CANCELED')
   AND closed_at IS NULL;

-- The produce/preview query filters (org_id, status), excludes archived, and
-- orders by closed_at. This index serves that hot path directly.
CREATE INDEX IF NOT EXISTS tickets_org_status_closed_idx
  ON tickets(org_id, status, closed_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN tickets.closed_at IS
  'When the ticket entered CLOSED/CANCELED. The archive-eligibility clock; distinct from last_modified so a post-close comment cannot reset it. Cleared on reopen.';
