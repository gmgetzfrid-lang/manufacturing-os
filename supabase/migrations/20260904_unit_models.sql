-- 20260904_unit_models.sql
--
-- OPERATING AREAS / 3D MODELS — laser-scan point clouds (and future model
-- kinds) attached to operating units, managed like every other controlled
-- artifact in the system:
--
--   * unit_models          — the model identity on a unit (name, description,
--                            kind, current-version pointer, archived state)
--   * unit_model_versions  — every uploaded model file is a VERSION with a
--                            supersede chain; two file slots per version:
--                              - copc_key:   the renderable stream (COPC) the
--                                            in-app 3D viewer plays
--                              - source_key: custody of the original scan
--                                            file (.rcs/.rcp/.e57/…) verbatim
--
-- Management (create/update/version/supersede/archive) is Admin/DocCtrl
-- ONLY — enforced here at the database, not just in the UI. Every member
-- can view. Full tracking rides audit_logs (UNIT_MODEL_* actions app-side).
--
-- Additive + idempotent. Apply after 20260903.

CREATE TABLE IF NOT EXISTS unit_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- 'point_cloud' today; the column keeps the door open for meshes/BIM.
  model_kind TEXT NOT NULL DEFAULT 'point_cloud'
    CHECK (model_kind IN ('point_cloud','mesh','bim')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  current_version_id UUID,
  created_by UUID NOT NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS unit_models_unit_idx ON unit_models(unit_id);
CREATE INDEX IF NOT EXISTS unit_models_org_idx  ON unit_models(org_id);

CREATE TABLE IF NOT EXISTS unit_model_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  model_id UUID NOT NULL REFERENCES unit_models(id) ON DELETE CASCADE,
  version_no INT NOT NULL,
  -- Renderable stream (Cloud-Optimized Point Cloud in R2).
  copc_key TEXT,
  copc_size BIGINT,
  point_count BIGINT,
  -- Source custody: the original scan file exactly as delivered.
  source_key TEXT,
  source_name TEXT,
  source_format TEXT,
  source_size BIGINT,
  -- When the scan was captured in the field (drives "how stale is this?").
  captured_at DATE,
  change_note TEXT,
  created_by UUID NOT NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  superseded_by UUID,
  UNIQUE (model_id, version_no)
);

CREATE INDEX IF NOT EXISTS unit_model_versions_model_idx
  ON unit_model_versions(model_id);
CREATE INDEX IF NOT EXISTS unit_model_versions_org_idx
  ON unit_model_versions(org_id);

ALTER TABLE unit_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_model_versions ENABLE ROW LEVEL SECURITY;

-- Every active member views; only controllers (Admin/DocCtrl) manage.
DROP POLICY IF EXISTS unit_models_select ON unit_models;
CREATE POLICY unit_models_select ON unit_models FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = unit_models.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS unit_models_write ON unit_models;
CREATE POLICY unit_models_write ON unit_models FOR ALL USING (
  is_org_controller(org_id)
) WITH CHECK (
  is_org_controller(org_id)
);

DROP POLICY IF EXISTS unit_model_versions_select ON unit_model_versions;
CREATE POLICY unit_model_versions_select ON unit_model_versions FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = unit_model_versions.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS unit_model_versions_write ON unit_model_versions;
CREATE POLICY unit_model_versions_write ON unit_model_versions FOR ALL USING (
  is_org_controller(org_id)
) WITH CHECK (
  is_org_controller(org_id)
);
