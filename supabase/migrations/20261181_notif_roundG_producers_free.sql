-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N8 PRODUCERS-FREE: the four new notification kinds
-- (PROD-2, PROD-6, PROD-11) on the database's allow-list, and the branch
-- alert that clears itself when the branch is resolved (PROD-3 dw2).
--
--   PROD-2   an access request notified nobody. The request door now writes
--            access_request_pending to the org's Admin / DocCtrl pool.
--   PROD-6   change orders were silent. Proposing, approving and rejecting
--            one now writes change_order_status to the project's members
--            and its owner.
--   PROD-11  the schedule was silent. A task's new responsible person gets
--            milestone_assigned; a move that pushes baselined tasks past
--            their baseline writes milestone_slipped to the project owner.
--   PROD-3   resolving a branch told only its creator, and every DocCtrl's
--            branch_open alert ("Action needed") stayed unread for good: the
--            hook's reconcile reads only ticket workflow rows, and a browser
--            may mark only its OWN rows read (20261161).
--
-- What this file does:
--   · notification_kinds() RE-CREATED from its NEWEST definition (20261160
--     §1) with four rows added, in lib/notificationKinds.ts KIND_META order:
--     change_order_status, milestone_assigned, milestone_slipped (after
--     project_comment) and access_request_pending (after library_unowned),
--     none of them a compliance kind. Nothing else in the body changes —
--     lib/__tests__/notifProducersFree.test.ts diffs it against the newest
--     earlier definition found by scanning supabase/migrations, and
--     lib/__tests__/notificationWriteRails.test.ts pins the newest
--     definition to KIND_META. EXECUTE restated: authenticated and
--     service_role, never PUBLIC or anon.
--   · clear_resolved_branch_alerts(uuid) — NEW, SECURITY DEFINER, search_path
--     pinned. lib/branches.ts resolveBranch calls it after the branch is
--     resolved: it marks read every unread branch_open row about THAT branch
--     (metadata.branchId), in the branch's org, whoever it was addressed to.
--     It acts only on a RESOLVED branch of an org the caller is an ACTIVE
--     member of; anything else (an open branch, an unknown id, another
--     org's branch, no signed-in caller) answers 0 and changes nothing — one
--     answer, so it tells a caller nothing about another tenant. It changes
--     read_at only (20261161's read_at-only trigger passes a definer path on
--     another member's rows, and checks the caller's own). EXECUTE:
--     authenticated only (DRLS-16) — the body refuses a NULL auth.uid() by
--     answering 0, and anon cannot reach it at all.
--   · the backlog: the unread branch_open rows whose branch is ALREADY
--     resolved are marked read once, here (the same rule as the function).
--     The inventory reports how many before; a probe reports none after.
--
-- Pre-apply inventory (DEC-30, aggregate counts only): rows already written
-- of the four new kinds (a browser could write them only before 20261160);
-- the unread branch_open rows this paste marks read, and how many resolved
-- branches they are about; the pending access requests waiting today.
--
-- PASTE AND DEPLOY ORDER:
--   1. 20261160 and 20261161 first (this file stops with a message when
--      20261160's insert rail is missing — re-creating notification_kinds()
--      before 20261160 would let 20261160's own re-create take the four kinds
--      away again). Never re-paste 20261160 after this file: its
--      notification_kinds() is the 51-kind list. Paste this file again
--      instead, or a later re-create that carries these rows.
--   2. this file, BEFORE the deploy that writes the kinds. Once 20261160 is
--      live, a browser's row of a kind the live function does not list is
--      refused (22023) and only logged by notify(): change_order_status,
--      milestone_assigned and milestone_slipped are written from the
--      browser. access_request_pending is written by the request door on
--      the service role, which 20261160 passes untouched.
--   3. the deploy. Before this paste, the app's branch resolution calls
--      clear_resolved_branch_alerts and, on 42883 / PGRST202, keeps today's
--      path (the alerts stay unread) and logs.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regprocedure('public.enforce_notification_insert()') IS NULL OR to_regprocedure('public.notification_kinds()') IS NULL THEN
    RAISE EXCEPTION '20261181 needs 20261160 (notification_kinds() and the insert rail) — paste 20261160_notif_roundG_write_rails.sql and 20261161_notif_roundG_read_scope.sql first';
  END IF;
END;
$$;

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_181_before;
CREATE TEMP TABLE notif_round_g_181_before AS
SELECT 1 AS ord, 'BEFORE: rows already written of the four new kinds (change_order_status, milestone_assigned, milestone_slipped, access_request_pending)' AS inventory,
       (SELECT COUNT(*) FROM notifications
         WHERE kind IN ('change_order_status', 'milestone_assigned', 'milestone_slipped', 'access_request_pending'))::text AS n
UNION ALL
SELECT 2, 'BEFORE: unread branch_open rows about a branch that is already resolved (this paste marks them read)',
       (SELECT COUNT(*) FROM notifications n
         WHERE n.kind = 'branch_open' AND n.read_at IS NULL
           AND EXISTS (SELECT 1 FROM revision_branches b
                        WHERE b.resolved_at IS NOT NULL AND b.org_id = n.org_id
                          AND n.metadata @> jsonb_build_object('branchId', b.id::text)))::text
UNION ALL
SELECT 3, 'BEFORE: resolved branches those rows are about',
       (SELECT COUNT(DISTINCT b.id) FROM revision_branches b
         WHERE b.resolved_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM notifications n
                        WHERE n.kind = 'branch_open' AND n.read_at IS NULL AND n.org_id = b.org_id
                          AND n.metadata @> jsonb_build_object('branchId', b.id::text)))::text
