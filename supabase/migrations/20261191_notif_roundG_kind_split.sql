-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N9 DC-OWNED-PRODUCERS-AND-KIND-SPLIT: one name per
-- notification meaning, the transmittal notices no preference mutes, and the
-- one read of the notices a member sent (the nudge and heads-up states).
--
--   PROD-13 / TAX-13  doc_superseded carried eight meanings and
--            checkout_released three; review_requested also carried three
--            contractor-intake notices (DEC-81 §3, DEC-90 A13). The app now
--            writes a kind per meaning (lib/notificationKinds.ts KIND_META):
--              doc_recalled, doc_upstream_changed, package_doc_stale,
--              package_doc_retired, checkout_force_released,
--              checkout_auto_released, intake_quote, intake_submission —
--            and distribution-acknowledgment requests ride ack_requested.
--   PROD-12  a transmittal's issue tells the documents' owners and the
--            libraries' followers: transmittal_issued.
--   DELIV-15 the transmittal issuer's notice of a PDF released unmarked or
--            refused ('transmittal_unstamped' / 'transmittal_refused') is
--            exempt from every email preference, like a drawing recall
--            (DEC-74 §9, DEC-90 A10); the receipt email stays
--            preference-gated (the app asks email_gate for it).
--   OS-6 / TAX-16  a member's own nudges and heads-ups could not be read
--            back (notifications_own_select shows a member only the rows
--            addressed to them), so "already sent" lived in one browser.
--
-- What this file does:
--   · notification_kinds() RE-CREATED from its NEWEST definition (20261181,
--     found by scanning the sequence) with nine rows added in KIND_META
--     order, none removed: the eight split kinds and transmittal_issued.
--     Each split kind carries its parent's compliance flag (doc_superseded's
--     and review_requested's TRUE, checkout_released's FALSE), so the
--     dismiss-only rule (20261161) and the compliance digest treat every
--     re-filed row as before. EXECUTE restated.
--   · email_gate() RE-CREATED from its NEWEST definition (20261148) with two
--     event types added to the exempt list and the comment that says so —
--     the only change. lib/notificationPrefs.ts PREFERENCE_EXEMPT_EVENT_TYPES
--     carries the same list; a test pins the two equal. EXECUTE restated.
--   · notifications_i_sent(...) — NEW, SECURITY DEFINER, search_path pinned,
--     EXECUTE to authenticated only (DRLS-16). For an ACTIVE member of p_org
--     it answers the notices THAT MEMBER wrote (actor_user_id = auth.uid())
--     of two kinds only — overlap_advisory (the edit-overlap heads-up,
--     TAX-16) and checkout_conflict (the /checkouts coordination nudge,
--     OS-6) — inside the last 30 days at most: recipient, resource and time,
--     never a title, body or metadata. Anything else (another kind, another
--     org, no signed-in caller) answers no rows. A widening read — a member
--     may now read back whom they nudged — so the inventory counts those
--     rows first.
--   · the backlog, re-filed by the metadata discriminators the producers
--     wrote (TAX-13 dw2 — a kind's meaning never depends on metadata again):
--       doc_superseded + ackRequest               → ack_requested
--       doc_superseded + recall                   → doc_recalled
--       doc_superseded + workPackageId            → package_doc_stale
--       doc_superseded + packageId + retirement   → package_doc_retired
--       checkout_released + autoReleasedSessionId → checkout_auto_released
--       review_requested + intake + quote         → intake_quote
--       review_requested + intake                 → intake_submission
--     A row with no discriminator keeps its kind: doc_superseded's real
--     supersede notices, and the upstream advisories written before N9 (they
--     carry none); checkout_released's stale-checkout escalations (still its
--     meaning) and the force-release notices written before N9 (they carry
--     none). Only `kind` changes on a re-filed row — read_at, the recipient,
--     the dates and the metadata are untouched. The inventory counts each
--     group before; a probe reports none left after.
--
-- Pre-apply inventory (DEC-30, aggregate counts only): the rows each
-- discriminator re-files; the rows that keep their kind; rows already
-- written of the nine new kinds (none on the first paste); the nudge and heads-up rows
-- members wrote (what notifications_i_sent can now read back to their
-- writers).
--
-- PASTE AND DEPLOY ORDER:
--   1. 20261148, 20261160, 20261161 and 20261181 first. This file stops with
--      a message when email_gate() or 20261160's insert rail is missing. It
--      carries 20261181's four kinds itself (its list is 20261181's plus
--      nine), so nothing is lost if 20261181 was skipped — but 20261181's
--      clear_resolved_branch_alerts is still that file's to add. Never
--      re-paste 20261160 or 20261181 after this file: their
--      notification_kinds() lists are shorter. Paste this file again
--      instead, or a later re-create that carries these rows.
--   2. THIS FILE, BEFORE the deploy that writes the new kinds. Once 20261160
--      is live, a browser's row of a kind the live function does not list is
--      refused (22023) and only logged by notify(): doc_recalled,
--      doc_upstream_changed, package_doc_stale, package_doc_retired,
--      checkout_force_released, checkout_auto_released and
--      transmittal_issued are written from the browser. intake_quote and
--      intake_submission are written by the intake door and the cron on the
--      service role, which 20261160 passes untouched.
--      And IMMEDIATELY BEFORE the N9 deploy — the one whose KIND_META
--      carries the nine kinds and whose cron derives COMPLIANCE_KINDS from
--      it (N6 merged first). An N6-only deploy is NOT enough: its derivation
--      reads a KIND_META without the six split compliance kinds, so the
--      derived list equals today's hand list. This file's re-files move the
--      already-written doc_superseded / review_requested rows out of that
--      list, so a digest that fires between this paste and that deploy
--      omits the rows the paste re-filed (its 25 h window) — every recall,
--      package, upstream and intake line written in the preceding day.
--      Schedule the paste outside the digest hour (DEC-100 Risk;
--      99-fix-sequencing).
--   3. the deploy. Before this paste the app keeps today's paths: the
--      receipt email's gate falls back to a service-role read of the issuer's
--      preferences when email_gate is unavailable (42883 / PGRST202 —
--      emailAllowedByPrefs, the same rule); the nudge and heads-up "already
--      sent" states fall back to the browser's own marks when
--      notifications_i_sent is (42883 / PGRST202).
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (the re-files
-- find nothing the second time).
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regprocedure('public.enforce_notification_insert()') IS NULL OR to_regprocedure('public.notification_kinds()') IS NULL THEN
    RAISE EXCEPTION '20261191 needs 20261160 (notification_kinds() and the insert rail) — paste 20261160_notif_roundG_write_rails.sql and 20261161_notif_roundG_read_scope.sql first';
  END IF;
  IF to_regprocedure('public.email_gate(uuid, uuid, text, text, text, text)') IS NULL THEN
    RAISE EXCEPTION '20261191 needs 20261148 (email_gate) — paste 20261148_notif_roundG_prefs_gate.sql first';
  END IF;
