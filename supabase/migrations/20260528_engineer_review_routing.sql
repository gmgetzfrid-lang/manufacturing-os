-- 20260528_engineer_review_routing.sql
-- Phase A of the drafting-workflow upgrade.
--
-- Adds the missing engineer-routing fields to `tickets` so:
--   1. Non-engineer requesters route their "approve" through an engineer
--      instead of silently signing off on engineering work (PSM concern).
--   2. The supervisor flagging a ticket for engineering-team review can
--      pick a SPECIFIC engineer instead of broadcasting to "any engineer".
--
-- assigned_engineer_id is the canonical routing field. assigned_engineer_name
-- is captured at the moment of assignment so the displayed name is immutable
-- if the user later changes their profile. Timestamps support audit + SLA.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS assigned_engineer_id UUID,
  ADD COLUMN IF NOT EXISTS assigned_engineer_name TEXT,
  ADD COLUMN IF NOT EXISTS assigned_engineer_email TEXT,
  ADD COLUMN IF NOT EXISTS engineer_review_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS engineer_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS engineer_review_reason TEXT;

CREATE INDEX IF NOT EXISTS tickets_assigned_engineer_idx
  ON tickets(assigned_engineer_id)
  WHERE assigned_engineer_id IS NOT NULL;
