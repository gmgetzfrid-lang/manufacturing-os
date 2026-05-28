-- 20260608_phase0_deprecation_markers.sql
--
-- Phase 0 stabilization — documentation-only migration.
--
-- Adds Postgres COMMENT metadata to the deprecated mirror columns
-- identified in the Phase 0 audit (see docs/ARCHITECTURE.md
-- "Canonical sources of truth"). COMMENT is read by `psql \d+`,
-- by Supabase Studio, and by any schema-introspection tool — future
-- contributors who look at the table see the deprecation note
-- without having to grep the codebase.
--
-- ZERO behavior change. No data touched. No constraints altered.
-- Pure metadata. Safe to run repeatedly (COMMENT is idempotent).

COMMENT ON COLUMN documents.revision IS
  'DEPRECATED mirror of documents.rev. No active reader. Future writers should set only `rev`. See docs/ARCHITECTURE.md.';

COMMENT ON COLUMN documents.revision_history IS
  'DEPRECATED legacy JSONB. Canonical revision history is the document_versions table. No active reader. See docs/ARCHITECTURE.md.';