END;
$$;

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_191_before;
CREATE TEMP TABLE notif_round_g_191_before AS
SELECT 1 AS ord, 'BEFORE: doc_superseded rows with metadata.ackRequest (re-filed as ack_requested)' AS inventory,
       (SELECT COUNT(*) FROM notifications WHERE kind = 'doc_superseded' AND metadata ? 'ackRequest')::text AS n
UNION ALL
SELECT 2, 'BEFORE: doc_superseded rows with metadata.recall (re-filed as doc_recalled)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'doc_superseded' AND NOT metadata ? 'ackRequest' AND metadata ? 'recall')::text
UNION ALL
SELECT 3, 'BEFORE: doc_superseded rows with metadata.workPackageId (re-filed as package_doc_stale)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'doc_superseded' AND NOT metadata ?| ARRAY['ackRequest', 'recall'] AND metadata ? 'workPackageId')::text
UNION ALL
SELECT 4, 'BEFORE: doc_superseded rows with metadata.packageId + retirement (re-filed as package_doc_retired)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'doc_superseded' AND NOT metadata ?| ARRAY['ackRequest', 'recall', 'workPackageId']
          AND metadata ? 'packageId' AND metadata ? 'retirement')::text
UNION ALL
SELECT 5, 'BEFORE: doc_superseded rows that keep their kind (no discriminator: a published revision, or an upstream advisory written before N9)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'doc_superseded'
          AND NOT COALESCE(metadata ?| ARRAY['ackRequest', 'recall', 'workPackageId'], false)
          AND NOT COALESCE(metadata ? 'packageId' AND metadata ? 'retirement', false))::text
