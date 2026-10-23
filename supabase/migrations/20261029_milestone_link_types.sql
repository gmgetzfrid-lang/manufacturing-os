-- 20261029_milestone_link_types.sql
--
-- How each task waits on its predecessors. depends_on lists them; this says,
-- per predecessor, whether it's finish-to-start (the default when absent),
-- start-to-start, finish-to-finish or start-to-finish, and any lag in hours:
--   {"<predecessor id>": {"type": "SS", "lagHours": 12}}

ALTER TABLE milestones ADD COLUMN IF NOT EXISTS link_types JSONB;
COMMENT ON COLUMN milestones.link_types IS 'Per-predecessor link: {"<pred id>": {"type": "FS|SS|FF|SF", "lagHours": n}}. Missing = finish-to-start, no lag.';
