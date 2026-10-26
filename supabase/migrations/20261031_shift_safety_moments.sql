-- 20261031_shift_safety_moments.sql
--
-- The turnover's safety moment: the next shift's riskiest kinds of work,
-- each with lessons from real incidents (and the page each came from).
-- One per project per shift, built once and seen by everyone on the
-- project, so the meeting, the printout and every tablet show the same
-- thing — and later moments can avoid repeating a lesson.
--
-- Written only by /api/projects/safety-moment (service role), which checks
-- membership and spends the builder's own AI key.

CREATE TABLE IF NOT EXISTS shift_safety_moments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The shift it is for (the one being planned at the turnover).
  shift_start    TIMESTAMPTZ NOT NULL,
  shift_kind     TEXT NOT NULL CHECK (shift_kind IN ('day', 'night')),
  note           TEXT,
  moment         JSONB NOT NULL,
  built_by       UUID,
  built_by_name  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, shift_start)
);

CREATE INDEX IF NOT EXISTS shift_safety_moments_org_idx ON shift_safety_moments(org_id, updated_at DESC);

ALTER TABLE shift_safety_moments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shift_safety_moments_read ON shift_safety_moments;
CREATE POLICY shift_safety_moments_read ON shift_safety_moments
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = shift_safety_moments.org_id AND uid = auth.uid() AND status = 'active'));
-- No insert / update / delete policy: only the route writes.