UNION ALL
SELECT 6, 'BEFORE: checkout_released rows with metadata.autoReleasedSessionId (re-filed as checkout_auto_released)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'checkout_released' AND metadata ? 'autoReleasedSessionId')::text
UNION ALL
SELECT 7, 'BEFORE: checkout_released rows that keep their kind (the stale-checkout escalation, and force-release notices written before N9)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'checkout_released' AND NOT COALESCE(metadata ? 'autoReleasedSessionId', false))::text
UNION ALL
SELECT 8, 'BEFORE: review_requested rows with metadata.intake + quote (re-filed as intake_quote)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'review_requested' AND metadata ? 'intake' AND metadata ? 'quote')::text
UNION ALL
SELECT 9, 'BEFORE: review_requested rows with metadata.intake and no quote (re-filed as intake_submission)',
       (SELECT COUNT(*) FROM notifications WHERE kind = 'review_requested' AND metadata ? 'intake' AND NOT metadata ? 'quote')::text
UNION ALL
SELECT 10, 'BEFORE: rows already written of the nine new kinds (0 on the first paste; a re-paste counts the rows the first re-filed)',
       (SELECT COUNT(*) FROM notifications WHERE kind IN ('doc_recalled', 'doc_upstream_changed', 'package_doc_stale', 'package_doc_retired',
          'checkout_force_released', 'checkout_auto_released', 'intake_quote', 'intake_submission', 'transmittal_issued'))::text
UNION ALL
SELECT 11, 'BEFORE: overlap_advisory and checkout_conflict rows a member wrote in the last 30 days (what notifications_i_sent reads back to their writers)',
       (SELECT COUNT(*) FROM notifications WHERE kind IN ('overlap_advisory', 'checkout_conflict') AND actor_user_id IS NOT NULL
          AND created_at >= now() - interval '30 days')::text;

BEGIN;

-- ── 1. notification_kinds(): the newest body (20261181) + nine rows ─────────
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
    ('checkout_force_released',          false),
    ('checkout_auto_released',           false),
    ('overlap_advisory',                 false),
    ('branch_open',                      false),
    ('branch_resolved',                  false),
    ('doc_superseded',                   true),
    ('doc_recalled',                     true),
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
  'The notification kind registry (lib/notificationKinds.ts KIND_META): every kind a browser may write, and whether it is a compliance kind. Re-created by a migration whenever the registry changes; lib/__tests__/notificationWriteRails.test.ts pins the two equal. notifications Round G, 20261160; four kinds added by 20261181 (N8); nine by 20261191 (N9 — the kind split and transmittal_issued).';

REVOKE ALL ON FUNCTION notification_kinds() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notification_kinds() TO authenticated, service_role;

