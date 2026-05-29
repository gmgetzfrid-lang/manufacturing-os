-- DIAGNOSE_milestones.sql
--
-- Paste into Supabase SQL Editor. Tells you:
--   1. whether the new hierarchy migration has been applied
--   2. how many milestones exist, by source
--   3. the most recent imports — with their project assignment
--   4. anything with NULL project_id (orphaned imports)
--
-- Read-only.

WITH cols AS (
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'milestones'
)
SELECT jsonb_pretty(jsonb_build_object(
  'migration_20260703_applied',
    (SELECT COUNT(*) = 7 FROM cols WHERE column_name IN (
       'parent_id','planned_start_at','actual_start_at','is_summary','outline_level','wbs','shift'
    )),
  'missing_columns',
    (SELECT array_agg(c) FROM (VALUES
       ('parent_id'),('planned_start_at'),('actual_start_at'),
       ('is_summary'),('outline_level'),('wbs'),('shift')
     ) AS v(c)
     WHERE c NOT IN (SELECT column_name FROM cols)),
  'milestones_by_source',
    (SELECT jsonb_object_agg(source, jsonb_build_object(
       'total', cnt, 'with_project', with_proj, 'no_project', no_proj
     )) FROM (
      SELECT source,
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE project_id IS NOT NULL) AS with_proj,
        COUNT(*) FILTER (WHERE project_id IS NULL) AS no_proj
      FROM milestones GROUP BY source
    ) s),
  'recent_imports',
    (SELECT jsonb_agg(jsonb_build_object(
      'id', id,
      'name', name,
      'source', source,
      'project_id', project_id,
      'project_name', (SELECT name FROM projects WHERE id = m.project_id),
      'planned_at', planned_at,
      'created_at', created_at
    ) ORDER BY created_at DESC)
    FROM (SELECT * FROM milestones ORDER BY created_at DESC NULLS LAST LIMIT 20) m),
  'orphaned_no_project',
    (SELECT COUNT(*) FROM milestones WHERE project_id IS NULL),
  'all_projects_with_counts',
    (SELECT jsonb_agg(jsonb_build_object(
      'project', p.name,
      'project_id', p.id,
      'milestone_count', (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id)
    ) ORDER BY p.name)
    FROM projects p
    WHERE EXISTS (SELECT 1 FROM milestones m WHERE m.project_id = p.id))
)) AS diagnosis;