UNION ALL
SELECT 4, 'BEFORE: pending access requests (unchanged by this paste — the next request notifies the Admin / DocCtrl pool)',
       (SELECT COUNT(*) FROM access_requests WHERE status = 'pending')::text;

BEGIN;

-- ── 1. notification_kinds(): the newest body (20261160 §1) + four rows ──────
CREATE OR REPLACE FUNCTION notification_kinds()
RETURNS TABLE (kind text, compliance boolean)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  VALUES
    ('ticket_comment',                   false),
    ('ticket_mention',                   false),
    ('ticket_status',                    false),
    ('ticket_assigned',                  false),
    ('request_pending_approval',         false),
    ('checkout_conflict',                false),
    ('checkout_handoff',                 false),
    ('checkout_message',                 false),
    ('checkout_released',                false),
    ('overlap_advisory',                 false),
    ('branch_open',                      false),
    ('branch_resolved',                  false),
    ('doc_superseded',                   true),
    ('markup_request',                   false),
    ('provenance_flag',                  false),
    ('hold_opened',                      false),
    ('hold_released',                    false),
    ('revision_published_over_checkout', false),
    ('library_doc_added',                false),
    ('library_doc_revised',              false),
    ('owner_assigned',                   false),
    ('owner_behind',                     true),
    ('deletion_requested',               true),
    ('ack_requested',                    true),
    ('ack_complete',                     false),
    ('ack_overdue',                      true),
    ('ack_unsatisfiable',                true),
    ('review_due',                       true),
    ('review_requested',                 true),
    ('review_signed',                    false),
    ('review_invalidated',               true),
    ('review_complete',                  true),
    ('review_overdue',                   true),
    ('review_alternate_activated',       true),
    ('effective_now',                    true),
    ('retention_eligible',               true),
    ('legal_hold_placed',                false),
    ('legal_hold_released',              false),
    ('access_recert_due',                true),
    ('project_member',                   false),
    ('project_status',                   false),
    ('project_comment',                  false),
    ('change_order_status',              false),
    ('milestone_assigned',               false),
    ('milestone_slipped',                false),
    ('orchestrator_message',             false),
    ('security_export',                  false),
    ('member_revoked',                   false),
    ('library_unowned',                  false),
    ('access_request_pending',           false),
    ('storage_alert',                    false),
    ('storage_platform_r2',              false),
    ('storage_platform_db',              false),
    ('ai_cap_changed',                   false),
    ('transmittal_unstampable',          false)
$$;

