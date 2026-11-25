-- Pending database steps from the security fixes of Nov 25, 2026.
-- Run once, top to bottom, in the Supabase SQL editor. Safe to run more than once.
-- The app works the same before and after: these only stop rows the app
-- never writes. Needs 20260910_transmittal_portal.sql (portal columns),
-- which this database already has.
--
-- NOT included on purpose: dropping the client INSERT policy on
-- email_notifications. The browser still inserts into that table directly
-- (lib/notifications.ts queueEmail and queueExternalEmail), so dropping it
-- would stop those emails. Step 1 narrows it instead.

-- ════════ 1. email_notifications: who a browser-queued email may go to ════════
-- Replaces the policy from 20260605_rls_policies_new_tables.sql. Before, any
-- active member could queue a row for ANY address with any subject and body,
-- and the sender mailed it from the app's domain (an open relay). Now a row
-- from the browser must be a fresh queued row addressed to an active member
-- of the same workspace, or (the one outside kind the app sends) to the
-- recipient of an issued transmittal of that workspace. The server routes
-- write with the service role and are not affected; the sender route checks
-- the same rule again before it mails anything.
DROP POLICY IF EXISTS "email_notif_insert" ON email_notifications;
CREATE POLICY "email_notif_insert" ON email_notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM org_members m
            WHERE m.org_id = email_notifications.org_id
              AND m.uid = auth.uid() AND m.status = 'active')
    AND email_notifications.status = 'queued'
    AND email_notifications.attempt_count = 0
    AND (
      EXISTS (SELECT 1 FROM org_members r
              WHERE r.org_id = email_notifications.org_id
                AND r.status = 'active'
                AND lower(trim(r.email)) = lower(trim(email_notifications.to_email)))
      OR (
        email_notifications.event_type = 'transmittal_issued'
        AND EXISTS (SELECT 1 FROM transmittals t
                    WHERE t.id = email_notifications.resource_id
                      AND t.org_id = email_notifications.org_id
                      AND t.status IN ('issued', 'acknowledged')
                      AND lower(trim(t.recipient_email)) = lower(trim(email_notifications.to_email)))
      )
    )
  );

-- ════════ 2. transmittals: the database, not the browser, sets the portal link ════════
-- Transmittals are created and issued from the browser (lib/transmittals.ts),
-- which also picked the portal token, so a member could choose a guessable
-- one or insert a row already marked acknowledged. This function makes the
-- database mint the token whenever a row is created issued or a token is
-- set on an issued row, ignoring the browser's value, and lets a new row
-- start only as a draft or issued, with no receipt recorded. The app reads
-- the saved row back (select *) before it emails the link, so the email
-- carries the database's token.
CREATE OR REPLACE FUNCTION transmittals_server_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS NULL OR NEW.status NOT IN ('draft', 'issued') THEN
      NEW.status := 'draft';
    END IF;
    NEW.acknowledged_at := NULL;
    NEW.acknowledged_by_name := NULL;
    NEW.acknowledged_via := NULL;
    NEW.acknowledged_meta := NULL;
    NEW.portal_token := CASE WHEN NEW.status = 'issued'
      THEN left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 40)
      ELSE NULL END;
  ELSIF NEW.portal_token IS DISTINCT FROM OLD.portal_token THEN
    NEW.portal_token := CASE WHEN NEW.status = 'issued'
      THEN left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 40)
      ELSE OLD.portal_token END;
  END IF;
  RETURN NEW;
END;
$$;

-- Runs the function above before every insert and update on transmittals.
DROP TRIGGER IF EXISTS trg_transmittals_server_fields ON transmittals;
CREATE TRIGGER trg_transmittals_server_fields
  BEFORE INSERT OR UPDATE ON transmittals
  FOR EACH ROW EXECUTE FUNCTION transmittals_server_fields();
