-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N15 RECIPIENT VISIBILITY AND NAMES: the
-- stale-checkout escalation's own kind, and the one read a browser needs to
-- learn whether ITS OWN notice to another member landed.
--
--   TAX-17   checkout_released has carried one meaning since N9 — the
--            maintenance cron's "Checkout held N days — review needed" to
--            Admin / DocCtrl — but its name says the opposite (nothing was
--            released). The cron now writes checkout_stale_escalation
--            (lib/notificationKinds.ts KIND_META carries it, same flags as
--            checkout_released: an action, not a compliance kind) and reads
--            BOTH kinds for its dedupe. checkout_released stays declared for
--            legacy rows only.
--   PROD-17  a document's WATCHERS are told when it is retired
--            (lib/staleCopies.ts recallRetiredDocument). Their FYI has its
--            own kind, doc_retired — NOT a compliance kind, unlike the copy
--            holders' doc_recalled — so it stays out of the daily compliance
--            digest, a watcher may delete it once read (20261161 keeps only
--            compliance kinds dismiss-only), and its email rides the
--            watcher's own toggle. Their force-release FYI likewise has its
--            own kind, checkout_force_released_fyi (lib/checkoutEpisodes.ts
--            forceReleaseDocument), so the checkout thread's chat kind
--            (checkout_message — Mentions, bell-only) keeps one meaning.
--   DELIV-16 a compliance notice a browser writes to ANOTHER member could not
--            be read back (notifications_own_select shows a member only the
--            rows addressed to them), so lib/complianceNotify.ts did not retry
--            it — a retry after a lost answer could write a second copy. The
--            new notification_i_wrote() answers ONE question for the caller:
--            did a row THEY wrote (actor_user_id = auth.uid()) to that
--            recipient, of that kind, with that title, about that resource,
--            land since then (one hour at most)? A boolean, never a row.
--
-- What this file does:
--   · notification_kinds() RE-CREATED from its NEWEST definition (20261191,
--     found by scanning the sequence) with THREE rows added, in KIND_META
--     order (checkout_stale_escalation right after checkout_released,
--     checkout_force_released_fyi right after checkout_force_released,
--     doc_retired right after doc_recalled; none a compliance kind), none
--     removed.
--     EXECUTE restated.
--   · notification_i_wrote(uuid, uuid, text, text, text, timestamptz) — NEW,
--     STABLE SECURITY DEFINER, search_path pinned, EXECUTE to authenticated
--     only (DRLS-16). An active member of p_org only; a kind
--     notification_kinds() does not declare, no signed-in caller, or a window
--     older than an hour answers false. A widening read (a member may now
--     confirm a notice they wrote reached its recipient), so the inventory
--     counts those rows first.
--   · the backlog: checkout_released rows the escalation wrote (they carry
--     metadata.staleSessionId) re-filed as checkout_stale_escalation — those
--     whose checkout session is no longer ACTIVE (fix pass 3). A row whose
--     session is still active keeps checkout_released for now: the OLD
--     cron, which may still be running when this is pasted (paste before
--     the deploy, below), scans only active sessions and dedupes on
--     checkout_released alone, so re-filing that row would make it escalate
--     the session a second time. The N15 cron dedupes on BOTH kinds, so the
--     kept rows are never re-escalated after the deploy either; pasting
--     this file again after the deploy re-files them. A checkout_released
--     row without staleSessionId (a force-release notice written before
--     N9) keeps its kind. Only `kind` changes — read_at, the recipient, the
--     dates and the metadata are untouched.
--
-- Pre-apply inventory (DEC-30, aggregate counts only): the escalation rows
-- to re-file (session no longer active); the escalation rows kept for now
-- (session still active); the checkout_released rows that keep their kind;
-- rows already written of the new kind; the rows written in the last hour
-- by a member to another member (what notification_i_wrote can now confirm
-- to their writers).
--
-- PASTE AND DEPLOY ORDER:
--   1. 20261160, 20261161 and 20261191 first (this file stops with a message
--      when 20261160's allow-list or insert rail is missing, or when the
--      allow-list is older than 20261191's — it lacks transmittal_issued /
--      doc_recalled, the kinds 20261191 added). Its list is
--      20261191's plus one, so never re-paste 20261160 / 20261181 / 20261191
--      after it — their lists are shorter. Paste this file again instead.
--   2. PASTE THIS FILE BEFORE THE DEPLOY of the N15 app (fix pass 3 — the
--      order lib/notificationKinds.ts's header rule asks: a kind is declared
--      before the deploy that writes it). Under the OLD cron the paste
--      changes nothing it reads: the rows of still-active sessions keep
--      checkout_released (above), and nothing old writes the new kinds or
--      asks notification_i_wrote. After the deploy the browser-written
--      watcher FYIs (doc_retired from the supersede door,
--      checkout_force_released_fyi from a force-release) are declared kinds
--      from their first write, so no watcher misses one. REQUIRED, after the
--      next maintenance run following the deploy (fix pass 4 — the
--      integrator's ruling): paste this file again — the escalation rows of
--      sessions that were active at the first paste and have closed since
--      are re-filed then. A session still active at that paste keeps its
--      checkout_released row until it closes and the file is pasted again;
--      it reads the same meanwhile (same flags, toast category and
--      reconcile class; the N15 cron dedupes on both kinds).
--      If it is pasted after the deploy instead, nothing breaks: the
--      escalation is written by the cron on the service role, which
--      20261160's rail passes, and its dedupe reads both kinds. The cost is
--      that window: until the paste, the two watcher FYIs are refused by
--      20261160's rail as undeclared kinds and only logged; both are sent
--      with emailOnlyWithBell, so a watcher whose bell row was refused gets
--      NO email either (never an email the app cannot show). The copy
--      holders' recall (doc_recalled), the checkout holder's and the package
--      owners' notices are declared kinds and unaffected.
--   3. Before this paste the app keeps today's paths: lib/complianceNotify.ts
--      asks notification_i_wrote, finds it missing (PGRST202 / 42883) and
--      does not retry a browser notice to another member (dead-lettered at
--      once, as before); an old escalation row is still found by the dedupe
--      under checkout_released.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (the re-file
-- finds only the rows whose session has closed since the last paste).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regprocedure('public.enforce_notification_insert()') IS NULL OR to_regprocedure('public.notification_kinds()') IS NULL THEN
    RAISE EXCEPTION '20261206 needs 20261160 (notification_kinds() and the insert rail) — paste 20261160_notif_roundG_write_rails.sql, 20261161_notif_roundG_read_scope.sql and 20261191_notif_roundG_kind_split.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = 'transmittal_issued')
     OR NOT EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = 'doc_recalled') THEN
    RAISE EXCEPTION '20261206 needs 20261191 (the kind split: its notification_kinds() declares transmittal_issued and doc_recalled, and its re-file and email gate must run first) — paste 20261191_notif_roundG_kind_split.sql first';
  END IF;
