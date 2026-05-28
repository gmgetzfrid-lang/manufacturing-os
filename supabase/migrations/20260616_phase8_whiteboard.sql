-- 20260616_phase8_whiteboard.sql
--
-- Phase 8 — Turnaround Whiteboard.
--
-- Adds a single column (whiteboard_state) to the canonical assets
-- table. Each piece of equipment in the registry now carries one of
-- five operational states:
--
--   pending     — not yet started (default for any newly-created asset)
--   drafting    — documents are being authored / redlined
--   executing   — work is happening in the field
--   completed   — everything's done; sign-off captured
--   blocked     — something's preventing progress (parallel to a hold,
--                 but explicit at the equipment level)
--
-- Why a column on assets instead of a separate table:
--   - Each asset has exactly one current state.
--   - Audit events (EQUIPMENT_STATE_CHANGED) carry the full history;
--     we don't need a parallel history table.
--   - The board's hot read path is "all equipment in unit X by
--     current state" — a column with an index is the cheapest answer.
--
-- The "interactive plot plan / P&ID overlay" deliverable from the
-- directive is deferred to a future migration (would add a positions
-- table keyed on a plot-plan image asset). The grid view ships first.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS whiteboard_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (whiteboard_state IN ('pending','drafting','executing','completed','blocked'));

-- Covers the board's primary "active equipment by state in scope" query.
-- Excludes archived rows to keep the index small and the scans cheap.
CREATE INDEX IF NOT EXISTS assets_whiteboard_state_idx
  ON assets(org_id, whiteboard_state) WHERE archived = FALSE;

COMMENT ON COLUMN assets.whiteboard_state IS
  'Operational state for the Phase 8 turnaround whiteboard. One of pending/drafting/executing/completed/blocked. Defaults to pending on new assets.';
