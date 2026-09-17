-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — WF-17 / DEC-14: the two dead entry statuses
-- (NEW, PENDING_ENG_INITIAL) leave the drafting workflow.
--
-- Every request is born in PENDING_ASSIGNMENT: getInitialStatus() says so,
-- every creator sets it explicitly, and ticket_insert_integrity (20261038)
-- forces it for client inserts. NEW and PENDING_ENG_INITIAL were therefore
-- unreachable, yet the state machine, the routing policy and the attention
-- feed all still carried branches for them. Round E removes the branches from
-- the code (types/schema.ts no longer knows the two values) — so any row that
-- somehow still carries one would be STRANDED: no action offered, no colour,
-- no route. This script:
--
--   1. inventories such rows into a TEMP TABLE before the transaction
--      (aggregate counts per retired status — the paste-back record);
--   2. moves them to PENDING_ASSIGNMENT with an appended history line, so
--      the drafting record says why the status changed (the update guard
--      passes: the SQL editor runs as the service role);
--   3. changes the column DEFAULT from 'NEW' (schema.sql's original) to
--      PENDING_ASSIGNMENT, so a service-role insert that omits `status`
--      lands in the live queue.
--
-- Not a widening: nobody gains authority. No CHECK constraint exists on
-- tickets.status and none is added: the column is guarded by
-- ticket_update_guard for client writers and by the workflow route for
-- service writes, and the restore path re-inserts historical rows verbatim
-- (a CHECK would refuse a backup that predates this script).
--
-- CANCELED needs nothing here: it is produced by the workflow route (service
-- role) and was already a known terminal status (20260811 closed_at).
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS rp_roundE_dead_status_inventory;
CREATE TEMP TABLE rp_roundE_dead_status_inventory AS
SELECT status, COUNT(*)::bigint AS n
FROM tickets
WHERE status IN ('NEW', 'PENDING_ENG_INITIAL')
GROUP BY status;

BEGIN;

UPDATE tickets
SET status = 'PENDING_ASSIGNMENT',
    history = COALESCE(history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'action', 'Moved to the assignment queue',
      'user', 'system',
      'role', 'System',
      'date', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'details', 'Status ' || status || ' was retired (DEC-14); the request continues from PENDING_ASSIGNMENT.'
    ))
WHERE status IN ('NEW', 'PENDING_ENG_INITIAL');

ALTER TABLE tickets ALTER COLUMN status SET DEFAULT 'PENDING_ASSIGNMENT';

COMMIT;

-- ── Verification + inventory (one result set) — expect true × 4, then counts
SELECT 'no ticket remains in a retired status' AS check,
       (SELECT COUNT(*) = 0 FROM tickets WHERE status IN ('NEW', 'PENDING_ENG_INITIAL'))::text AS ok
UNION ALL
SELECT 'tickets.status now defaults to PENDING_ASSIGNMENT',
       (SELECT column_default LIKE '%PENDING_ASSIGNMENT%'
          FROM information_schema.columns
         WHERE table_name = 'tickets' AND column_name = 'status')::text
UNION ALL
SELECT 'the insert trigger still forces the queue entry (20261038 intact)',
       (SELECT prosrc LIKE '%NEW.status := ''PENDING_ASSIGNMENT'';%'
          FROM pg_proc WHERE proname = 'ticket_insert_integrity')::text
UNION ALL
SELECT 'every live ticket is in a status the state machine knows',
       (SELECT COUNT(*) = 0 FROM tickets
         WHERE status NOT IN ('PENDING_ENG_TEAM', 'PENDING_ASSIGNMENT', 'DRAFTING', 'REVISION_REQ',
                              'PENDING_REVIEW', 'PENDING_IFC', 'FINAL_DRAFT', 'PENDING_FINAL_APPROVAL',
                              'CLOSED', 'CANCELED'))::text
UNION ALL
SELECT 'inventory: tickets migrated from NEW',
       COALESCE((SELECT n FROM rp_roundE_dead_status_inventory WHERE status = 'NEW'), 0)::text
UNION ALL
SELECT 'inventory: tickets migrated from PENDING_ENG_INITIAL',
       COALESCE((SELECT n FROM rp_roundE_dead_status_inventory WHERE status = 'PENDING_ENG_INITIAL'), 0)::text
UNION ALL
SELECT 'inventory: tickets now in PENDING_ASSIGNMENT (after)',
       (SELECT COUNT(*) FROM tickets WHERE status = 'PENDING_ASSIGNMENT')::text;
