-- ─────────────────────────────────────────────────────────────────────────────
-- 20261260_notif_roundG_branch_alert_mark.sql
--
-- notifications Round G — N19 NOTICE RECORD REMAINDERS, NEDGE-24 limb 2
-- (drafting-flow EVID-13 done-whens 2 and 3; DEC-90 ruling (5): read_at is the
-- recipient's own act — a notice the system retires is a MARK, never a read).
--
-- clear_resolved_branch_alerts(p_branch) is re-created from its NEWEST
-- definition (20261181_notif_roundG_producers_free.sql — found by scanning
-- supabase/migrations; byte fidelity pinned by
-- lib/__tests__/n19NoticeRecordRemainders.test.ts, lineDiff + exact cut). One
-- line goes, five come in:
--
--   * it no longer stamps read_at on every recipient's unread branch_open row
--     about the resolved branch; it MARKS each one — metadata.superseded_at
--     (the time, ISO-8601 UTC, as the app writes it) and superseded_by
--     'branch_resolved', every other metadata key kept — conditional on
--     read_at IS NULL and no mark yet (the workflow route's and the reconcile
--     pass's mark). The bell's unread list and badge and the inbox count
--     already leave a marked row out (lib/inAppNotifications.ts,
--     lib/inbox.ts), so every recipient sees exactly what they see today: the
--     resolved branch's alert leaves their bell.
--   * the CALLER's own row is left to the app: a definer runs in the caller's
--     session, and 20261161's read_at-only rail (trg_notifications_read_at_only)
--     refuses a recipient's session any change but read_at on their OWN row —
--     marking it here would refuse the whole statement. lib/branches.ts
--     (retireOwnBranchAlerts, the N19 app) retires it right after through the
--     server's reconcile pass (/api/notifications/reconcile, the same mark);
--     the attention feed's own reconcile pass retires it otherwise.
--   * the gate is unchanged: only a RESOLVED branch of an org the caller is an
--     ACTIVE member of; any other call answers 0 and changes nothing. It still
--     answers how many rows it retired.
--
-- What it does NOT do: no row is changed by the paste (the rows 20261181's
-- backlog and earlier calls stamped read cannot be told from rows their
-- recipients opened — the N19 app keeps both kinds off the purge's plain read
-- line instead); no policy, table, kind or grant widens. EXECUTE is restated
-- exactly as 20261181 has it (authenticated; never PUBLIC or anon — DRLS-16).
-- NOT A WIDENING: nobody may do more; the function writes one metadata key
-- pair on the rows it already wrote (20261161's rail let its read_at stamp
-- through on other members' rows as it lets this mark through).
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261181 (the first statement refuses
-- otherwise, changing nothing) and after 20261161. Either order with the N19
-- deploy is safe; RECOMMENDED: deploy the app first, then paste.
--   * App deployed, not pasted: the old body stamps read_at for every
--     recipient, the caller included (today's path); the app's own-row retire
--     then finds nothing unread and does nothing. Before 20261181 itself
--     (42883 / PGRST202) the alerts stay unread and the app says so, as today.
--   * Pasted, app not yet deployed: every other recipient's alert is marked;
--     the resolver's own alert is retired by their attention feed's reconcile
--     pass on its next read instead of at once (it leaves their bell then).
-- Never paste 20261181 again after this file: it would put the read_at stamp
-- back (re-paste this file to undo that).
-- Re-runnable: CREATE OR REPLACE; REVOKE / GRANT are idempotent.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.notifications') IS NULL
     OR to_regclass('public.revision_branches') IS NULL
     OR to_regprocedure('public.clear_resolved_branch_alerts(uuid)') IS NULL THEN
    RAISE EXCEPTION '20261260 needs 20261181 (clear_resolved_branch_alerts) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS notif_round_g_260_before;
CREATE TEMP TABLE notif_round_g_260_before AS
SELECT 1 AS ord, 'inventory (before apply): branch_open notices in all' AS inventory,
       COUNT(*)::text AS n FROM notifications WHERE kind = 'branch_open'
UNION ALL
SELECT 2, 'inventory (before apply): branch_open notices marked read — opened by their recipient, or stamped by 20261181 (its backlog or an earlier resolve); the N19 app keeps them off the purge''s plain read line; this paste changes none',
       COUNT(*)::text FROM notifications WHERE kind = 'branch_open' AND read_at IS NOT NULL
UNION ALL
SELECT 3, 'inventory (before apply): branch_open notices unread and unmarked about a RESOLVED branch — each recipient''s attention-feed reconcile pass retires them with the mark; this paste changes none',
       COUNT(*)::text FROM notifications n
        WHERE n.kind = 'branch_open' AND n.read_at IS NULL AND n.metadata ->> 'superseded_at' IS NULL
          AND EXISTS (SELECT 1 FROM revision_branches b
                       WHERE b.resolved_at IS NOT NULL AND b.org_id = n.org_id
                         AND n.metadata @> jsonb_build_object('branchId', b.id::text))
UNION ALL
SELECT 4, 'inventory (before apply): branch_open notices already retired with the mark (metadata.superseded_at)',
       COUNT(*)::text FROM notifications WHERE kind = 'branch_open' AND metadata ->> 'superseded_at' IS NOT NULL
UNION ALL
SELECT 5, 'inventory (before apply): access_request_pending notices marked read — opened, or stamped by the old decide path (lib/accessRequestOutcome.ts, the service role); the N19 app marks instead and keeps them off the purge''s plain read line',
       COUNT(*)::text FROM notifications WHERE kind = 'access_request_pending' AND read_at IS NOT NULL;

BEGIN;

-- ── clear_resolved_branch_alerts(): the newest body (20261181), retired with a mark ──
CREATE OR REPLACE FUNCTION clear_resolved_branch_alerts(p_branch uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_n integer := 0;
BEGIN
  IF v_uid IS NULL OR p_branch IS NULL THEN
    RETURN 0;
  END IF;
  -- Only a RESOLVED branch of an org the caller is an active member of; any
  -- other id answers the same 0 (no cross-tenant existence oracle).
  SELECT b.org_id INTO v_org
    FROM revision_branches b
   WHERE b.id = p_branch
     AND b.resolved_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = b.org_id AND m.uid = v_uid AND m.status = 'active');
  IF v_org IS NULL THEN
    RETURN 0;
  END IF;
  -- NEDGE-24 (20261260): a mark, never a read; the caller's own row is the app's (20261161's rail).
  UPDATE notifications n
     SET metadata = COALESCE(n.metadata, '{}'::jsonb) || jsonb_build_object(
           'superseded_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'superseded_by', 'branch_resolved')
   WHERE n.org_id = v_org
     AND n.kind = 'branch_open'
     AND n.read_at IS NULL
     AND n.metadata ->> 'superseded_at' IS NULL
     AND n.user_id IS DISTINCT FROM v_uid
     AND n.metadata @> jsonb_build_object('branchId', p_branch::text);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION clear_resolved_branch_alerts(uuid) IS
  'PROD-3: retires every unread branch_open notification about a RESOLVED revision branch (metadata.branchId), in the branch''s org, for every recipient but the caller — called by lib/branches.ts resolveBranch, which retires the caller''s own through the reconcile pass. A MARK, never a read (NEDGE-24): metadata.superseded_at / superseded_by = branch_resolved, on rows still unread and unmarked; read_at is the recipient''s own act. Acts only for an active member of that org; any other call answers 0 and changes nothing. notifications Round G, 20261181 (N8); re-created by 20261260 (N19).';

REVOKE ALL ON FUNCTION clear_resolved_branch_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_resolved_branch_alerts(uuid) TO authenticated;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- Probes: ok = true × 4 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'NEDGE-24: clear_resolved_branch_alerts(uuid) retires with the mark (metadata.superseded_at / superseded_by) on unread, unmarked rows and writes no read_at; one definition, returns integer' AS check,
       (SELECT pg_get_function_result(p.oid) = 'integer'
               AND p.prosrc LIKE '%SET metadata = COALESCE(n.metadata, ''{}''::jsonb) || jsonb_build_object(%'
               AND p.prosrc LIKE '%''superseded_at'', to_char(now() AT TIME ZONE ''UTC''%'
               AND p.prosrc LIKE '%''superseded_by'', ''branch_resolved'')%'
               AND p.prosrc LIKE '%AND n.read_at IS NULL%AND n.metadata ->> ''superseded_at'' IS NULL%'
               AND p.prosrc NOT LIKE '%SET read_at%'
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'clear_resolved_branch_alerts')
       AND (SELECT COUNT(*) = 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public' AND p.proname = 'clear_resolved_branch_alerts') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'the gate is unchanged (a RESOLVED branch of an org the caller is an ACTIVE member of) and the caller''s own row is left to the app (20261161''s rail)',
       (SELECT p.prosrc LIKE '%IF v_uid IS NULL OR p_branch IS NULL THEN%'
               AND p.prosrc LIKE '%AND b.resolved_at IS NOT NULL%AND m.status = ''active''%'
               AND p.prosrc LIKE '%AND n.user_id IS DISTINCT FROM v_uid%'
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'clear_resolved_branch_alerts'),
       NULL
UNION ALL
SELECT 1, 3, 'DRLS-16: SECURITY DEFINER with search_path pinned; anon and PUBLIC cannot execute it, authenticated can (as 20261181)',
       (SELECT p.prosecdef
               AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'clear_resolved_branch_alerts'),
       NULL
UNION ALL
SELECT 1, 4, '20261161''s read_at-only rule is still bound (trg_notifications_read_at_only) — the reason the caller''s own row is the app''s',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'notifications' AND t.tgname = 'trg_notifications_read_at_only' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM notif_round_g_260_before
UNION ALL
SELECT 3, 1, 'after: branch_open notices marked read (read beside BEFORE row 2 — this paste changes no row; live traffic may move it)', NULL,
       (SELECT COUNT(*) FROM notifications WHERE kind = 'branch_open' AND read_at IS NOT NULL)::text
) AS final_rows
ORDER BY sec, ord;
