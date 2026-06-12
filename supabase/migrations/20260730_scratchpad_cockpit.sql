-- 20260730_scratchpad_cockpit.sql
--
-- Scratchpad cockpit: capture provenance + per-task metadata.
--
-- raw_body  — the VERBATIM text the user originally captured, preserved
--             before the organizer restructured it into the note body.
--             Powers flip-to-verify ("what I actually wrote"). NULL for
--             notes typed directly in structured form.
-- task_meta — per-task metadata that doesn't belong in the visible text,
--             keyed by taskKeyFor() (normalized task text):
--               { [taskKey]: { "snoozes": int } }
--             Drives the "snoozed 4x — still real?" callout. Orphaned
--             keys (task text edited) are harmless and ignored.
--
-- The app degrades gracefully when this migration hasn't run: captures
-- save without raw provenance and snooze counts are simply not shown.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS raw_body text;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS task_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN notes.raw_body IS 'Verbatim original capture before organizeCapture() restructured it (flip-to-verify).';
COMMENT ON COLUMN notes.task_meta IS 'Per-task metadata keyed by taskKeyFor(): { [key]: { snoozes: int } }.';
