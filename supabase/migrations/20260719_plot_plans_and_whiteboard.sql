-- 20260719_plot_plans_and_whiteboard.sql
--
-- Spatial navigation (the Phase 8 "plot-plan / P&ID overlay" the architecture
-- deferred) PLUS the equipment whiteboard_state it heat-maps against.
--
--   * assets.whiteboard_state — the five operational states from the Phase 8
--     spec (pending / drafting / executing / completed / blocked). Lets the
--     turnaround board and the plot-plan markers show, at a glance, where
--     every equipment item stands and advance it with one click.
--
--   * plot_plans — a background image (a plot plan, P&ID, or unit layout)
--     with asset markers placed on it. Markers live in JSONB as a point-in-
--     time list of { assetId, xPct, yPct } in 0..100 percentage coordinates
--     so the overlay survives image re-scaling and different display sizes.
--
-- Additive + idempotent.

-- ── Equipment operational state ─────────────────────────────────
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS whiteboard_state TEXT NOT NULL DEFAULT 'pending';

-- Defensive CHECK (added separately so re-runs don't fail if it exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'assets' AND constraint_name = 'assets_whiteboard_state_chk'
  ) THEN
    ALTER TABLE assets
      ADD CONSTRAINT assets_whiteboard_state_chk
      CHECK (whiteboard_state IN ('pending','drafting','executing','completed','blocked'));
  END IF;
END $$;

-- Range-scan index for "all equipment in state X" board reads.
CREATE INDEX IF NOT EXISTS assets_org_state_idx
  ON assets(org_id, whiteboard_state) WHERE archived = false;

-- ── Plot plans / spatial overlays ───────────────────────────────
CREATE TABLE IF NOT EXISTS plot_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,

  -- Optional scope so a plan can be filtered to a plant/unit/system.
  plant_id  UUID REFERENCES plants(id)  ON DELETE SET NULL,
  unit_id   UUID REFERENCES units(id)   ON DELETE SET NULL,
  system_id UUID REFERENCES systems(id) ON DELETE SET NULL,

  -- Storage PATH (not a signed URL) to the background image; presigned on read.
  image_path TEXT,
  image_width  INTEGER,
  image_height INTEGER,

  -- [{ assetId, xPct, yPct }] — percentage coords (0..100) over the image.
  markers JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);

CREATE INDEX IF NOT EXISTS plot_plans_org_idx ON plot_plans(org_id, updated_at DESC);

ALTER TABLE plot_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "plot_plans_member_all" ON plot_plans;
CREATE POLICY "plot_plans_member_all" ON plot_plans
  FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = plot_plans.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = plot_plans.org_id AND uid = auth.uid() AND status = 'active'));
