-- DIAGNOSE_full_state.sql
--
-- Run this in the Supabase SQL editor. Returns ONE row, one column,
-- a single JSON object containing everything I need to see the
-- current state of the database.
--
-- Copy the entire result cell back into chat.
--
-- Read-only. No writes, no locks of consequence.

WITH
-- 1. All public tables + row counts (approximate from pg_stats, fast)
tables_overview AS (
  SELECT jsonb_agg(jsonb_build_object(
    'table', t.table_name,
    'columns', (
      SELECT count(*) FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = t.table_name
    ),
    'rows_estimate', COALESCE((
      SELECT n_live_tup FROM pg_stat_user_tables
      WHERE relname = t.table_name AND schemaname = 'public'
    ), 0),
    'has_rls', COALESCE((
      SELECT relrowsecurity FROM pg_class
      WHERE relname = t.table_name AND relnamespace = 'public'::regnamespace
    ), false)
  ) ORDER BY t.table_name) AS data
  FROM information_schema.tables t
  WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
),

-- 2. Columns on the tables most likely to matter for current bugs
key_table_schemas AS (
  SELECT jsonb_object_agg(table_name, cols) AS data FROM (
    SELECT
      c.table_name,
      jsonb_agg(jsonb_build_object(
        'col', c.column_name,
        'type', c.data_type,
        'nullable', c.is_nullable,
        'default', c.column_default
      ) ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name IN (
        'libraries','documents','document_versions','collections',
        'checkout_sessions','checkout_messages','markup_requests',
        'projects','project_members','tickets','audit_logs',
        'assets','asset_photos','asset_types',
        'org_members','orgs','users',
        'milestones','document_holds','notes',
        'plants','units','systems'
      )
    GROUP BY c.table_name
  ) sub
),

-- 3. Every unique + check + FK constraint on the same key tables
key_constraints AS (
  SELECT jsonb_agg(jsonb_build_object(
    'table', tc.table_name,
    'constraint', tc.constraint_name,
    'type', tc.constraint_type,
    'columns', (
      SELECT jsonb_agg(kcu.column_name ORDER BY kcu.ordinal_position)
      FROM information_schema.key_column_usage kcu
      WHERE kcu.constraint_name = tc.constraint_name AND kcu.table_schema = 'public'
    ),
    'definition', pg_get_constraintdef(con.oid)
  ) ORDER BY tc.table_name, tc.constraint_type) AS data
  FROM information_schema.table_constraints tc
  JOIN pg_constraint con ON con.conname = tc.constraint_name
  WHERE tc.table_schema = 'public'
    AND tc.table_name IN (
      'libraries','documents','document_versions','collections',
      'checkout_sessions','checkout_messages','markup_requests',
      'projects','assets','audit_logs','tickets','milestones',
      'org_members','document_holds'
    )
),

-- 4. Indexes (esp. partial unique indexes that aren't in pg_constraint)
key_indexes AS (
  SELECT jsonb_agg(jsonb_build_object(
    'table', tablename,
    'index', indexname,
    'definition', indexdef
  ) ORDER BY tablename, indexname) AS data
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename IN (
      'libraries','documents','document_versions',
      'checkout_sessions','checkout_messages','markup_requests',
      'projects','assets','audit_logs','tickets'
    )
),

-- 5. RLS policies on the same surface
rls_policies AS (
  SELECT jsonb_agg(jsonb_build_object(
    'table', tablename,
    'policy', policyname,
    'cmd', cmd,
    'roles', roles,
    'using', qual,
    'with_check', with_check
  ) ORDER BY tablename, policyname) AS data
  FROM pg_policies WHERE schemaname = 'public'
),

-- 6. Library state — every library + its config relevant to recent bugs
libraries_state AS (
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'name', name,
    'org_id', org_id,
    'type', type,
    'custom_columns', custom_columns,
    'column_label_overrides', column_label_overrides,
    'uniqueness_keys', uniqueness_keys,
    'doc_count', (SELECT count(*) FROM documents d WHERE d.library_id = l.id),
    'active_doc_count', (SELECT count(*) FROM documents d WHERE d.library_id = l.id AND d.status NOT IN ('Archived','Superseded'))
  ) ORDER BY name) AS data
  FROM libraries l
),

-- 7. Last 20 documents created (so I can see what was uploaded)
recent_documents AS (
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'library_id', library_id,
    'document_number', document_number,
    'title', title,
    'rev', rev,
    'status', status,
    'uniqueness_key', uniqueness_key,
    'created_at', created_at,
    'created_by', created_by,
    'metadata_keys', (SELECT array_agg(k) FROM jsonb_object_keys(metadata) k)
  ) ORDER BY created_at DESC) AS data
  FROM (SELECT * FROM documents ORDER BY created_at DESC NULLS LAST LIMIT 20) d
),