-- ── 2. email_gate(): the newest body (20261148) + two exempt event types ────
CREATE OR REPLACE FUNCTION email_gate(p_org uuid, p_to_user uuid, p_event_type text, p_resource_id text DEFAULT NULL, p_subject text DEFAULT NULL, p_body text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_prefs notification_preferences%ROWTYPE;
  v_toggle boolean;
  v_resource uuid;
  v_last_subject text;
  v_last_body text;
BEGIN
  IF v_uid IS NULL THEN
    -- Only the service role (the cron, server routes) carries no uid. anon
    -- has no EXECUTE on this function (revoked below).
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'email_gate: not signed in' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM org_members
                    WHERE org_id = p_org AND uid = v_uid AND status = 'active') THEN
      RAISE EXCEPTION 'email_gate: not an active member of this workspace' USING ERRCODE = '42501';
    END IF;
    -- A member learns nothing about a person outside their org.
    IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org AND uid = p_to_user) THEN
      RETURN true;
    END IF;
  END IF;

  -- The recipient's preferences. No row = the column defaults = all on. A
  -- drawing recall ('safety_recall') and a PSM alert ('safety_alert') are
  -- un-mutable: no preference stops them, the master switch and 'never'
  -- included (DEC-74 §9). The dedupe below still applies to them.
  -- DELIV-15 (N9, DEC-90 A10): so is the transmittal issuer's notice that the
  -- portal released a PDF without its UNCONTROLLED marking
  -- ('transmittal_unstamped') or refused one ('transmittal_refused') — a
  -- controlled-copy integrity event, like a recall.
  IF COALESCE(p_event_type, '') NOT IN ('safety_recall', 'safety_alert', 'transmittal_unstamped', 'transmittal_refused') THEN
    SELECT * INTO v_prefs FROM notification_preferences WHERE user_id = p_to_user;
    IF FOUND THEN
      IF v_prefs.email_enabled IS FALSE THEN RETURN false; END IF;
      IF v_prefs.digest_frequency = 'never' THEN RETURN false; END IF;
      v_toggle := CASE p_event_type
        WHEN 'comment_mention'           THEN v_prefs.email_on_mention
        WHEN 'assignment'                THEN v_prefs.email_on_assignment
        WHEN 'engineer_review_requested' THEN v_prefs.email_on_assignment
        WHEN 'ticket_status_changed'     THEN v_prefs.email_on_status_change
        WHEN 'ticket_approved'           THEN v_prefs.email_on_status_change
        WHEN 'ticket_revision_requested' THEN v_prefs.email_on_status_change
        WHEN 'ticket_closed'             THEN v_prefs.email_on_status_change
        WHEN 'watcher_activity'          THEN v_prefs.email_on_watched_activity
        WHEN 'sla_warning'               THEN v_prefs.email_on_sla_warning
        ELSE true
      END;
      IF v_toggle IS FALSE THEN RETURN false; END IF;
    END IF;
  END IF;

  -- The 60-second dedupe merges a REPEAT only: the latest email this
  -- recipient got for the same event and resource, inside 60 seconds, has
  -- this subject AND this body. event_type is the sender's category, so a
  -- different message about the same resource shares it and is never merged,
  -- whether it differs in the subject (a hold placed, then released) or only
  -- in the body (a recall naming Rev B, then Rev C; two holds released, each
  -- with its reason); nor is a repeat that a different message has followed.
  -- A NULL subject or body never matches. Never for an email with no
  -- resource (two of those are not the same email).
  IF p_resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_resource := p_resource_id::uuid;
    SELECT e.subject, e.body_text INTO v_last_subject, v_last_body
      FROM email_notifications e
     WHERE e.to_user_id = p_to_user
       AND e.resource_id = v_resource
       AND e.event_type = p_event_type
       AND e.org_id = p_org
       AND e.created_at >= now() - interval '60 seconds'
     ORDER BY e.created_at DESC
     LIMIT 1;
    IF v_last_subject = p_subject AND v_last_body = p_body THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION email_gate(uuid, uuid, text, text, text, text) IS
  'May this email be queued? FALSE when the recipient opted out (master switch, never, or the event toggle; a recall, a safety alert and a transmittal issuer''s unstamped / refused-PDF notice are exempt from all three) or it repeats, within 60 s, the latest email to the same (recipient, event, resource) with the same subject and body. Active members of p_org and the service role only. notifications Round G, 20261148; the transmittal exemption added by 20261191 (N9, DELIV-15).';

