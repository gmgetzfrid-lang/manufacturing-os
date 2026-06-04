-- 20260718_milestone_first_completed_at.sql
--
-- Audit-integrity fix: preserve the ORIGINAL completion timestamp.
--
-- Before this, marking a milestone completed → reopening it → completing it
-- again overwrote `actual_at` with the new time, destroying the historical
-- completion date (and silently editing earned-value history).
--
-- `first_completed_at` records the first time a milestone was ever completed
-- and is never overwritten or cleared. On re-completion the app restores
-- `actual_at` from this column instead of stamping "now", so the canonical
-- completion date survives reopen/complete cycles. Additive + idempotent.

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS first_completed_at TIMESTAMPTZ;

-- Backfill: any milestone currently completed with an actual_at but no
-- recorded first completion adopts its current actual_at as the original.
UPDATE milestones
   SET first_completed_at = actual_at
 WHERE status = 'completed'
   AND actual_at IS NOT NULL
   AND first_completed_at IS NULL;
