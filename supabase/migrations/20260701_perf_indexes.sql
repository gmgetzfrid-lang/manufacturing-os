-- 20260701_perf_indexes.sql
--
-- Cold-start performance indexes.
--
-- The auth boot path runs three sequential RLS-gated queries before
-- the UI renders: users(id), org_members(uid, status), and the
-- followup membership read. On the Supabase free / shared tier this
-- can spend several seconds on the FIRST query of a session because
-- there's no covering index on org_members.uid alone — only on the
-- composite primary key.
--
-- Adding a partial index over the hot filter (uid + status='active')
-- gives the planner a tiny seek on the boot path. Idempotent.

CREATE INDEX IF NOT EXISTS org_members_uid_active_idx
  ON org_members(uid)
  WHERE status = 'active';

-- org_configurations(org_id, key) lookups (drafting config, etc.)
-- are also on the cold-start path for some pages. Composite covers
-- the common .from('org_configurations').select('data').eq('org_id', X).eq('key', Y) shape.
CREATE INDEX IF NOT EXISTS org_configurations_org_key_idx
  ON org_configurations(org_id, key);
