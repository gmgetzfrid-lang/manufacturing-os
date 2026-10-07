-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N6 EMAIL-PIPELINE-AND-CRON: who queued an email
-- (DELIV-1 done-when 3).
--
--   DELIV-1  email_notifications recorded only the RECIPIENT (to_user_id). A
--            row a signed-in member queued from a browser (queueEmail, every
--            emit() producer) carried nothing that named the member who
--            queued it, so a send could not be attributed. 20261047 (SURF-17)
--            already confined what a member may queue — an address of their
--            own org, never metadata.external; this file records WHO.
--
-- What this file does:
--   · email_notifications.queued_by UUID (nullable) — NEW. The member who
--     queued the row: stamped by the database for a signed-in caller, never
--     taken from the row (a browser cannot name someone else). NULL for a row
--     the server queued (the service role and the cron carry no uid — the
--     drain, the compliance digest, the ticket routes, the transmittal
--     routes); a server row's actor, where it has one, is in its metadata
--     (e.g. postedBy) as before.
--   · stamp_email_queued_by() — NEW, plpgsql, SECURITY INVOKER (it reads only
--     auth.uid(); it needs no rights of its own), search_path pinned. EXECUTE
--     revoked from PUBLIC, anon and authenticated: a trigger function is not
--     called through the API, and a trigger fires whatever the caller's
--     EXECUTE grant.
--   · trg_email_queued_by — NEW, BEFORE INSERT FOR EACH ROW.
--   · email_notifications_queued_by_idx — NEW, partial (queued_by IS NOT NULL):
--     "what did this member queue" is the attribution question.
--   · queued_by is immutable to a signed-in updater with no further change:
--     trg_email_requeue_columns (20261047, enforce_email_requeue_columns —
--     its newest and only definition) refuses any change to a column but
--     status / attempt_count / updated_at, by comparing the whole row, so it
--     covers a column added later. A probe below checks that body is still
--     the whole-row comparison; it is not re-created here.
--   · Every policy on email_notifications is untouched.
--
-- Not widening (DEC-30): nobody may do more after this file; it adds a column
-- the database fills. The inventory below is counts only.
--
-- DEPLOY ORDER: either order is safe. No application code reads or writes
-- queued_by: the app inserts the same columns before and after the paste,
-- and the column is filled by the trigger alone. lib/schemaExpectations.ts
-- lists the column, so Admin → Workspace Settings → Database health names
-- this file until it is pasted.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe. Needs
-- 20260529 (the table) and 20261047 (its policies and the requeue trigger).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_183_before;
CREATE TEMP TABLE notif_round_g_183_before AS
SELECT 'BEFORE: email_notifications rows' AS inventory,
       (SELECT COUNT(*) FROM email_notifications)::text AS n
UNION ALL
SELECT 'BEFORE: rows queued in the last 90 days that name no queuer (every one on the first paste — the column does not exist yet)',
       (SELECT COUNT(*) FILTER (WHERE to_jsonb(e) ->> 'queued_by' IS NULL) FROM email_notifications e
         WHERE e.created_at >= now() - interval '90 days')::text
UNION ALL
SELECT 'BEFORE: rows queued in the last 90 days marked external (server-side transmittal mail; stays queued_by NULL)',
       (SELECT COUNT(*) FROM email_notifications
         WHERE created_at >= now() - interval '90 days' AND COALESCE(metadata->>'external', '') = 'true')::text;

BEGIN;

ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS queued_by UUID;

COMMENT ON COLUMN email_notifications.queued_by IS
  'The signed-in member who queued this email, stamped by trg_email_queued_by (20261183, DELIV-1); NULL when the server queued it (service role / cron). Never taken from the row.';

CREATE OR REPLACE FUNCTION stamp_email_queued_by()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- A signed-in caller is the queuer, whatever the row says.
  IF auth.uid() IS NOT NULL THEN
    NEW.queued_by := auth.uid();
  END IF;
  -- The service role and the cron (no uid) keep what the server wrote.
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION stamp_email_queued_by() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_email_queued_by ON email_notifications;
CREATE TRIGGER trg_email_queued_by
BEFORE INSERT ON email_notifications
FOR EACH ROW EXECUTE FUNCTION stamp_email_queued_by();

CREATE INDEX IF NOT EXISTS email_notifications_queued_by_idx
  ON email_notifications(queued_by, created_at DESC) WHERE queued_by IS NOT NULL;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 6 ─────────
SELECT 'email_notifications.queued_by is a nullable uuid' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'email_notifications'
                  AND column_name = 'queued_by' AND data_type = 'uuid' AND is_nullable = 'YES') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'stamp_email_queued_by() stamps auth.uid() for a signed-in caller only, is SECURITY INVOKER with search_path pinned',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'stamp_email_queued_by'
                  AND NOT p.prosecdef
                  AND p.proconfig IS NOT NULL AND 'search_path=public' = ANY (p.proconfig)
                  AND p.prosrc LIKE '%IF auth.uid() IS NOT NULL THEN%NEW.queued_by := auth.uid();%'),
       NULL
UNION ALL
SELECT 'stamp_email_queued_by(): EXECUTE held by no API role (PUBLIC, anon, authenticated)',
       (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'stamp_email_queued_by'),
       NULL
UNION ALL
SELECT 'trg_email_queued_by is BEFORE INSERT FOR EACH ROW on email_notifications, enabled',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_email_queued_by' AND t.tgrelid = 'public.email_notifications'::regclass
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND (t.tgtype & 1) = 1      -- FOR EACH ROW
                  AND (t.tgtype & 2) = 2      -- BEFORE
                  AND (t.tgtype & 4) = 4      -- INSERT
                  AND (t.tgtype & 24) = 0),   -- not DELETE / UPDATE
       NULL
UNION ALL
SELECT 'queued_by is immutable to a signed-in updater: enforce_email_requeue_columns still compares the whole row but status / attempt_count / updated_at (20261047)',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'enforce_email_requeue_columns'
                  AND p.prosrc LIKE '%(to_jsonb(NEW) - ''status'' - ''attempt_count'' - ''updated_at'')%IS DISTINCT FROM (to_jsonb(OLD) - ''status'' - ''attempt_count'' - ''updated_at'')%')
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_email_requeue_columns'
                    AND tgrelid = 'public.email_notifications'::regclass AND NOT tgisinternal),
       NULL
UNION ALL
SELECT 'email_notifications policies are untouched (insert, select own-or-admin, update admin-requeue)',
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'email_notifications'
           AND policyname IN ('email_notif_insert', 'email_notif_select_own_or_admin', 'email_notif_update_admin_requeue')),
       NULL
UNION ALL
SELECT 'AFTER: rows that name their queuer (0 on the first paste; browser-queued rows from now on)',
       NULL::boolean,
       (SELECT COUNT(*) FROM email_notifications WHERE queued_by IS NOT NULL)::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM notif_round_g_183_before;
