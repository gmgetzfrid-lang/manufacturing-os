-- ─────────────────────────────────────────────────────────────────────────────
-- 20261258_notif_roundG_delivery_record.sql
--
-- notifications Round G — N18 DELIVERY RECORD (drafting-flow EVID-9 done-whens
-- 1–4 and EVID-13's remainder, assigned at the DF-P7 merge; ruled under DEC-90:
-- fail-safe, no regression). Whether a notice reached a person becomes a fact
-- on the email row itself:
--
--   (1) email_notifications.status admits ONE new value, 'not_emailed' — "not
--       emailed by the person's own choice" (their master switch, delivery
--       "never", or the event's switch). Nothing drains it: the send-queued
--       drain claims only queued / failed, recovers only 'suppressed' and
--       reclaims only 'sending' (app/api/notifications/send-queued/route.ts),
--       so a not_emailed row is never mailed. Every existing status keeps
--       exactly its meaning and its drain; 'suppressed' is untouched (DF-P7
--       found the drain re-queues it — hence a NEW status).
--   (2) Seven nullable delivery columns, nothing renamed:
--       provider_message_id (the id the provider answered the send with —
--       written by the drain), delivery_status ('delayed' | 'delivered' |
--       'failed' | 'bounced' | 'complained'), delivery_detail (the provider's
--       words, at most 500 characters), delivered_at, bounced_at,
--       complained_at, delivery_updated_at. 'sent' keeps meaning "handed to
--       the provider"; 'delivered' is a separate fact (EVID-9 done-when 1).
--       One partial UNIQUE index on provider_message_id.
--   (3) record_email_delivery(id, outcome, at, detail) — SECURITY DEFINER,
--       search_path pinned, EXECUTE for service_role only (DRLS-16), refuses
--       any caller with a session. The signed delivery webhook
--       (app/api/webhooks/resend/route.ts) calls it: it writes the outcome
--       onto the row the provider id names, keeps the FIRST time of each
--       outcome, and lets a stronger outcome win (complained > bounced =
--       failed > delivered > delayed), so redelivered or out-of-order reports
--       are harmless. Answers 'recorded' or 'no_row'.
--   (4) enforce_email_delivery_record() — BEFORE INSERT OR UPDATE. For EVERY
--       writer (the service role included) a not_emailed record that repeats,
--       within 60 seconds, the latest not_emailed record for the same
--       (recipient, event, resource) with the same subject and body is not
--       written (the row is skipped, no error) — email_gate()'s repeat rule,
--       mirrored for records, so a burst an opted-in person gets as ONE email
--       is ONE record for an opted-out person. Then, for a signed-in writer
--       only (the service role passes): a client never
--       writes a delivery outcome; a not_emailed row is accepted only when
--       email_gate() itself says the recipient's preferences turn this email
--       off (a member cannot forge "they opted out"); and an Admin / Manager
--       update (the dead-letter re-queue, 20261047) can neither re-queue a
--       not_emailed row nor re-label another row as one.
--   (5) email_gate() re-created from its NEWEST definition (20261191) with ONE
--       added line: the 60-second repeat check ignores not_emailed rows, so a
--       person who turns email back on within the minute gets the next notice
--       exactly as today (no row existed for the one they were not sent).
--       Byte fidelity: lib/__tests__/n18DeliveryRecordMigration.test.ts.
--
-- What it does NOT do: no client gains a read or a write (the three
-- email_notifications policies are untouched); no new table; no notification
-- kind; nothing is backfilled or re-queued.
--
-- PASTE / DEPLOY ORDER. Paste AFTER 20261148 and 20261191 (the first
-- statement refuses otherwise, changing nothing). Either order with the N18
-- deploy is safe; RECOMMENDED: deploy the app first, then paste.
--   * App deployed, not pasted: queueEmail's not_emailed insert is refused by
--     the old CHECK (23514) and logged once — nothing is recorded, every email
--     is sent or not sent exactly as today; the drain's 'sent' update with
--     provider_message_id fails (PGRST204 / 42703) and is re-sent without it
--     — today's update; the webhook answers 503 "paste 20261258" (PGRST202 /
--     42883) and records nothing (the provider retries); the trail reads
--     without the new columns (42703 / PGRST204 → today's columns, said).
--   * Pasted, app not yet deployed: the old app never writes not_emailed or
--     the new columns; email_gate's extra line matches no row.
-- NOT A WIDENING: nobody may do more. The inventory below counts the rows the
-- new rules bear on, BEFORE the DDL.
-- Re-runnable: ADD COLUMN IF NOT EXISTS, each CHECK dropped and re-added,
-- CREATE OR REPLACE, DROP … IF EXISTS.
-- Single paste: prerequisite check → temp-table inventory (counts only) →
-- BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean, n text).
-- ⚠ APPLIED BY HAND (DEC-30).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.email_notifications') IS NULL
     OR to_regprocedure('public.email_gate(uuid, uuid, text, text, text, text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'email_gate' AND prosrc LIKE '%''transmittal_unstamped''%') THEN
    RAISE EXCEPTION '20261258 needs 20261148 (email_gate) and 20261191 (its newest body) pasted first; nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS notif_round_g_258_before;
CREATE TEMP TABLE notif_round_g_258_before AS
SELECT 1 AS ord, 'inventory (before apply): email queue rows in all' AS inventory,
       COUNT(*)::text AS n FROM email_notifications
UNION ALL
SELECT 2, 'inventory (before apply): rows handed to the provider (status sent) — each now keeps the configured notice-record retention under the purge (the app, not this paste)',
       COUNT(*)::text FROM email_notifications WHERE status = 'sent'
UNION ALL
SELECT 3, 'inventory (before apply): rows parked as suppressed (an earlier build) — unchanged by this paste; the drain still recovers those of the last 7 days',
       COUNT(*)::text FROM email_notifications WHERE status = 'suppressed'
UNION ALL
SELECT 4, 'inventory (before apply): CHECK constraints on email_notifications.status (expected 1)',
       COUNT(*)::text FROM pg_constraint
        WHERE conrelid = 'public.email_notifications'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%queued%';

BEGIN;

-- ── 1. status: one new value, 'not_emailed' (every earlier value kept) ──────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.email_notifications'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%queued%'
  LOOP
    EXECUTE format('ALTER TABLE email_notifications DROP CONSTRAINT %I', r.conname);
  END LOOP;
END
$$;
ALTER TABLE email_notifications ADD CONSTRAINT email_notifications_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'not_emailed'));

