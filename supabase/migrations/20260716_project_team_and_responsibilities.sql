-- 20260716_project_team_and_responsibilities.sql
--
-- Richer project team model:
--   * project_members.responsibility — free text: what this member owns /
--     will own on the project.
--   * milestones.responsible_user_id / _name — assign a deliverable
--     (milestone) to a specific project member. Soft ref (no FK) so a
--     removed member just leaves a name behind; nullable.
-- Additive + idempotent.

ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS responsibility TEXT;

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS responsible_user_id   UUID,
  ADD COLUMN IF NOT EXISTS responsible_user_name TEXT;
