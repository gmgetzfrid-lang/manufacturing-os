-- 20260916_ai_governance.sql
--
-- AI key governance + spend metering:
--
--   1. ai_key_agreements — signed acceptable-use records. scope 'use' rows
--      are the general agreement EVERY user signs before their first
--      question (who, agreement version, when, from where); 'org'/'personal'
--      rows remain for key-save records. Service-role only — airtight, not
--      client-editable.
--   2. ai_usage_events grows token/cost columns: every knowledge ask
--      records exact input/output tokens (providers return them) and an
--      estimated cost from the in-app price table.
--   3. ai_usage_limits — monthly caps. One org-default row (user_id NULL,
--      $10/month unless changed) + optional per-user overrides. Enforced
--      server-side in the ask route BEFORE any provider call.
--
-- The provider allowlist (Claude/OpenAI ONLY, all scopes — nothing that can
-- train on submitted data) is code-enforced in the connection + ask routes;
-- no schema needed.
--
-- Idempotent. Apply after 20260915.

CREATE TABLE IF NOT EXISTS ai_key_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  user_name TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'personal', 'use')),
  provider TEXT NOT NULL,
  key_last4 TEXT,
  agreement_version TEXT NOT NULL,
  ip TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_key_agreements_org_idx
  ON ai_key_agreements (org_id, accepted_at DESC);
-- Re-runnable on a DB that applied the earlier ('org','personal')-only shape:
ALTER TABLE ai_key_agreements DROP CONSTRAINT IF EXISTS ai_key_agreements_scope_check;
ALTER TABLE ai_key_agreements ADD CONSTRAINT ai_key_agreements_scope_check
  CHECK (scope IN ('org', 'personal', 'use'));

ALTER TABLE ai_key_agreements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_key_agreements FROM public, anon, authenticated;

ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS input_tokens INTEGER;
ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS output_tokens INTEGER;
ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS est_cost_usd NUMERIC;
CREATE INDEX IF NOT EXISTS ai_usage_events_user_month_idx
  ON ai_usage_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID,                                -- NULL = the org default
  monthly_cap_usd NUMERIC NOT NULL DEFAULT 10,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_limits_org_default_idx
  ON ai_usage_limits (org_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_limits_user_idx
  ON ai_usage_limits (org_id, user_id) WHERE user_id IS NOT NULL;

ALTER TABLE ai_usage_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_usage_limits FROM public, anon, authenticated;
