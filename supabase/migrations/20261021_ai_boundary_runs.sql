-- 20261021_ai_boundary_runs.sql
--
-- 1. libraries.ai_excluded — a whole Document Control library marked
--    "never send to AI". Every door that hands a document to a model checks
--    it alongside the per-document documents.ai_excluded: nothing in such a
--    library is mirrored into a knowledge library, read by vision or by the
--    drawing reader, or attached to an AI review. Flipping it on purges the
--    AI's copies at once (the documents themselves are untouched).
--
-- 2. estate_run_changes — the undo journal. Every change an AI run makes to
--    a drawing (its equipment column, the bridge's applied list, links,
--    registry items it created, the reading it replaced) is written here
--    with the BEFORE state, under a run id, so the run can be undone.
--    Written by the server only; Admin and Doc Control can read it.
--
-- Idempotent. Apply after 20261020.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS ai_excluded BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS estate_run_changes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  run_id       TEXT NOT NULL,
  run_label    TEXT,
  kind         TEXT NOT NULL,              -- 'census'
  document_id  UUID,
  change       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   UUID,
  created_by_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at    TIMESTAMPTZ,
  undone_by    UUID
);
CREATE INDEX IF NOT EXISTS estate_run_changes_run_idx ON estate_run_changes (org_id, run_id);
CREATE INDEX IF NOT EXISTS estate_run_changes_recent_idx ON estate_run_changes (org_id, created_at DESC);

ALTER TABLE estate_run_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS estate_run_changes_read ON estate_run_changes;
CREATE POLICY estate_run_changes_read ON estate_run_changes FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = estate_run_changes.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl')));
