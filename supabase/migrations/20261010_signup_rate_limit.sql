-- 20261010_signup_rate_limit.sql
--
-- Durable, IP-keyed attempt log for the public signup endpoint. The route
-- runs on serverless functions with no shared memory, so an in-process
-- counter is useless — every cold start forgets it. This tiny table is the
-- shared state: signup inserts one row per attempt and counts recent rows
-- for the same IP before proceeding.
--
-- Purpose (finding H4 / "unauthenticated reconnaissance"): signup has no
-- CAPTCHA and returns distinguishable 409s for taken email / org names, so
-- an unbounded loop could enumerate accounts and burn trial orgs. Rate
-- limiting doesn't hide the messages (org-name-taken is a real UX need — it
-- routes people to "Request Access") but it caps how fast anyone can probe.
--
-- Only the service role touches this table (the signup route uses the
-- service key); RLS is ON with no policies, so anon/authenticated clients
-- can neither read the attempt history nor forge rows.

CREATE TABLE IF NOT EXISTS signup_attempts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip         TEXT NOT NULL,
  email      TEXT,
  outcome    TEXT,                      -- 'ok' | 'rejected' | 'error'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The hot query is "how many attempts from this IP since <cutoff>".
CREATE INDEX IF NOT EXISTS signup_attempts_ip_time_idx
  ON signup_attempts (ip, created_at DESC);

ALTER TABLE signup_attempts ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service-role only.

-- Housekeeping: this table only needs a rolling window. A periodic prune
-- keeps it from growing unbounded; the maintenance cron can call this, and
-- it's safe to run anytime.
CREATE OR REPLACE FUNCTION prune_signup_attempts() RETURNS void
LANGUAGE sql AS $$
  DELETE FROM signup_attempts WHERE created_at < NOW() - INTERVAL '2 days';
$$;