END;
$$;

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_206_before;
CREATE TEMP TABLE notif_round_g_206_before AS
SELECT 1 AS ord, 'BEFORE: escalation rows to re-file as checkout_stale_escalation (checkout_released with metadata.staleSessionId, session no longer active)' AS inventory,
       (SELECT COUNT(*) FROM notifications n WHERE n.kind = 'checkout_released' AND n.metadata ? 'staleSessionId'
           AND NOT EXISTS (SELECT 1 FROM checkout_sessions s WHERE s.id::text = n.metadata->>'staleSessionId' AND s.status = 'active'))::text AS n
UNION ALL
SELECT 2, 'BEFORE: escalation rows kept as checkout_released for now (session still active — the old cron dedupes on them; a paste after the deploy re-files them)',
       (SELECT COUNT(*) FROM notifications n WHERE n.kind = 'checkout_released' AND n.metadata ? 'staleSessionId'
           AND EXISTS (SELECT 1 FROM checkout_sessions s WHERE s.id::text = n.metadata->>'staleSessionId' AND s.status = 'active'))::text
UNION ALL
SELECT 3, 'BEFORE: checkout_released rows that keep their kind (no staleSessionId: force-release notices written before N9)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'checkout_released' AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'staleSessionId'))::text
UNION ALL
SELECT 4, 'BEFORE: rows already written of checkout_stale_escalation (0 before the deploy; a re-paste counts the N15 cron''s rows and the ones re-filed before)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'checkout_stale_escalation')::text
UNION ALL
SELECT 5, 'BEFORE: rows written in the last hour by a member to another member (what notification_i_wrote can confirm to their writers)',
       (SELECT COUNT(*) FROM notifications WHERE actor_user_id IS NOT NULL AND actor_user_id <> user_id AND created_at >= now() - interval '1 hour')::text;

BEGIN;

-- ── 1. notification_kinds(): the newest body (20261191) + three rows ───────
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
    ('checkout_stale_escalation',        false),
    ('checkout_force_released',          false),
    ('checkout_force_released_fyi',      false),
    ('checkout_auto_released',           false),
    ('overlap_advisory',                 false),
    ('branch_open',                      false),
    ('branch_resolved',                  false),
    ('doc_superseded',                   true),
    ('doc_recalled',                     true),
    ('doc_retired',                      false),
    ('doc_upstream_changed',             true),
    ('package_doc_stale',                true),
    ('package_doc_retired',              true),
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
    ('transmittal_issued',               false),
    ('project_member',                   false),
    ('project_status',                   false),
    ('project_comment',                  false),
    ('change_order_status',              false),
    ('milestone_assigned',               false),
    ('milestone_slipped',                false),
    ('intake_quote',                     true),
    ('intake_submission',                true),
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
  'The notification kind registry (lib/notificationKinds.ts KIND_META): every kind a browser may write, and whether it is a compliance kind. Re-created by a migration whenever the registry changes; lib/__tests__/notificationWriteRails.test.ts pins the two equal. notifications Round G, 20261160; four kinds added by 20261181 (N8); nine by 20261191 (N9 — the kind split and transmittal_issued); three by 20261206 (N15 — checkout_stale_escalation, TAX-17; checkout_force_released_fyi and doc_retired, PROD-17).';

