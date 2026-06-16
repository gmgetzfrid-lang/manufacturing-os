-- 20260801_project_controls_cost.sql
--
-- Project controls — the COST dimension.
--
-- The schedule layer (milestones) already gives us a time-based earned-value
-- rollup: SPI, percent-earned, baseline drift. What it deliberately left out
-- was cost — "we don't have cost, so SPI is the only index" (lib/milestones).
--
-- This adds the small cost model a controls manager needs to light up the
-- full EVM picture (CPI, CV, EAC, ETC, VAC, TCPI) without forcing per-task
-- cost entry: a blended labor rate turns the schedule's work-hours into
-- currency, a budget override pins the BAC, and an actual-cost-to-date figure
-- feeds the cost indices. Stored as one JSONB blob on the project so the model
-- can evolve (contingency, indirect rate, currency) without further DDL.
--
-- Shape of controls_config:
--   {
--     "blendedRate":    175,        -- currency per work-hour
--     "budgetOverride": 1250000,    -- optional manual BAC (else hours×rate)
--     "actualCost":     480000,     -- ACWP to date (null until logged)
--     "contingency":    90000,      -- management reserve, display only
--     "currency":       "USD",
--     "updatedAt":      "2026-08-01T00:00:00Z",
--     "updatedBy":      "<uuid>"
--   }
--
-- Strictly additive; NULL = "no cost model configured yet". The app degrades
-- gracefully on environments where this migration hasn't run (it falls back to
-- a per-browser local copy and says so), mirroring how the schedule shipped
-- ahead of its own columns.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS controls_config JSONB;

COMMENT ON COLUMN projects.controls_config IS
  'Project-controls cost model (blended rate, budget override, actual cost, contingency, currency). Drives the cost side of the EVM dashboard. NULL = not configured.';