-- ── 2. the provider's outcome on the row ────────────────────────────────────
ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS delivery_detail TEXT;
ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;
ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ;
ALTER TABLE email_notifications ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;
ALTER TABLE email_notifications DROP CONSTRAINT IF EXISTS email_notifications_delivery_status_check;
ALTER TABLE email_notifications ADD CONSTRAINT email_notifications_delivery_status_check
  CHECK (delivery_status IS NULL OR delivery_status IN ('delayed', 'delivered', 'failed', 'bounced', 'complained'));
CREATE UNIQUE INDEX IF NOT EXISTS email_notifications_provider_message_idx
  ON email_notifications (provider_message_id) WHERE provider_message_id IS NOT NULL;

COMMENT ON COLUMN email_notifications.provider_message_id IS
  'The id the email provider answered the send with (written by the send-queued drain); the delivery webhook finds the row by it. 20261258, notifications N18 (EVID-9).';
COMMENT ON COLUMN email_notifications.delivery_status IS
  'The strongest outcome the provider reported for this email (complained > bounced = failed > delivered > delayed), from its signed webhook — NULL until one arrives. status = sent only means handed to the provider. 20261258 (EVID-9).';

-- ── 3. record_email_delivery: the webhook's one write ───────────────────────
CREATE OR REPLACE FUNCTION record_email_delivery(p_provider_message_id text, p_outcome text, p_at timestamptz DEFAULT NULL, p_detail text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_at timestamptz := COALESCE(p_at, now());
  v_rank int;
  v_n int;
BEGIN
  -- The provider's outcome is written by the server alone (the signed
  -- webhook, on the service role); a session never writes one.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'record_email_delivery: a delivery outcome is recorded by the server alone' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_provider_message_id, '') = '' THEN
    RAISE EXCEPTION 'record_email_delivery: no provider message id' USING ERRCODE = '22023';
  END IF;
  v_rank := CASE p_outcome WHEN 'delayed' THEN 1 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 3 WHEN 'bounced' THEN 3 WHEN 'complained' THEN 4 ELSE NULL END;
  IF v_rank IS NULL THEN
    RAISE EXCEPTION 'record_email_delivery: unknown outcome %', p_outcome USING ERRCODE = '22023';
  END IF;

  -- The first time of each outcome is kept; the strongest outcome wins, so a
  -- redelivered or out-of-order report changes nothing it should not.
  UPDATE email_notifications e
     SET delivered_at = CASE WHEN p_outcome = 'delivered' THEN COALESCE(e.delivered_at, v_at) ELSE e.delivered_at END,
         bounced_at = CASE WHEN p_outcome = 'bounced' THEN COALESCE(e.bounced_at, v_at) ELSE e.bounced_at END,
         complained_at = CASE WHEN p_outcome = 'complained' THEN COALESCE(e.complained_at, v_at) ELSE e.complained_at END,
         delivery_detail = CASE WHEN v_rank > CASE e.delivery_status WHEN 'delayed' THEN 1 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 3 WHEN 'bounced' THEN 3 WHEN 'complained' THEN 4 ELSE 0 END
                                THEN left(p_detail, 500) ELSE e.delivery_detail END,
         delivery_status = CASE WHEN v_rank > CASE e.delivery_status WHEN 'delayed' THEN 1 WHEN 'delivered' THEN 2 WHEN 'failed' THEN 3 WHEN 'bounced' THEN 3 WHEN 'complained' THEN 4 ELSE 0 END
                                THEN p_outcome ELSE e.delivery_status END,
         delivery_updated_at = now()
   WHERE e.provider_message_id = p_provider_message_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n = 0 THEN 'no_row' ELSE 'recorded' END;
