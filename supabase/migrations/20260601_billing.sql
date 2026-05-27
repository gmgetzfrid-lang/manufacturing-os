-- 20260601_billing.sql
-- Phase 1 of billing: trial timer + subscription state fields on orgs.
--
-- Every new org starts with a 60-day trial (subscription_status='trialing',
-- trial_ends_at=NOW()+60 days, set by the signup endpoint).
--
-- Existing orgs created before this migration get a 60-day trial from the
-- moment this migration runs, so nobody is locked out the day this ships.
--
-- Phase 2 (Stripe) populates stripe_customer_id / stripe_subscription_id /
-- subscribed_plan / current_period_end via the webhook handler.

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing','active','past_due','canceled','unpaid','paused')),
  ADD COLUMN IF NOT EXISTS subscribed_plan TEXT,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- Existing orgs (created before billing was added) get a 60-day trial from
-- now. This is the migration window — if they don't subscribe in those 60
-- days they'll need to before access is gated.
UPDATE orgs
SET trial_ends_at = NOW() + INTERVAL '60 days'
WHERE trial_ends_at IS NULL;

CREATE INDEX IF NOT EXISTS orgs_subscription_status_idx ON orgs(subscription_status);
CREATE INDEX IF NOT EXISTS orgs_trial_ends_idx ON orgs(trial_ends_at) WHERE trial_ends_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orgs_stripe_customer_idx ON orgs(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
