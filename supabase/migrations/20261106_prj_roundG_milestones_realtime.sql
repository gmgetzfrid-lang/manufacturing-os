-- 20261106_prj_roundG_milestones_realtime.sql
--
-- projects Round G — PT SCH-7 (realtime half; notifications RT-12): put
-- `milestones` in the supabase_realtime publication.
--
--   components/projects/ScheduleTab.tsx subscribes to postgres_changes on
--   milestones so another planner's edits stream into an open board — but
--   no migration ever added the table to the publication, so no event was
--   ever delivered (the three ALTER PUBLICATION statements in the sequence
--   cover checkout_messages, notifications and checkout_episodes only).
--   The optimistic lock on apply_milestone_moves (20261098) is what stops a
--   stale write; this is what lets the board SEE the other writer's change.
--
--   * Idempotent: the table is added only when it is not already published —
--     the finding's own caveat is that it may have been added by hand in the
--     dashboard, and the inventory row below records which world this was.
--   * If the database has no supabase_realtime publication at all (a
--     non-Supabase Postgres), nothing is changed and the probe reads false.
--   * No REPLICA IDENTITY change: INSERT and UPDATE events carry the new row
--     (the board filters them on project_id server-side); under RLS a DELETE
--     event carries only the key whatever the replica identity, so the board
--     matches a deleted id against the rows it shows. FULL would only grow
--     the WAL for every schedule edit.
--   * Realtime delivers a row change only to subscribers whose RLS SELECT
--     admits the row (milestones_member_all), so nobody sees a row they could
--     not already read. NOT widening.

-- ── DEC-30 inventory, captured BEFORE the transaction ─────────────────────
CREATE TEMP TABLE prj_roundg_realtime_inventory AS
SELECT 'inventory: supabase_realtime publications present (1 = Supabase realtime available)' AS check,
       COUNT(*)::text AS n
  FROM pg_publication WHERE pubname = 'supabase_realtime'
UNION ALL
SELECT 'inventory: milestones already in supabase_realtime before this migration (1 = added by hand earlier)',
       COUNT(*)::text
  FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones'
UNION ALL
SELECT 'inventory: tables in supabase_realtime before this migration',
       COUNT(*)::text
  FROM pg_publication_tables WHERE pubname = 'supabase_realtime';

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.milestones;
  END IF;
END$$;

COMMIT;

-- ── Verification + inventory (one result set) ────────────────────────────
SELECT 'milestones is in the supabase_realtime publication' AS check,
       EXISTS (SELECT 1 FROM pg_publication_tables
                WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'milestones keeps row-level security (realtime delivers only rows a subscriber may read)',
       EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                WHERE ns.nspname = 'public' AND c.relname = 'milestones' AND c.relrowsecurity),
       NULL
UNION ALL
SELECT "check", NULL::boolean, n FROM prj_roundg_realtime_inventory;
