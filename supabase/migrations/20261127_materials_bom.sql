-- Materials register: the bill of materials, corrections, and the warehouse.
--
-- 1. size and line_no: the BOM's SIZE column and each line's number on the
--    work order's bill of materials (lib/bom, lib/bomForm).
-- 2. corrections: what was ordered and had to be corrected, logged on the
--    line (what changed, whose miss, days and cost), counted in the
--    post-event review.
-- 3. The Warehouse role edits a project's materials register (and nothing
--    else on the project): can_edit_materials() is can_edit_project() or a
--    Warehouse member of the project's workspace.
--
-- Run after 20261119_project_materials.sql. Safe to run more than once.
-- Until it runs, the app saves a line without these and says so.

ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS size TEXT;
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS line_no INTEGER;
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS corrections JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN project_materials.size IS 'The bill of materials SIZE column.';
COMMENT ON COLUMN project_materials.line_no IS 'The line number on its work order''s bill of materials.';
COMMENT ON COLUMN project_materials.corrections IS 'Corrections to what was ordered: kind, cause, before, after, days lost, cost, note.';

CREATE OR REPLACE FUNCTION can_edit_materials(p_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT can_edit_project(p_project) OR EXISTS (
    SELECT 1 FROM projects p JOIN org_members om ON om.org_id = p.org_id
    WHERE p.id = p_project AND om.uid = auth.uid() AND om.status = 'active'
      AND (om.role = 'Warehouse' OR om.roles && ARRAY['Warehouse']::text[])
  )
$$;

DROP POLICY IF EXISTS project_materials_insert ON project_materials;
CREATE POLICY project_materials_insert ON project_materials FOR INSERT TO authenticated
  WITH CHECK (can_edit_materials(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_materials.project_id AND p.org_id = project_materials.org_id));
DROP POLICY IF EXISTS project_materials_update ON project_materials;
CREATE POLICY project_materials_update ON project_materials FOR UPDATE TO authenticated
  USING (can_edit_materials(project_id))
  WITH CHECK (can_edit_materials(project_id)
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_materials.project_id AND p.org_id = project_materials.org_id));
DROP POLICY IF EXISTS project_materials_delete ON project_materials;
CREATE POLICY project_materials_delete ON project_materials FOR DELETE TO authenticated
  USING (can_edit_materials(project_id));

NOTIFY pgrst, 'reload schema';
