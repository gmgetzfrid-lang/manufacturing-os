-- 20260629_drop_whiteboard_state.sql
--
-- Reverses 20260616_phase8_whiteboard.sql.
--
-- The Turnaround Whiteboard feature has been removed. Its single
-- column (assets.whiteboard_state) and supporting index are no
-- longer referenced by any application code.
--
-- Why it was removed:
--   - The five states (pending/drafting/executing/completed/blocked)
--     duplicated truth that already lives elsewhere: document status
--     for "drafting", the Holds table for "blocked", and ticket
--     workflow for "executing/completed". Two writers to the same
--     truth, no sync logic, predictable drift.
--   - Tile clicks were inert: no notification, no assignment, no due
--     date, no link to the affected documents.
--   - The same questions are answered better by the Documents library
--     status filter, /admin/holds, the Project Gantt, and /inbox.
--
-- If a future "equipment lifecycle" view is wanted, the right design
-- is to derive state from document.status + open Holds + ticket
-- activity rather than maintain a parallel manual column.

DROP INDEX IF EXISTS assets_whiteboard_state_idx;

ALTER TABLE assets
  DROP COLUMN IF EXISTS whiteboard_state;
