-- 20260706_milestones_baseline.sql
--
-- Baseline / drift — the accountability layer.
--
-- When a plan is approved, we snapshot each task's planned start/finish
-- as its BASELINE. From then on the live planned_* dates move freely
-- (defer, extend, reflow), but the baseline stays put — so every view
-- can show "planned vs now" and the end-of-job report can prove exactly
-- where and how much the schedule drifted.
--
-- MS Project has baselines but buries them behind a menu and a separate
-- "set baseline" ceremony. We make it one button and make drift
-- glanceable. Strictly additive; NULL baseline = "not yet baselined".

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS baseline_start_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_finish_at TIMESTAMPTZ,
  -- When the baseline was captured + by whom (for the audit trail).
  ADD COLUMN IF NOT EXISTS baseline_set_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS baseline_set_by    UUID;

COMMENT ON COLUMN milestones.baseline_start_at  IS 'Approved-plan start. NULL until a baseline is captured. Live planned_start_at drifts from this.';
COMMENT ON COLUMN milestones.baseline_finish_at IS 'Approved-plan finish. NULL until a baseline is captured.';
COMMENT ON COLUMN milestones.baseline_set_at    IS 'When this row''s baseline was captured.';