END;
$$;

COMMENT ON FUNCTION record_email_delivery(text, text, timestamptz, text) IS
  'Write the provider''s reported outcome (delayed / delivered / failed / bounced / complained) onto the email row its message id names: first time of each kept, strongest outcome wins. Service role only (the signed delivery webhook). 20261258, notifications N18 (EVID-9).';

REVOKE ALL ON FUNCTION record_email_delivery(text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_email_delivery(text, text, timestamptz, text) TO service_role;

-- ── 4. a client never writes an outcome, never forges or re-queues a choice ─
CREATE OR REPLACE FUNCTION enforce_email_delivery_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_last_subject text;
  v_last_body text;
BEGIN
  -- A repeat of a record is merged as email_gate() merges a repeated email:
  -- the latest not_emailed record to this recipient for the same event and
  -- resource, inside 60 seconds, has this subject AND this body — nothing is
  -- written. Every writer, the service role included. A NULL subject or body
  -- never matches; never for a record with no resource.
  IF TG_OP = 'INSERT' AND NEW.status = 'not_emailed' AND NEW.resource_id IS NOT NULL THEN
    SELECT e.subject, e.body_text INTO v_last_subject, v_last_body
      FROM email_notifications e
     WHERE e.to_user_id = NEW.to_user_id
       AND e.resource_id = NEW.resource_id
       AND e.event_type = NEW.event_type
       AND e.org_id = NEW.org_id
       AND e.status = 'not_emailed'
       AND e.created_at >= now() - interval '60 seconds'
     ORDER BY e.created_at DESC
     LIMIT 1;
    IF v_last_subject = NEW.subject AND v_last_body = NEW.body_text THEN
      RETURN NULL;
    END IF;
  END IF;
  -- The service role (the drain, the webhook, server producers) passes.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_message_id IS NOT NULL OR NEW.delivery_status IS NOT NULL OR NEW.delivery_detail IS NOT NULL
       OR NEW.delivered_at IS NOT NULL OR NEW.bounced_at IS NOT NULL OR NEW.complained_at IS NOT NULL
       OR NEW.delivery_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'A delivery outcome is recorded by the server from the provider''s signed report, never written by a client.'
        USING ERRCODE = '42501';
    END IF;
    -- "Not emailed by their choice" only when the recipient's own
    -- preferences turn this email off — asked of email_gate() itself, with no
    -- resource, so its repeat check plays no part.
    IF NEW.status = 'not_emailed' AND email_gate(NEW.org_id, NEW.to_user_id, NEW.event_type) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Not emailed by their choice is recorded only when the person''s own preferences turn this email off.'
        USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE by a signed-in Admin / Manager (the dead-letter re-queue, 20261047).
  IF (OLD.status = 'not_emailed') IS DISTINCT FROM (NEW.status = 'not_emailed') THEN
    RAISE EXCEPTION 'A record that a person chose not to be emailed is never re-queued, and a queued email is never re-labelled as their choice.'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_email_delivery_record() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_email_delivery_record ON email_notifications;
CREATE TRIGGER trg_email_delivery_record
BEFORE INSERT OR UPDATE ON email_notifications
FOR EACH ROW EXECUTE FUNCTION enforce_email_delivery_record();

-- ── 5. email_gate(): the newest body (20261191) + one line ──────────────────
-- The repeat check ignores a not_emailed row (a record, never a sent email).
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
       AND e.status <> 'not_emailed'
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
  'May this email be queued? FALSE when the recipient opted out (master switch, never, or the event toggle; a recall, a safety alert and a transmittal issuer''s unstamped / refused-PDF notice are exempt from all three) or it repeats, within 60 s, the latest email to the same (recipient, event, resource) with the same subject and body — a not_emailed record is never a repeat. Active members of p_org and the service role only. notifications Round G, 20261148; the transmittal exemption added by 20261191 (N9, DELIV-15); not_emailed ignored by 20261258 (N18, EVID-9).';

REVOKE ALL ON FUNCTION email_gate(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION email_gate(uuid, uuid, text, text, text, text) TO authenticated, service_role;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- Probes: ok = true × 8 on a correct paste. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'EVID-9: email_notifications.status admits not_emailed and every earlier value (queued, sending, sent, failed, suppressed) — one status CHECK' AS check,
       (SELECT COUNT(*) = 1 FROM pg_constraint
         WHERE conrelid = 'public.email_notifications'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%queued%')
       AND (SELECT pg_get_constraintdef(oid) LIKE '%''queued''%' AND pg_get_constraintdef(oid) LIKE '%''sending''%'
                   AND pg_get_constraintdef(oid) LIKE '%''sent''%' AND pg_get_constraintdef(oid) LIKE '%''failed''%'
                   AND pg_get_constraintdef(oid) LIKE '%''suppressed''%' AND pg_get_constraintdef(oid) LIKE '%''not_emailed''%'
              FROM pg_constraint WHERE conname = 'email_notifications_status_check' AND conrelid = 'public.email_notifications'::regclass) AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'EVID-9: the seven delivery columns are on email_notifications (all nullable)',
       (SELECT COUNT(*) = 7 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'email_notifications' AND is_nullable = 'YES'
           AND column_name IN ('provider_message_id', 'delivery_status', 'delivery_detail', 'delivered_at', 'bounced_at', 'complained_at', 'delivery_updated_at')),
       NULL
UNION ALL
SELECT 1, 3, 'delivery_status takes only delayed / delivered / failed / bounced / complained; provider_message_id is unique where set',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_notifications_delivery_status_check'
                  AND pg_get_constraintdef(oid) LIKE '%''complained''%' AND pg_get_constraintdef(oid) LIKE '%''delayed''%')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'email_notifications'
                      AND indexname = 'email_notifications_provider_message_idx' AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%provider_message_id IS NOT NULL%'),
       NULL
UNION ALL
SELECT 1, 4, 'DRLS-16: record_email_delivery is SECURITY DEFINER, search_path pinned, EXECUTE for service_role only, and refuses a session',
       (SELECT prosecdef AND proconfig @> ARRAY['search_path=public'] AND prosrc LIKE '%IF auth.uid() IS NOT NULL THEN%'
          FROM pg_proc WHERE proname = 'record_email_delivery')
       AND NOT has_function_privilege('anon', 'public.record_email_delivery(text,text,timestamptz,text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.record_email_delivery(text,text,timestamptz,text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.record_email_delivery(text,text,timestamptz,text)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 1, 5, 'record_email_delivery keeps the first time of each outcome and lets the strongest outcome win',
       (SELECT prosrc LIKE '%COALESCE(e.delivered_at, v_at)%' AND prosrc LIKE '%COALESCE(e.bounced_at, v_at)%'
               AND prosrc LIKE '%THEN p_outcome ELSE e.delivery_status END%'
          FROM pg_proc WHERE proname = 'record_email_delivery'),
       NULL
UNION ALL
SELECT 1, 6, 'trg_email_delivery_record: BEFORE INSERT OR UPDATE, enabled; its function is SECURITY DEFINER with search_path pinned, merges a repeated not_emailed record and asks email_gate before a not_emailed row',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_email_delivery_record' AND tgrelid = 'public.email_notifications'::regclass
                  AND NOT tgisinternal AND tgenabled = 'O')
       AND (SELECT prosecdef AND proconfig @> ARRAY['search_path=public']
                   AND prosrc LIKE '%NEW.status = ''not_emailed'' AND email_gate(NEW.org_id, NEW.to_user_id, NEW.event_type) IS DISTINCT FROM false%'
                   AND prosrc LIKE '%(OLD.status = ''not_emailed'') IS DISTINCT FROM (NEW.status = ''not_emailed'')%'
                   AND prosrc LIKE '%AND e.status = ''not_emailed''%'
                   AND prosrc LIKE '%IF v_last_subject = NEW.subject AND v_last_body = NEW.body_text THEN%'
              FROM pg_proc WHERE proname = 'enforce_email_delivery_record'),
       NULL
UNION ALL
SELECT 1, 7, 'email_gate: the repeat check ignores not_emailed rows; the exempt list (recall, PSM alert, the transmittal pair) is kept; still SECURITY DEFINER, search_path pinned, one definition',
       (SELECT prosecdef AND proconfig @> ARRAY['search_path=public']
               AND prosrc LIKE '%AND e.status <> ''not_emailed''%'
               AND prosrc LIKE '%NOT IN (''safety_recall'', ''safety_alert'', ''transmittal_unstamped'', ''transmittal_refused'')%'
          FROM pg_proc WHERE proname = 'email_gate')
       AND (SELECT COUNT(*) = 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = 'email_gate'),
       NULL
UNION ALL
SELECT 1, 8, 'the three email_notifications policies are untouched (no client gains a read or a write)',
       (SELECT COUNT(*) = 3 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_notifications'
         AND policyname IN ('email_notif_insert', 'email_notif_select_own_or_admin', 'email_notif_update_admin_requeue'))
       AND (SELECT COUNT(*) = 3 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_notifications'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM notif_round_g_258_before
UNION ALL
SELECT 3, 1, 'after: not_emailed records (0 right after the paste)', NULL,
       (SELECT COUNT(*) FROM email_notifications WHERE status = 'not_emailed')::text
) AS final_rows
ORDER BY sec, ord;