REVOKE ALL ON FUNCTION notification_kinds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notification_kinds() TO authenticated, service_role;

-- ── 2. notification_i_wrote(): did MY notice to that member land? ──────────
CREATE OR REPLACE FUNCTION notification_i_wrote(
  p_org uuid, p_user uuid, p_kind text, p_title text, p_resource_id text, p_since timestamptz
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = p_org AND m.uid = auth.uid() AND m.status = 'active')
     AND EXISTS (SELECT 1 FROM notification_kinds() k WHERE k.kind = p_kind)
     AND EXISTS (SELECT 1 FROM notifications n
                  WHERE n.org_id = p_org
                    AND n.user_id = p_user
                    AND n.actor_user_id = auth.uid()
                    AND n.kind = p_kind
                    AND n.title = p_title
                    AND n.resource_id IS NOT DISTINCT FROM p_resource_id
                    AND n.created_at >= GREATEST(COALESCE(p_since, now()), now() - interval '1 hour'));
$$;

COMMENT ON FUNCTION notification_i_wrote(uuid, uuid, text, text, text, timestamptz) IS
  'DELIV-16: whether the CALLER wrote (actor_user_id = auth.uid()) a notification in p_org to p_user of kind p_kind, titled p_title, about p_resource_id, since p_since (one hour at most). A boolean, never a row. An active member of p_org only; a kind notification_kinds() does not declare answers false. lib/complianceNotify.ts asks it before retrying a browser notice to another member, so a retry after a lost answer never writes a second copy. notifications Round G, 20261206 (N15).';

REVOKE ALL ON FUNCTION notification_i_wrote(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notification_i_wrote(uuid, uuid, text, text, text, timestamptz) TO authenticated;

-- ── 3. the backlog: the escalation's rows under their own kind ─────────────
-- (a still-active session's row stays checkout_released: the old cron's dedupe)
UPDATE notifications n SET kind = 'checkout_stale_escalation'
 WHERE n.kind = 'checkout_released' AND n.metadata ? 'staleSessionId'
   AND NOT EXISTS (SELECT 1 FROM checkout_sessions s
                    WHERE s.id::text = n.metadata->>'staleSessionId' AND s.status = 'active');

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 7 ─────────
SELECT 'notification_kinds() is IMMUTABLE, search_path pinned, and declares 67 kinds — 21 of them compliance kinds — each once' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'notification_kinds'
                  AND pg_get_function_identity_arguments(p.oid) = ''
                  AND p.provolatile = 'i' AND NOT p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public'])
       AND (SELECT COUNT(*) = 67 AND COUNT(DISTINCT kind) = 67 AND COUNT(*) FILTER (WHERE compliance) = 21
              FROM notification_kinds()) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'notification_kinds() declares checkout_stale_escalation, checkout_force_released_fyi and doc_retired (none a compliance kind), and still declares checkout_released (legacy rows) and doc_recalled (a compliance kind)',
       (SELECT COUNT(*) FILTER (WHERE kind = 'checkout_stale_escalation' AND NOT compliance) = 1
               AND COUNT(*) FILTER (WHERE kind = 'checkout_force_released_fyi' AND NOT compliance) = 1
               AND COUNT(*) FILTER (WHERE kind = 'doc_retired' AND NOT compliance) = 1
               AND COUNT(*) FILTER (WHERE kind = 'doc_recalled' AND compliance) = 1
               AND COUNT(*) FILTER (WHERE kind = 'checkout_released') = 1
          FROM notification_kinds()),
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
SELECT 'notification_i_wrote(...) is the only one, answers a boolean for the caller''s own rows, STABLE SECURITY DEFINER with search_path pinned; anon and PUBLIC cannot execute it, authenticated can',
       (SELECT p.prosecdef AND p.provolatile = 's'
               AND pg_get_function_result(p.oid) = 'boolean'
               AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
               AND p.prosrc LIKE '%auth.uid() IS NOT NULL%m.status = ''active''%n.actor_user_id = auth.uid()%interval ''1 hour''%'
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'notification_i_wrote')
       AND (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public' AND p.proname = 'notification_i_wrote') = 1,
       NULL
UNION ALL
SELECT 'AFTER: every escalation row of a session no longer active is under its own kind (a still-active session''s row stays checkout_released for the old cron''s dedupe)',
       NOT EXISTS (SELECT 1 FROM notifications n WHERE n.kind = 'checkout_released' AND n.metadata ? 'staleSessionId'
                    AND NOT EXISTS (SELECT 1 FROM checkout_sessions s
                                     WHERE s.id::text = n.metadata->>'staleSessionId' AND s.status = 'active')),
       NULL
UNION ALL
SELECT '20261160''s insert rail is still bound (trg_notifications_enforce_insert) — this paste re-created only the allow-list it reads',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'notifications' AND t.tgname = 'trg_notifications_enforce_insert' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT '20261161''s read_at-only rule is still bound (trg_notifications_read_at_only) — the re-file ran as the SQL editor, which it lets through',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'notifications' AND t.tgname = 'trg_notifications_read_at_only' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_206_before ORDER BY ord) b;
