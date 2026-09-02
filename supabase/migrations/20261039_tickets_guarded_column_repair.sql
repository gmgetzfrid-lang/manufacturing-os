-- ─────────────────────────────────────────────────────────────────────────────
-- Repair: every column the 20261038 ticket triggers reference must exist.
--
-- The 20261038 verification's late-binding probe ("every guarded column
-- exists on tickets") returned FALSE live: at least one of the 22 columns the
-- BEFORE INSERT / BEFORE UPDATE guards name is absent from the deployed
-- tickets table — i.e. an earlier hand-applied migration (engineer routing
-- 20260528, deliverable rev 20260827, archive 20260809/20260811) never landed
-- there. plpgsql binds NEW.<col> at execution, so with a column missing every
-- authenticated client UPDATE on tickets raises "record new has no field".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS with the canonical types from
-- schema.sql / the originating migrations. The app already reads and writes
-- all of these (lib/ticketTransitions.ts, rowToTicket), so adding a missing
-- one is strictly the repair the un-applied migration owed. The final SELECT
-- reports, per column, whether it existed BEFORE this ran and whether it
-- exists now — paste that back so the record names what was missing.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TEMP TABLE _tickets_cols_before AS
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tickets';

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_role TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_email TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_drafter_id UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_drafter_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_engineer_id UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_engineer_name TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_engineer_email TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS engineer_review_requested_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS engineer_approved_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS engineer_review_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deliverable_rev TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS draft_iteration INT NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS revision_count INT DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS archive_id TEXT;

COMMIT;

-- ── Report (paste back) — expect every row exists_now = true; the rows with
--    existed_before = false are the columns the live DB was missing.
SELECT c.col,
       c.col IN (SELECT column_name FROM _tickets_cols_before) AS existed_before,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tickets'
                  AND column_name = c.col) AS exists_now
FROM unnest(ARRAY[
  'org_id','ticket_id','status','requester_id','requester_role','requester_name',
  'requester_email','assigned_drafter_id','assigned_drafter_name','assigned_engineer_id',
  'assigned_engineer_name','assigned_engineer_email','engineer_review_requested_at',
  'engineer_approved_at','engineer_review_reason','deliverable_rev','draft_iteration',
  'revision_count','closed_at','archived_at','archive_id','created_at'
]) AS c(col)
ORDER BY existed_before, c.col;
