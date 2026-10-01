-- ─────────────────────────────────────────────────────────────────────────────
-- notifications Round G — N1 PREFS-GATE: an email preference gate that can
-- see the recipient, and the pop-up toast switch (GAP-203).
--
--   DELIV-2  queueEmail read the RECIPIENT's notification_preferences row
--            through the CALLER's client. notif_prefs_own (20260605:111-115)
--            shows a signed-in member only their own row, so from a browser
--            every other member's opt-out read as "no row" = all on: the
--            master switch, 'never' and every per-event toggle were ignored
--            for every client-initiated email (every emit() producer).
--   DELIV-9  the 60-second dedupe read email_notifications through the same
--            client; email_notif_select_own_or_admin (20261047) shows a member
--            only the rows addressed to them, so the window never saw another
--            recipient's earlier email and never fired from a browser.
--   RT-10    no user preference could turn pop-up toasts off.
--
-- What this file does:
--   · email_gate(p_org, p_to_user, p_event_type, p_resource_id, p_subject,
--     p_body) — NEW, STABLE SECURITY DEFINER, search_path pinned. It answers
--     one question: may this email be queued? FALSE when the recipient's row
--     says email off (email_enabled = false), cadence 'never', or the event's
--     own toggle off (the same cases as lib/notificationPrefs.ts
--     emailAllowedByPrefs / shouldSendForEvent — 'system' and anything else
--     have no toggle). A drawing recall ('safety_recall') and a PSM alert
--     ('safety_alert') are un-mutable: no preference stops them, the master
--     switch and 'never' included (dispatch.ts:58-66, DEC-44 (N1) §9). FALSE
--     when the email is a REPEAT: the latest email this recipient got for the
--     same (event, resource, org) in the last 60 seconds has the same subject
--     AND the same body. event_type is emit()'s CATEGORY, so two different
--     messages about one document can share it — differing in the subject (a
--     hold placed / released, 'advanced to Rev C' / 'package went stale') or
--     only in the body (a recall naming Rev B, then Rev C; two holds
--     released, each with its reason). Those are never merged, and neither is
--     a repeat that a different message has followed (placed, released,
--     placed again). No row = the column defaults = TRUE. An email with no
--     resource is never deduped (the old window compared against '' and never
--     matched one either).
--     Callable by an ACTIVE member of p_org (a signed-in caller who is not
--     one is refused, 42501) or by the service role (the cron and server
--     routes carry no uid); a NULL uid that is not the service role is
--     refused. A member asking about a recipient who is not in p_org gets
--     TRUE without that person's row being read — the insert policy
--     (20261047) is the authority on who may be mailed. EXECUTE: REVOKEd
--     from PUBLIC and anon, GRANTed to authenticated and service_role.
--   · notification_preferences.toast_enabled BOOLEAN NOT NULL DEFAULT TRUE —
--     the pop-up toast switch (bell rows are always written; a durable
--     obligation is never suppressible). Existing rows get TRUE: no change.
--   · notification_preferences.inapp_enabled is marked DEPRECATED (COMMENT ON
--     COLUMN) and KEPT. No code reads it. It is not dropped: a dropped column
--     cannot be restored, and older backup envelopes carry it.
--   · push_enabled, the digest_frequency CHECK and every policy are untouched.
--     The settings page now writes 'instant' (the CHECK's own spelling); the
--     CHECK is NOT widened to accept 'immediate' (GAP-203: one spelling).
--
-- WIDENING (DEC-30): any active member may now learn, for a fellow member of
-- their own org, a yes/no derived from that member's email preferences and
-- recent queue (whether the latest email about one resource in the last
-- minute carried a given subject and body) — what queueEmail needs and
-- nothing more (no column, no row, no subject, no body, no address is
-- returned). Before this file
-- only the member, an Admin / Manager (the queue) and the service role could
-- read either. The inventory below counts the rows in reach.
--
-- DEPLOY ORDER: either order is safe. The N1 app tolerates the function's
-- absence (PGRST202 / 42883 → the old caller-side read, with a warning, and
-- the email still queued) and saves the settings page without toast_enabled
-- until the column exists. The old app never calls email_gate and its
-- settings page does not write toast_enabled.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe. Needs 20260529
-- (both tables) and 20261047 (email_notifications policies); 20260723's
-- inapp_enabled / push_enabled are read through to_jsonb, so the inventory
-- also runs on a database without them.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS notif_round_g_148_before;
CREATE TEMP TABLE notif_round_g_148_before AS
SELECT 'BEFORE: notification_preferences rows' AS inventory,
       (SELECT COUNT(*) FROM notification_preferences)::text AS n
UNION ALL
SELECT 'BEFORE: rows with digest_frequency = instant',
       (SELECT COUNT(*) FROM notification_preferences WHERE digest_frequency = 'instant')::text
UNION ALL
SELECT 'BEFORE: rows with digest_frequency = hourly (never implemented — the page now shows Immediately and says so)',
       (SELECT COUNT(*) FROM notification_preferences WHERE digest_frequency = 'hourly')::text
UNION ALL
SELECT 'BEFORE: rows with digest_frequency = daily (never implemented — the page now shows Immediately and says so)',
       (SELECT COUNT(*) FROM notification_preferences WHERE digest_frequency = 'daily')::text
UNION ALL
SELECT 'BEFORE: rows with digest_frequency = never',
       (SELECT COUNT(*) FROM notification_preferences WHERE digest_frequency = 'never')::text
UNION ALL
SELECT 'BEFORE: rows with email_enabled = false (opt-outs the browser could not see — DELIV-2)',
       (SELECT COUNT(*) FROM notification_preferences WHERE email_enabled = false)::text
UNION ALL
SELECT 'BEFORE: rows with any per-event email toggle off',
       (SELECT COUNT(*) FROM notification_preferences
         WHERE email_on_mention = false OR email_on_assignment = false OR email_on_status_change = false
            OR email_on_watched_activity = false OR email_on_sla_warning = false)::text
UNION ALL
SELECT 'BEFORE: rows with inapp_enabled = false (deprecated, read by nothing — 0 also when the column was never added)',
       (SELECT COUNT(*) FILTER (WHERE to_jsonb(np) ->> 'inapp_enabled' = 'false') FROM notification_preferences np)::text
UNION ALL
SELECT 'BEFORE: rows with push_enabled = false (untouched here — the push channel reads it)',
       (SELECT COUNT(*) FILTER (WHERE to_jsonb(np) ->> 'push_enabled' = 'false') FROM notification_preferences np)::text
UNION ALL
SELECT 'BEFORE: emails queued in the last 30 days to a recipient whose row said email off or never (DELIV-2''s reach)',
       (SELECT COUNT(*) FROM email_notifications e
          JOIN notification_preferences np ON np.user_id = e.to_user_id
         WHERE e.created_at >= now() - interval '30 days'
           AND (np.email_enabled = false OR np.digest_frequency = 'never'))::text
UNION ALL
SELECT 'BEFORE: emails queued in the last 30 days that repeat, within 60 s, the latest email to the same (recipient, event, resource) with the same subject and body (DELIV-9''s reach)',
       (SELECT COUNT(*) FROM email_notifications e
         WHERE e.created_at >= now() - interval '30 days'
           AND e.resource_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM email_notifications d
                        WHERE d.to_user_id = e.to_user_id AND d.resource_id = e.resource_id
                          AND d.event_type = e.event_type AND d.org_id = e.org_id AND d.id <> e.id
                          AND d.subject = e.subject AND d.body_text = e.body_text
                          AND d.created_at <= e.created_at
                          AND d.created_at >= e.created_at - interval '60 seconds'
                          AND NOT EXISTS (SELECT 1 FROM email_notifications x
                                           WHERE x.to_user_id = e.to_user_id AND x.resource_id = e.resource_id
                                             AND x.event_type = e.event_type AND x.org_id = e.org_id
                                             AND x.id <> e.id AND x.id <> d.id
                                             AND x.created_at >= d.created_at AND x.created_at <= e.created_at
                                             AND (x.subject <> e.subject OR x.body_text <> e.body_text))))::text;

