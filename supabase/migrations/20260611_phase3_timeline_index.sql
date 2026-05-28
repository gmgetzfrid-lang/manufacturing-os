-- 20260611_phase3_timeline_index.sql
--
-- Phase 3 completion — composite index on audit_logs.
--
-- lib/timeline.ts:getDocumentTimeline filters on
-- (resource_type='document', resource_id=<uuid>) and sorts by
-- timestamp DESC. The existing single-column audit_logs_resource_id_idx
-- matches resource_id alone, forcing the planner to filter on
-- resource_type and re-sort on timestamp at query time. With this
-- composite index the read becomes a single ordered range scan.
--
-- This was flagged in the Phase 0 weak-points list as deferred to
-- "the phase that produces real timeline load." Phase 3 is that
-- phase — every document inspector opens its history, every project
-- page renders its timeline, so audit_logs becomes a hot read path.
--
-- Pure additive index. No data touched. CREATE INDEX IF NOT EXISTS
-- makes it idempotent. CONCURRENTLY would be nicer in prod (avoids
-- write lock during the build) but it's not supported inside a
-- transaction block — Supabase's migration runner wraps everything
-- in a transaction, so we use the plain form. On a fresh org the
-- audit_logs table is small enough that the lock is invisible.

CREATE INDEX IF NOT EXISTS audit_logs_resource_timeline_idx
  ON audit_logs(resource_type, resource_id, timestamp DESC);
