-- 20260721_milestone_dependency_links.sql
--
-- Typed task dependencies (the full MS Project / Primavera P6 relationship
-- model): finish-to-start, start-to-start, finish-to-finish, start-to-finish,
-- each with a lead/lag in days.
--
-- `dependency_links` is a JSONB array of objects:
--   [{ "predId": "<milestone uuid>", "type": "FS"|"SS"|"FF"|"SF", "lagDays": 0 }, ...]
--
-- This supersedes the FS-only `depends_on` array (20260715) without dropping
-- it: the app dual-writes both, so older readers and the FS-only Gantt arrow
-- fallback keep working, while the engine (reflow, CPM, the linking editor)
-- uses the typed links. Soft refs (no FK) so import/AI can populate freely and
-- a deleted predecessor just drops out of the cascade. Additive + idempotent.
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS dependency_links JSONB NOT NULL DEFAULT '[]'::jsonb;