BEGIN;

-- ── 1. the pop-up toast switch (RT-10) ──────────────────────────────────────
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS toast_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN notification_preferences.toast_enabled IS
  'Pop-up toasts for new bell items (notifications Round G, 20261148). Read by the toast listener through lib/notificationPrefs.ts readToastPreference, which fails open. Bell rows are always written regardless.';

-- ── 2. inapp_enabled: deprecated, kept ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'notification_preferences'
                AND column_name = 'inapp_enabled') THEN
    EXECUTE $c$COMMENT ON COLUMN notification_preferences.inapp_enabled IS 'DEPRECATED (notifications Round G, 20261148): read by no code. Bell rows are always written (a durable obligation is never suppressible); the in-app switch a member has is toast_enabled. Kept, not dropped: a dropped column cannot be restored, and older backup envelopes carry it.'$c$;
  END IF;
END $$;

-- ── 3. email_gate(): the preference rule + the 60-second dedupe ─────────────
-- A paste of one of this file's earlier drafts (four arguments, no subject;
-- five, no body) is replaced, not left beside the new one as an overload.
DROP FUNCTION IF EXISTS email_gate(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS email_gate(uuid, uuid, text, text, text);

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
  -- included (DEC-44 (N1) §9). The dedupe below still applies to them.
  IF COALESCE(p_event_type, '') NOT IN ('safety_recall', 'safety_alert') THEN
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
  'May this email be queued? FALSE when the recipient opted out (master switch, never, or the event toggle; a recall or safety alert is exempt from all three) or it repeats, within 60 s, the latest email to the same (recipient, event, resource) with the same subject and body. Active members of p_org and the service role only. notifications Round G, 20261148.';

REVOKE ALL ON FUNCTION email_gate(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION email_gate(uuid, uuid, text, text, text, text) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (ONE result set): expect ok = true × 9 ─────────
SELECT 'email_gate(uuid,uuid,text,text,text,text) is the only email_gate, returns boolean, is STABLE SECURITY DEFINER with search_path pinned' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'email_gate'
                  AND pg_get_function_identity_arguments(p.oid) = 'p_org uuid, p_to_user uuid, p_event_type text, p_resource_id text, p_subject text, p_body text'
                  AND pg_get_function_result(p.oid) = 'boolean'
                  AND p.prosecdef AND p.provolatile = 's'
                  AND p.proconfig @> ARRAY['search_path=public'])
       AND (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'email_gate') = 1 AS ok,
       NULL::text AS n
UNION ALL
SELECT 'email_gate: anon and PUBLIC cannot execute it, authenticated and service_role can',
       (SELECT NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'email_gate'),
       NULL
UNION ALL
SELECT 'email_gate: a NULL uid passes only as the service role, and a signed-in caller must be an active member of p_org',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'email_gate'
                  AND p.prosrc LIKE '%auth.role() IS DISTINCT FROM ''service_role''%'
                  AND p.prosrc LIKE '%org_id = p_org AND uid = v_uid AND status = ''active''%'),
       NULL
