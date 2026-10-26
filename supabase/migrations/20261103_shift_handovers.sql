-- 20261103_shift_handovers.sql
--
-- The turnover as decided and shipped. While it's a draft, the people at
-- the meeting mark exceptions on the report — "night could try this, crew
-- X" — and Ship freezes it: what was handed over, by whom, when. The next
-- shift's report reads it back ("asked nights to try 3 — 2 done").
--   shift_key  the shift the work is handed TO, "2026-10-26:night"
--   decisions  { [stepId]: { tryIt, crew, note, pctAtShip } }
--   snapshot   the update as shipped (what management was sent)

CREATE TABLE IF NOT EXISTS shift_handovers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shift_key        TEXT NOT NULL,
  decisions        JSONB NOT NULL DEFAULT '{}'::jsonb,
  shipped_at       TIMESTAMPTZ,
  shipped_by       UUID,
  shipped_by_name  TEXT,
  snapshot         JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID,
  UNIQUE (project_id, shift_key)
);

CREATE INDEX IF NOT EXISTS shift_handovers_project_idx ON shift_handovers(project_id, shift_key);

ALTER TABLE shift_handovers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shift_handovers_rw ON shift_handovers;
CREATE POLICY shift_handovers_rw ON shift_handovers
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = shift_handovers.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = shift_handovers.org_id AND uid = auth.uid() AND status = 'active'));

COMMENT ON TABLE shift_handovers IS 'Each shift turnover as decided and shipped: exceptions marked at the meeting (the other crew could try a step, which crew), and the update as sent.';
