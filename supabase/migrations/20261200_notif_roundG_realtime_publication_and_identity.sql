-- ─────────────────────────────────────────────────────────────────────────────
-- 20261200_notif_roundG_realtime_publication_and_identity.sql
--
-- notifications Round G — N4 FEED-PROVIDER-AND-REALTIME: the realtime
-- replica-identity gap (RT-4), the publication gap (RT-12), and the
-- per-category pop-up toast switches (RT-10's remaining limb).
--
--   RT-4   A DELETE's old record carries only the primary key under the
--          default replica identity, so a realtime subscription filtered on
--          any other column (library_id, document_id, org_id) never receives
--          a DELETE: a hard-deleted document, a released checkout session or
--          a removed library stayed on another viewer's screen until reload.
--          The team fixed this once (collections' unfiltered companion
--          listener, lib/libraryCollections.ts) and never generalised it.
--   RT-12  Two subscribed tables were never put in supabase_realtime:
--          milestones (projects Round G added it — 20261106) and table_views.
--   RT-10  The toast listener honours one master switch (toast_enabled,
--          20261148); there was no per-category switch.
--
-- What this file does:
--   · REPLICA IDENTITY FULL on documents, checkout_sessions, libraries and
--     collections — every published table with a DELETE-capable path whose
--     subscriptions filter on a non-key column (RT-4 done-when 1). Idempotent
--     (re-running sets the same identity). Cost: the WAL logs each changed
--     row's whole old image on UPDATE and DELETE of these four tables.
--     Supabase strips a DELETE's old record to the primary key for a table
--     with row-level security, so what a subscriber receives is unchanged —
--     only the filter can now match it.
--   · tickets is NOT set to FULL (DEC-44 (N4-feed-provider) §4): its rows
--     carry the comments / history / attachments JSON, logged on every write
--     under FULL, and no application path hard-deletes a ticket. The
--     attention feed (hooks/useTicketNotifications.ts) carries the
--     unfiltered-DELETE companion listener instead.
--   · milestones: re-asserted in supabase_realtime with 20261106's guard
--     (a no-op where 20261106 or a dashboard click already added it).
--   · table_views is NOT added (DEC-44 (N4-feed-provider) §5): Supabase
--     applies no row-level security to DELETE events, and a table_views key
--     is a composite text id that spells out the workspace, the person and the
--     library (lib/tableViews.ts tableViewId) — publishing the table would
--     hand those ids, across workspaces, to anyone subscribed to its DELETEs.
--     The inventory below records whether it was added by hand.
--   · notification_preferences.toast_on_mention / _assignment /
--     _status_change / _watched_activity / _sla_warning BOOLEAN NOT NULL
--     DEFAULT TRUE — the email toggles' five categories, for pop-ups. Existing
--     rows read TRUE: nothing changes until a member turns one off. The bell
--     row is always written; these govern the pop-up only.
--
-- Not a widening: no policy, grant or function changes; FULL changes what the
-- server can match, not what a subscriber receives (see above).
--
-- The app works BEFORE and AFTER this paste: the settings page saves without
-- the toast_on_* columns when the API does not know them (PGRST204) and says
-- so; the listener reads the master switch alone on 42703; the feed's DELETE
-- companion and the realtime filters need nothing from this file.
-- PASTE ORDER: any time, before or after the N4 deploy; after 20261148
-- (toast_enabled) for the settings page's per-category row to save. It stops
-- with a message if notification_preferences is missing.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.notification_preferences') IS NULL THEN
    RAISE EXCEPTION '20261200 needs notification_preferences (20260529) — this database is not at the expected baseline';
  END IF;
END $$;

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_1200_before;
CREATE TEMP TABLE notif_round_g_1200_before AS
SELECT 1 AS ord, 'BEFORE: supabase_realtime publications present (1 = Supabase realtime available)' AS inventory,
       (SELECT COUNT(*) FROM pg_publication WHERE pubname = 'supabase_realtime')::text AS n
UNION ALL
SELECT 2, 'BEFORE: tables in supabase_realtime',
       (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime')::text
UNION ALL
SELECT 3, 'BEFORE: milestones in supabase_realtime (1 = 20261106 pasted or added by hand)',
       (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones')::text
UNION ALL
SELECT 4, 'BEFORE: table_views in supabase_realtime (1 = added by hand in the dashboard; this file does not add it — DEC-44 (N4-feed-provider) §5)',
       (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'table_views')::text
UNION ALL
SELECT 5, 'BEFORE: of documents, checkout_sessions, libraries, collections — tables already REPLICA IDENTITY FULL',
       (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname IN ('documents', 'checkout_sessions', 'libraries', 'collections')
           AND c.relreplident = 'f')::text
UNION ALL
SELECT 6, 'BEFORE: notification_preferences rows (each reads every pop-up category ON after this paste)',
       (SELECT COUNT(*) FROM notification_preferences)::text
UNION ALL
SELECT 7, 'BEFORE: notification_preferences rows with pop-up toasts switched OFF (toast_enabled = false; unchanged by this paste)',
       (SELECT COUNT(*) FILTER (WHERE to_jsonb(p) ->> 'toast_enabled' = 'false') FROM notification_preferences p)::text;

BEGIN;

-- ── 1. RT-4: DELETEs that a filtered subscription can match ─────────────────
ALTER TABLE documents REPLICA IDENTITY FULL;
ALTER TABLE checkout_sessions REPLICA IDENTITY FULL;
ALTER TABLE libraries REPLICA IDENTITY FULL;
ALTER TABLE collections REPLICA IDENTITY FULL;

-- ── 2. RT-12: milestones in the publication (20261106's guard, re-asserted) ─
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND to_regclass('public.milestones') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.milestones;
  END IF;
END $$;

-- ── 3. RT-10: the per-category pop-up switches ──────────────────────────────
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS toast_on_mention BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS toast_on_assignment BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS toast_on_status_change BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS toast_on_watched_activity BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS toast_on_sla_warning BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN notification_preferences.toast_on_mention IS
  'Pop-up toasts for mention-category notifications (lib/notificationKinds.ts KIND_META.category). The bell row is always written. notifications Round G N4, 20261200.';
COMMENT ON COLUMN notification_preferences.toast_on_assignment IS
  'Pop-up toasts for assignment-category notifications. The bell row is always written. notifications Round G N4, 20261200.';
COMMENT ON COLUMN notification_preferences.toast_on_status_change IS
  'Pop-up toasts for status-change-category notifications. The bell row is always written. notifications Round G N4, 20261200.';
COMMENT ON COLUMN notification_preferences.toast_on_watched_activity IS
  'Pop-up toasts for watched-activity-category notifications. The bell row is always written. notifications Round G N4, 20261200.';
COMMENT ON COLUMN notification_preferences.toast_on_sla_warning IS
  'Pop-up toasts for SLA-warning-category notifications. The bell row is always written. notifications Round G N4, 20261200.';

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 4 ─────────
-- (the milestones probe reads false only on a database with no
-- supabase_realtime publication — a non-Supabase Postgres)
SELECT 'documents, checkout_sessions, libraries and collections are REPLICA IDENTITY FULL' AS check,
       (SELECT COUNT(*) = 4 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relname IN ('documents', 'checkout_sessions', 'libraries', 'collections')
           AND c.relreplident = 'f') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'tickets keeps its default replica identity (the feed''s DELETE companion listener covers it)',
       EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                WHERE ns.nspname = 'public' AND c.relname = 'tickets' AND c.relreplident = 'd'),
       NULL
UNION ALL
SELECT 'milestones is in the supabase_realtime publication',
       EXISTS (SELECT 1 FROM pg_publication_tables
                WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'milestones'),
       NULL
UNION ALL
SELECT 'notification_preferences has the five toast_on_* columns, boolean NOT NULL DEFAULT true',
       (SELECT COUNT(*) = 5 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'notification_preferences'
           AND column_name IN ('toast_on_mention', 'toast_on_assignment', 'toast_on_status_change', 'toast_on_watched_activity', 'toast_on_sla_warning')
           AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true'),
       NULL
UNION ALL
SELECT 'AFTER: notification_preferences rows with a pop-up category switched off (0 on the first paste — the columns are new; a re-paste counts members'' choices)',
       NULL::boolean,
       (SELECT COUNT(*) FROM notification_preferences
         WHERE NOT (toast_on_mention AND toast_on_assignment AND toast_on_status_change AND toast_on_watched_activity AND toast_on_sla_warning))::text
UNION ALL
SELECT 'AFTER: tables in supabase_realtime', NULL::boolean,
       (SELECT COUNT(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime')::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_1200_before ORDER BY ord) b;
