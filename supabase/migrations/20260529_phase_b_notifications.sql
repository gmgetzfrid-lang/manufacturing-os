-- 20260529_phase_b_notifications.sql
-- Phase B of the drafting workflow:
--   B1: @mentions in comments — no schema change (mentions stored inside
--       the comments JSONB blob with a `mentionedUserIds` array per comment)
--   B2: Watch / Subscribe — tickets.watchers UUID[] of opted-in users
--   B3: Email notifications — queue table + per-user preferences
--   B4: SLA target dates — tickets.target_completion_at + breach timestamp

-- ─── B2: WATCHERS ─────────────────────────────────────────────────────────
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS watchers UUID[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS tickets_watchers_idx ON tickets USING GIN (watchers);

-- ─── B4: SLA / TARGET DATES ───────────────────────────────────────────────
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS target_completion_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breach_warned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tickets_target_completion_idx
  ON tickets(target_completion_at)
  WHERE target_completion_at IS NOT NULL;

-- ─── B3: EMAIL NOTIFICATION QUEUE ─────────────────────────────────────────
-- Producers (the app) insert rows here. A consumer (Next.js API route
-- /api/notifications/send-queued OR a scheduled Edge Function) reads queued
-- rows and dispatches them via the configured email provider, marking them
-- sent/failed. Idempotent retries are safe because of attempt_count.
CREATE TABLE IF NOT EXISTS email_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  to_user_id UUID NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,

  -- What triggered this notification
  resource_type TEXT,            -- 'ticket' | 'project' | 'document'
  resource_id UUID,
  event_type TEXT NOT NULL,      -- 'ticket_status_changed' | 'comment_mention' | 'watcher_activity' | 'sla_warning' | 'engineer_review_requested' | etc
  metadata JSONB,

  -- Delivery state
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','failed','suppressed')),
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_message TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup of work the sender needs to process
CREATE INDEX IF NOT EXISTS email_notifications_pending_idx
  ON email_notifications(status, created_at)
  WHERE status IN ('queued','failed');

-- Suppress duplicate notifications within a short window
CREATE INDEX IF NOT EXISTS email_notifications_dedupe_idx
  ON email_notifications(to_user_id, resource_id, event_type, created_at DESC);

-- ─── PER-USER NOTIFICATION PREFERENCES ────────────────────────────────────
-- Users can opt out of categories. Default everything on so new users get
-- the full experience; they can dial it down in their settings.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_mention BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_assignment BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_status_change BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_watched_activity BOOLEAN NOT NULL DEFAULT TRUE,
  email_on_sla_warning BOOLEAN NOT NULL DEFAULT TRUE,
  digest_frequency TEXT NOT NULL DEFAULT 'instant'
    CHECK (digest_frequency IN ('instant','hourly','daily','never')),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Optional: per-org default SLA per request type. Keeps things flexible
-- without hard-coding business rules in app code.
CREATE TABLE IF NOT EXISTS sla_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL,
  default_days INT NOT NULL,
  warn_before_days INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, request_type)
);