REVOKE ALL ON FUNCTION email_gate(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION email_gate(uuid, uuid, text, text, text, text) TO authenticated, service_role;

-- ── 3. notifications_i_sent(): a member reads back the nudges they sent ─────
CREATE OR REPLACE FUNCTION notifications_i_sent(
  p_org uuid, p_kind text, p_since timestamptz,
  p_resource_type text DEFAULT NULL, p_resource_id text DEFAULT NULL, p_metadata jsonb DEFAULT NULL
)
RETURNS TABLE (user_id uuid, resource_type text, resource_id text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT n.user_id, n.resource_type, n.resource_id, n.created_at
    FROM notifications n
   WHERE auth.uid() IS NOT NULL
     AND p_kind IN ('overlap_advisory', 'checkout_conflict')
     AND EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = p_org AND m.uid = auth.uid() AND m.status = 'active')
     AND n.org_id = p_org
     AND n.actor_user_id = auth.uid()
     AND n.kind = p_kind
     AND n.created_at >= GREATEST(COALESCE(p_since, now()), now() - interval '30 days')
     AND (p_resource_type IS NULL OR n.resource_type = p_resource_type)
     AND (p_resource_id IS NULL OR n.resource_id = p_resource_id)
     AND (p_metadata IS NULL OR n.metadata @> p_metadata)
   ORDER BY n.created_at DESC
   LIMIT 500;
$$;

COMMENT ON FUNCTION notifications_i_sent(uuid, text, timestamptz, text, text, jsonb) IS
  'OS-6 / TAX-16: the notices the CALLER wrote (actor_user_id = auth.uid()) in p_org, of kind overlap_advisory or checkout_conflict only, inside 30 days at most — recipient, resource and time, never a title, body or metadata. An active member of p_org only; anything else answers no rows. lib/sentNotices.ts reads it for the edit-overlap heads-up and the /checkouts nudge cooldown. notifications Round G, 20261191 (N9).';

REVOKE ALL ON FUNCTION notifications_i_sent(uuid, text, timestamptz, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION notifications_i_sent(uuid, text, timestamptz, text, text, jsonb) TO authenticated;

-- ── 4. the backlog, re-filed by its metadata discriminators ────────────────
UPDATE notifications SET kind = 'ack_requested'
 WHERE kind = 'doc_superseded' AND metadata ? 'ackRequest';
UPDATE notifications SET kind = 'doc_recalled'
 WHERE kind = 'doc_superseded' AND metadata ? 'recall';
UPDATE notifications SET kind = 'package_doc_stale'
 WHERE kind = 'doc_superseded' AND metadata ? 'workPackageId';
UPDATE notifications SET kind = 'package_doc_retired'
 WHERE kind = 'doc_superseded' AND metadata ? 'packageId' AND metadata ? 'retirement';
UPDATE notifications SET kind = 'checkout_auto_released'
 WHERE kind = 'checkout_released' AND metadata ? 'autoReleasedSessionId';
UPDATE notifications SET kind = 'intake_quote'
 WHERE kind = 'review_requested' AND metadata ? 'intake' AND metadata ? 'quote';
UPDATE notifications SET kind = 'intake_submission'
 WHERE kind = 'review_requested' AND metadata ? 'intake';

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 9 ─────────
SELECT 'notification_kinds() is IMMUTABLE, search_path pinned, and declares 64 kinds — 21 of them compliance kinds — each once' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'notification_kinds'
                  AND pg_get_function_identity_arguments(p.oid) = ''
                  AND p.provolatile = 'i' AND NOT p.prosecdef
                  AND p.proconfig @> ARRAY['search_path=public'])
       AND (SELECT COUNT(*) = 64 AND COUNT(DISTINCT kind) = 64 AND COUNT(*) FILTER (WHERE compliance) = 21
              FROM notification_kinds()) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'notification_kinds() declares the nine new kinds; the six split off doc_superseded and review_requested are compliance kinds, the other three are not',
       (SELECT COUNT(*) = 9
               AND COUNT(*) FILTER (WHERE compliance) = 6
               AND COUNT(*) FILTER (WHERE compliance AND kind IN ('doc_recalled', 'doc_upstream_changed', 'package_doc_stale', 'package_doc_retired', 'intake_quote', 'intake_submission')) = 6
          FROM notification_kinds()
         WHERE kind IN ('doc_recalled', 'doc_upstream_changed', 'package_doc_stale', 'package_doc_retired',
                        'checkout_force_released', 'checkout_auto_released', 'intake_quote', 'intake_submission', 'transmittal_issued')),
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
SELECT 'email_gate(uuid,uuid,text,text,text,text) is the only email_gate, STABLE SECURITY DEFINER with search_path pinned, and exempts exactly the recall, safety and transmittal unstamped / refused event types',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                WHERE ns.nspname = 'public' AND p.proname = 'email_gate'
                  AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_to_user uuid, p_event_type text, p_resource_id text, p_subject text, p_body text'
                  AND pg_get_function_result(p.oid) = 'boolean'
                  AND p.prosecdef AND p.provolatile = 's'
                  AND p.proconfig @> ARRAY['search_path=public']
                  AND p.prosrc LIKE '%IF COALESCE(p_event_type, '''') NOT IN (''safety_recall'', ''safety_alert'', ''transmittal_unstamped'', ''transmittal_refused'') THEN%SELECT * INTO v_prefs%v_prefs.email_enabled IS FALSE%')
       AND (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'public' AND p.proname = 'email_gate') = 1,
       NULL
UNION ALL
SELECT 'email_gate: anon and PUBLIC cannot execute it, authenticated and service_role can',
       (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'email_gate'),
       NULL
UNION ALL
SELECT 'notifications_i_sent(...) answers the caller''s own rows of the two nudge kinds only; STABLE SECURITY DEFINER with search_path pinned; anon and PUBLIC cannot execute it, authenticated can',
       (SELECT p.prosecdef AND p.provolatile = 's'
               AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
               AND p.prosrc LIKE '%auth.uid() IS NOT NULL%p_kind IN (''overlap_advisory'', ''checkout_conflict'')%m.status = ''active''%n.actor_user_id = auth.uid()%interval ''30 days''%'
          FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'notifications_i_sent'),
       NULL
UNION ALL
SELECT 'AFTER: no doc_superseded row carries a discriminator, no checkout_released row an auto-release, no review_requested row an intake notice',
       NOT EXISTS (SELECT 1 FROM notifications
                    WHERE (kind = 'doc_superseded' AND (metadata ?| ARRAY['ackRequest', 'recall', 'workPackageId'] OR (metadata ? 'packageId' AND metadata ? 'retirement')))
                       OR (kind = 'checkout_released' AND metadata ? 'autoReleasedSessionId')
                       OR (kind = 'review_requested' AND metadata ? 'intake')),
       NULL
UNION ALL
SELECT '20261160''s insert rail is still bound (trg_notifications_enforce_insert) — this paste re-created only the allow-list it reads',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'notifications' AND t.tgname = 'trg_notifications_enforce_insert' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT '20261161''s read_at-only rule is still bound (trg_notifications_read_at_only) — the re-files ran as the SQL editor, which it lets through',
       EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'notifications' AND t.tgname = 'trg_notifications_read_at_only' AND NOT t.tgisinternal),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM notif_round_g_191_before ORDER BY ord) b;