-- 8. Documents that would currently collide (active dupes per uniqueness_key)
active_duplicates AS (
  SELECT jsonb_agg(jsonb_build_object(
    'library_id', library_id,
    'uniqueness_key', uniqueness_key,
    'count', cnt,
    'doc_numbers', doc_numbers
  )) AS data
  FROM (
    SELECT library_id, uniqueness_key, count(*) AS cnt,
           array_agg(document_number ORDER BY created_at) AS doc_numbers
    FROM documents
    WHERE uniqueness_key IS NOT NULL
      AND status NOT IN ('Archived','Superseded')
    GROUP BY library_id, uniqueness_key
    HAVING count(*) > 1
  ) d
),

-- 9. Documents with NULL uniqueness_key (would fall outside the constraint)
docs_without_key AS (
  SELECT jsonb_build_object(
    'count', count(*),
    'sample', (SELECT jsonb_agg(jsonb_build_object('id', id, 'doc', document_number, 'lib', library_id))
               FROM (SELECT id, document_number, library_id FROM documents WHERE uniqueness_key IS NULL LIMIT 10) s)
  ) AS data
  FROM documents WHERE uniqueness_key IS NULL
),

-- 10. Most recent audit-log rows so I can see what's been happening
recent_audit AS (
  SELECT jsonb_agg(jsonb_build_object(
    'action', action,
    'resource_type', resource_type,
    'resource_id', resource_id,
    'user_email', user_email,
    'user_role', user_role,
    'timestamp', timestamp,
    'details_keys', (SELECT array_agg(k) FROM jsonb_object_keys(COALESCE(details, '{}'::jsonb)) k)
  ) ORDER BY timestamp DESC) AS data
  FROM (SELECT * FROM audit_logs ORDER BY timestamp DESC NULLS LAST LIMIT 30) a
),

-- 11. Active checkout sessions
active_checkouts AS (
  SELECT jsonb_agg(jsonb_build_object(
    'id', id,
    'document_id', document_id,
    'user_name', user_name,
    'mode', mode,
    'project_id', project_id,
    'purpose', purpose,
    'started_at', started_at,
    'auto_expires_at', auto_expires_at
  ) ORDER BY started_at DESC) AS data
  FROM checkout_sessions WHERE status = 'active'
),

-- 12. Org / org_members overview (RLS depends on this)
org_overview AS (
  SELECT jsonb_build_object(
    'orgs', (SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name)) FROM orgs),
    'members_per_org', (
      SELECT jsonb_agg(jsonb_build_object('org_id', org_id, 'active_members', cnt))
      FROM (SELECT org_id, count(*) AS cnt FROM org_members WHERE status = 'active' GROUP BY org_id) m
    ),
    'org_members_columns', (
      SELECT jsonb_agg(jsonb_build_object('col', column_name, 'type', data_type))
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'org_members'
    )
  ) AS data
),

-- 13. Storage stats
storage_overview AS (
  SELECT jsonb_build_object(
    'documents_total', (SELECT count(*) FROM documents),
    'documents_active', (SELECT count(*) FROM documents WHERE status NOT IN ('Archived','Superseded')),
    'document_versions_total', (SELECT count(*) FROM document_versions),
    'checkout_messages_total', (SELECT count(*) FROM checkout_messages),
    'audit_logs_total', (SELECT count(*) FROM audit_logs),
    'assets_total', (SELECT count(*) FROM assets),
    'asset_photos_total', (SELECT count(*) FROM asset_photos)
  ) AS data
),

-- 14. Postgres version + extensions (useful for debugging)
pg_info AS (
  SELECT jsonb_build_object(
    'version', version(),
    'current_database', current_database(),
    'current_user', current_user,
    'extensions', (SELECT jsonb_agg(extname ORDER BY extname) FROM pg_extension)
  ) AS data
)

SELECT jsonb_pretty(jsonb_build_object(
  '_run_at',          now(),
  'pg_info',          (SELECT data FROM pg_info),
  'tables_overview',  (SELECT data FROM tables_overview),
  'key_table_schemas',(SELECT data FROM key_table_schemas),
  'key_constraints',  (SELECT data FROM key_constraints),
  'key_indexes',      (SELECT data FROM key_indexes),
  'rls_policies',     (SELECT data FROM rls_policies),
  'libraries_state',  (SELECT data FROM libraries_state),
  'recent_documents', (SELECT data FROM recent_documents),
  'active_duplicates',(SELECT data FROM active_duplicates),
  'docs_without_key', (SELECT data FROM docs_without_key),
  'recent_audit',     (SELECT data FROM recent_audit),
  'active_checkouts', (SELECT data FROM active_checkouts),
  'org_overview',     (SELECT data FROM org_overview),
  'storage_overview', (SELECT data FROM storage_overview)
)) AS state;
