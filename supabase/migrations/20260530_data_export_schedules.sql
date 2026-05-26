-- 20260530_data_export_schedules.sql
-- Phase D3 + D4 of data portability.
--
-- D3: scheduled push to customer-owned destinations (S3 / R2 / generic
--     webhook). Customer provides credentials; we encrypt them at rest
--     and only decrypt at push time. They own the backup destination.
--
-- D4: single-archive ZIP exports containing the JSON dump AND every
--     binary file inline. Tracked alongside scheduled runs via the
--     export_runs table.
--
-- Every run, manual or scheduled, lands a row in export_runs so customers
-- can see a complete chain-of-custody of when each export happened, who
-- triggered it, how big it was, where it went, and whether it succeeded.

CREATE TABLE IF NOT EXISTS export_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  destination_type TEXT NOT NULL CHECK (destination_type IN ('s3','r2','webhook')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- S3 / R2 / S3-compatible
  endpoint TEXT,             -- e.g. https://s3.us-east-1.amazonaws.com OR https://<acct>.r2.cloudflarestorage.com
  region TEXT,
  bucket TEXT,
  prefix TEXT,               -- key prefix within the bucket
  access_key_id_encrypted TEXT,
  secret_access_key_encrypted TEXT,

  -- Generic webhook (customer-controlled HTTP endpoint)
  webhook_url TEXT,
  webhook_secret_encrypted TEXT,    -- HMAC-SHA256 signing secret

  -- Schedule (manual = run only on explicit trigger)
  schedule_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (schedule_kind IN ('manual','daily','weekly','monthly')),
  schedule_hour_utc INT,            -- 0..23, hour of day for daily/weekly/monthly
  schedule_day_of_week INT,         -- 0=Sun..6=Sat, weekly only
  schedule_day_of_month INT,        -- 1..31, monthly only
  next_run_at TIMESTAMPTZ,          -- computed forward; cron looks at this

  -- Content options
  include_files BOOLEAN NOT NULL DEFAULT TRUE,
  retention_days INT,               -- enforce keep-last-N-days in their bucket

  -- Audit of the most recent run for the cards UI
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  last_run_error TEXT,
  last_run_bytes BIGINT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);

CREATE INDEX IF NOT EXISTS export_destinations_org_idx ON export_destinations(org_id);
CREATE INDEX IF NOT EXISTS export_destinations_next_run_idx
  ON export_destinations(enabled, next_run_at)
  WHERE enabled = TRUE AND next_run_at IS NOT NULL;

-- Every run (manual + scheduled + direct-download ZIP) writes a row
-- here. The customer's audit log + UI both pull from this.
CREATE TABLE IF NOT EXISTS export_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  destination_id UUID REFERENCES export_destinations(id) ON DELETE SET NULL,

  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','api')),
  triggered_by UUID,                 -- user id if available
  triggered_by_email TEXT,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','cancelled')),

  -- What was exported
  table_count INT,
  total_rows INT,
  file_count INT,
  total_bytes BIGINT,

  -- Result
  download_url TEXT,                 -- temp signed URL if we stored it ourselves
  download_url_expires_at TIMESTAMPTZ,
  destination_path TEXT,             -- e.g. "exports/<org>/<timestamp>.zip" in their bucket
  destination_type TEXT,             -- snapshot of where this went

  -- Diagnostics
  error_message TEXT,
  diagnostics JSONB,                 -- per-step trace

  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INT
);

CREATE INDEX IF NOT EXISTS export_runs_org_idx ON export_runs(org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS export_runs_destination_idx ON export_runs(destination_id, started_at DESC);