UNION ALL
SELECT 'email_gate: master switch, never, and the per-event toggles — a recall or a PSM alert passes all three (no toggle of its own)',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'email_gate'
                  AND p.prosrc LIKE '%IF COALESCE(p_event_type, '''') NOT IN (''safety_recall'', ''safety_alert'') THEN%SELECT * INTO v_prefs%v_prefs.email_enabled IS FALSE%'
                  AND p.prosrc LIKE '%v_prefs.digest_frequency = ''never''%'
                  AND p.prosrc LIKE '%WHEN ''comment_mention''%THEN v_prefs.email_on_mention%'
                  AND p.prosrc NOT LIKE '%WHEN ''safety%'),
       NULL
UNION ALL
SELECT 'email_gate: the dedupe merges only a repeat — the latest email to the same (recipient, resource, event, org) inside 60 seconds, with the same subject and body',
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'email_gate'
                  AND p.prosrc LIKE '%SELECT e.subject, e.body_text INTO v_last_subject, v_last_body%'
                  AND p.prosrc LIKE '%e.resource_id = v_resource%'
                  AND p.prosrc LIKE '%e.event_type = p_event_type%'
                  AND p.prosrc LIKE '%now() - interval ''60 seconds''%'
                  AND p.prosrc LIKE '%ORDER BY e.created_at DESC%LIMIT 1%'
                  AND p.prosrc LIKE '%IF v_last_subject = p_subject AND v_last_body = p_body THEN%'
                  AND p.prosrc NOT LIKE '%EXISTS (SELECT 1 FROM email_notifications%'),
       NULL
UNION ALL
SELECT 'notification_preferences.toast_enabled is boolean NOT NULL DEFAULT true',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'notification_preferences'
                  AND column_name = 'toast_enabled' AND data_type = 'boolean'
                  AND is_nullable = 'NO' AND column_default = 'true'),
       NULL
UNION ALL
SELECT 'inapp_enabled is kept and marked DEPRECATED (or was never added)',
       (NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'notification_preferences'
                       AND column_name = 'inapp_enabled'))
       OR COALESCE(col_description('public.notification_preferences'::regclass,
                     (SELECT attnum FROM pg_attribute
                       WHERE attrelid = 'public.notification_preferences'::regclass
                         AND attname = 'inapp_enabled' AND NOT attisdropped)) LIKE 'DEPRECATED%', false),
       NULL
UNION ALL
SELECT 'the digest_frequency CHECK is unchanged: instant, hourly, daily, never — and only those',
       (SELECT COUNT(*) = 1
               AND bool_and(pg_get_constraintdef(c.oid) LIKE '%''instant''%''hourly''%''daily''%''never''%')
               AND bool_and(pg_get_constraintdef(c.oid) NOT LIKE '%immediate%')
          FROM pg_constraint c
         WHERE c.conrelid = 'public.notification_preferences'::regclass AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) LIKE '%digest_frequency%'),
       NULL
UNION ALL
SELECT 'notification_preferences policies are untouched (notif_prefs_own only)',
       (SELECT COUNT(*) = 1 AND bool_and(policyname = 'notif_prefs_own')
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notification_preferences'),
       NULL
UNION ALL
SELECT 'AFTER: rows with toast_enabled = false (0 on the first paste)',
       NULL::boolean,
       (SELECT COUNT(*) FROM notification_preferences WHERE toast_enabled = false)::text
UNION ALL
SELECT inventory, NULL::boolean, n FROM notif_round_g_148_before;
