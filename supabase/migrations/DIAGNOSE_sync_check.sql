-- DIAGNOSE_sync_check.sql
--
-- Paste into the Supabase SQL Editor and run. Returns one row, one
-- column ("status"), with a JSON object showing PASS/FAIL per recent
-- migration. Read-only.
--
-- Each check answers: "did the most recent migration in this area
-- get applied to this database?" Anything FAIL means you need to
-- run the migration file shown in the `expected` column.

SELECT jsonb_pretty(jsonb_build_object(

  -- Latest piece: 20260629 dropped assets.whiteboard_state.
  -- PASS = the column is GONE.
  '20260629_drop_whiteboard_state',
    CASE WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='assets'
        AND column_name='whiteboard_state'
    ) THEN 'PASS' ELSE 'FAIL — run 20260629_drop_whiteboard_state.sql' END,

  -- 20260623: document_shares (public tokenized share links)
  '20260623_document_shares',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='document_shares' AND column_name='token'
    ) THEN 'PASS' ELSE 'FAIL — run 20260623_document_shares.sql' END,

  -- 20260622: subscriptions (Watch button + bell notification fan-out)
  '20260622_subscriptions',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='subscriptions' AND column_name='resource_type'
    ) THEN 'PASS' ELSE 'FAIL — run 20260622_subscriptions.sql' END,

  -- 20260621: in-app notifications (bell icon + drawer)
  '20260621_in_app_notifications',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='notifications' AND column_name='read_at'
    ) THEN 'PASS' ELSE 'FAIL — run 20260621_in_app_notifications.sql' END,

  -- 20260620: checkout activity thread (kind, parent_message_id columns)
  '20260620_checkout_activity_thread',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='checkout_messages' AND column_name='kind'
    ) THEN 'PASS' ELSE 'FAIL — run 20260620_checkout_activity_thread.sql' END,

  -- 20260619: configurable uniqueness keys (libraries.uniqueness_keys + documents.uniqueness_key)
  '20260619_document_uniqueness_configurable',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='libraries' AND column_name='uniqueness_keys'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='documents' AND column_name='uniqueness_key'
    ) THEN 'PASS' ELSE 'FAIL — run 20260619_document_uniqueness_configurable.sql' END,

  -- 20260618: unique index on (library_id, document_number) for active docs
  '20260618_document_number_unique',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND tablename='documents'
        AND indexdef ILIKE '%uniqueness_key%'
    ) THEN 'PASS' ELSE 'FAIL — run 20260618_document_number_unique.sql' END,

  -- 20260617: notes (Quick Notes composer)
  '20260617_phase9_notes',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='notes'
    ) THEN 'PASS' ELSE 'FAIL — run 20260617_phase9_notes.sql' END,

  -- 20260614: milestones (project Gantt + inbox upcoming pills)
  '20260614_phase7_milestones',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='milestones'
    ) THEN 'PASS' ELSE 'FAIL — run 20260614_phase7_milestones.sql' END,

  -- 20260612: document_holds (hold queue)
  '20260612_phase5_holds',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='document_holds'
    ) THEN 'PASS' ELSE 'FAIL — run 20260612_phase5_holds.sql' END,

  -- 20260609: phase 1 normalization (document_assets join + project_documents join)
  '20260609_phase1_normalization',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='document_assets'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='project_documents'
    ) THEN 'PASS' ELSE 'FAIL — run 20260609_phase1_normalization.sql' END,

  -- 20260606: operational entity graph (plants/units/systems)
  '20260606_operational_entity_graph',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='plants'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='units'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='systems'
    ) THEN 'PASS' ELSE 'FAIL — run 20260606_operational_entity_graph.sql' END,

  -- 20260604: library_views (saved column choices + label overrides)
  '20260604_library_column_label_overrides',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='libraries' AND column_name='column_label_overrides'
    ) THEN 'PASS' ELSE 'FAIL — run 20260604_library_column_label_overrides.sql' END,

  -- 20260603: asset registry
  '20260603_asset_registry',
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='assets'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='asset_photos'
    ) THEN 'PASS' ELSE 'FAIL — run 20260603_asset_registry.sql' END,

  -- Core bootstrap — these existed before the visible migration tree
  -- but the app dies without them. Listed so you can see them PASS.
  'core_bootstrap',
    jsonb_build_object(
      'orgs',              (SELECT to_regclass('public.orgs') IS NOT NULL),
      'org_members',       (SELECT to_regclass('public.org_members') IS NOT NULL),
      'libraries',         (SELECT to_regclass('public.libraries') IS NOT NULL),
      'documents',         (SELECT to_regclass('public.documents') IS NOT NULL),
      'document_versions', (SELECT to_regclass('public.document_versions') IS NOT NULL),
      'checkout_sessions', (SELECT to_regclass('public.checkout_sessions') IS NOT NULL),
      'audit_logs',        (SELECT to_regclass('public.audit_logs') IS NOT NULL),
      'tickets',           (SELECT to_regclass('public.tickets') IS NOT NULL),
      'projects',          (SELECT to_regclass('public.projects') IS NOT NULL)
    ),

  -- Summary: count tables / RLS coverage
  'totals',
    jsonb_build_object(
      'public_tables',     (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),
      'tables_with_rls',   (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relrowsecurity=true),
      'policies_total',    (SELECT count(*) FROM pg_policies WHERE schemaname='public')
    )

)) AS status;
