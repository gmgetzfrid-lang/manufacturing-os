-- 20260715_milestone_dependencies.sql
--
-- Explicit task dependencies (finish-to-start). A task's `depends_on` is a
-- JSONB array of predecessor milestone ids — it can't start until all of them
-- finish. Soft refs (no FK) so import/AI can populate freely and a deleted
-- predecessor just drops out of the cascade. Additive + idempotent.
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS depends_on JSONB NOT NULL DEFAULT '[]'::jsonb;