COMMENT ON FUNCTION notification_kinds() IS
  'The notification kind registry (lib/notificationKinds.ts KIND_META): every kind a browser may write, and whether it is a compliance kind. Re-created by a migration whenever the registry changes; lib/__tests__/notificationWriteRails.test.ts pins the two equal. notifications Round G, 20261160; four kinds added by 20261181 (N8).';

REVOKE ALL ON FUNCTION notification_kinds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notification_kinds() TO authenticated, service_role;

-- ── 2. clear_resolved_branch_alerts(): the branch_open queue clears itself ──
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
  UPDATE notifications n
     SET read_at = now()
   WHERE n.org_id = v_org
     AND n.kind = 'branch_open'
     AND n.read_at IS NULL
     AND n.metadata @> jsonb_build_object('branchId', p_branch::text);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION clear_resolved_branch_alerts(uuid) IS
  'PROD-3: marks read every unread branch_open notification about a RESOLVED revision branch (metadata.branchId), in the branch''s org, for every recipient — called by lib/branches.ts resolveBranch. Acts only for an active member of that org; any other call answers 0 and changes nothing. Changes read_at only. notifications Round G, 20261181 (N8).';

REVOKE ALL ON FUNCTION clear_resolved_branch_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION clear_resolved_branch_alerts(uuid) TO authenticated;

-- ── 3. the backlog: alerts about branches already resolved ──────────────────
UPDATE notifications n
   SET read_at = now()
 WHERE n.kind = 'branch_open'
   AND n.read_at IS NULL
   AND EXISTS (SELECT 1 FROM revision_branches b
                WHERE b.resolved_at IS NOT NULL AND b.org_id = n.org_id
                  AND n.metadata @> jsonb_build_object('branchId', b.id::text));

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 6 ─────────
SELECT 'notification_kinds() is IMMUTABLE, search_path pinned, and declares 55 kinds — 15 of them compliance kinds — each once' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'notification_kinds'
                  AND pg_get_function_identity_arguments(p.oid) = ''
                  AND p.provolatile = 'i' AND NOT p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public'])
       AND (SELECT COUNT(*) = 55 AND COUNT(DISTINCT kind) = 55 AND COUNT(*) FILTER (WHERE compliance) = 15
              FROM notification_kinds()) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'notification_kinds() declares the four new kinds, none of them a compliance kind',
       (SELECT COUNT(*) = 4 FROM notification_kinds()
         WHERE kind IN ('change_order_status', 'milestone_assigned', 'milestone_slipped', 'access_request_pending') AND NOT compliance),
       NULL
UNION ALL
SELECT 'notification_kinds(): anon and PUBLIC cannot execute it, authenticated and service_role can',
       (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'notification_kinds'),
       NULL
UNION ALL
SELECT 'clear_resolved_branch_alerts(uuid) returns integer, is SECURITY DEFINER with search_path pinned; anon and PUBLIC cannot execute it, authenticated can',
       (SELECT pg_get_function_result(p.oid) = 'integer' AND p.prosecdef
               AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
               AND p.prosrc LIKE '%AND b.resolved_at IS NOT NULL%AND m.status = ''active''%'
               AND p.prosrc LIKE '%AND n.kind = ''branch_open''%AND n.read_at IS NULL%'
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'clear_resolved_branch_alerts'),
       NULL
UNION ALL
SELECT 'AFTER: no unread branch_open row is about a resolved branch',
       NOT EXISTS (SELECT 1 FROM notifications n
                    WHERE n.kind = 'branch_open' AND n.read_at IS NULL
                      AND EXISTS (SELECT 1 FROM revision_branches b
                                   WHERE b.resolved_at IS NOT NULL AND b.org_id = n.org_id
                                     AND n.metadata @> jsonb_build_object('branchId', b.id::text))),
       NULL
UNION ALL
SELECT '20261160''s insert rail is still bound (trg_notifications_enforce_insert) — this paste re-created only the allow-list it reads',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'notifications' AND t.tgname = 'trg_notifications_enforce_insert' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_181_before ORDER BY ord) b;
