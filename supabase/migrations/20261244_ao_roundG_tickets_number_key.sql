-- 20261244_ao_roundG_tickets_number_key.sql
--
-- admin-and-org Round G, package P16 RESTORE TICKET NUMBER KEY — drafting-flow
-- EDGE-5 (done-when 1's remainder, assigned at the DF-P11 merge, DEC-31).
-- One request number per request in a workspace, held by the database.
--
-- WHERE THE KEY COMES FROM TODAY: only supabase/schema.sql:482 declares
-- UNIQUE (org_id, ticket_id), inline in `CREATE TABLE IF NOT EXISTS tickets`.
-- No numbered migration creates or drops it (every file in
-- supabase/migrations was searched). CREATE TABLE IF NOT EXISTS adds nothing
-- to a table that already exists, so a database whose tickets table predates
-- that line of schema.sql has no such key. admin-and-org BKP-5 fix pass 5
-- item 3 (audit-reports/admin-and-org/02-backup-restore.md:375) ASSUMED the
-- number is not unique ("tickets.ticket_id is not unique", reasoned against
-- the in-memory restore engine); no record observes a live database either
-- way. Which world a database is in cannot be seen from the repository
-- (DEC-30) — only this paste's probe 2 / inventory row 5 show it — so this
-- file serves both:
--   * the key is there (any plain unique index on exactly org_id, ticket_id —
--     schema.sql's tickets_org_id_ticket_id_key, or another name — that is
--     VALID, READY and IMMEDIATE, i.e. enforced at every statement): NOTHING
--     is changed;
--   * the key is absent and no workspace holds a number twice: the key is
--     added as the constraint tickets_org_id_ticket_id_key (schema.sql's own
--     name), under a table lock taken for the check and the build together,
--     so no duplicate can slip in between them;
--   * the key is absent and some workspace holds a number on more than one
--     request: the file REFUSES — it changes nothing, and the result names how
--     many numbers are held twice and on how many requests (inventory rows 2
--     and 3). The operator decides which request keeps each number (counts
--     only here — never a row; find them with
--       SELECT org_id, ticket_id, COUNT(*) FROM tickets
--        GROUP BY org_id, ticket_id HAVING COUNT(*) > 1;
--     in the SQL editor), then re-pastes this file.
-- No row is ever changed, renumbered or deleted by this file.
--
-- AN INVALID INDEX IS NOT THE KEY (P16 fix pass 2): a unique index left by a
-- failed CREATE UNIQUE INDEX CONCURRENTLY (indisvalid / indisready false)
-- enforces nothing, and a DEFERRABLE key (indimmediate false) is not checked
-- at each statement — neither counts as present, in the check, the inventory
-- (row 5) or the probes. Such an index under another name is left as it is
-- (the key is added beside it when nothing blocks it); it is the operator's to
-- drop (DROP INDEX CONCURRENTLY <name>;). One that squats the name
-- tickets_org_id_ticket_id_key makes the paste raise, changing nothing.
--
-- NOT A WIDENING: it lets nobody do anything new. It is a narrowing of what
-- the table accepts (a second request under one number in one workspace is
-- refused 23505), so the inventory (aggregate counts only) is captured BEFORE
-- the transaction (DEC-30). No function, policy, trigger or grant is created
-- or changed; row-level security is untouched.
--
-- THE APP WORKS BEFORE AND AFTER THE PASTE, IN EITHER ORDER WITH THE P16
-- DEPLOY. The one request filer, /api/tickets/create, numbers through the
-- atomic counter (next_ticket_number, 20260724) and already files a request
-- refused 23505 once under a fresh number (DEC-90; drafting-flow EDGE-13) —
-- so after the paste a clash it could not have seen before is handled by the
-- path it already has. No other app path inserts a ticket or writes
-- tickets.ticket_id (the ticket-shed restore re-fills a stub's content; it
-- does not insert). The restore (lib/dataRestore.ts applyRestoreChunk, P16)
-- restores a backup request whose number a live request of the workspace
-- holds, or ANOTHER REQUEST OF THE SAME BACKUP carries, under a fresh number
-- from ticket_number_counters, the number it was issued recorded on the
-- request and in the chunk's audit row (TICKET_RENUMBERED, P16 fix passes 2
-- and 3; the holder is kept as it is) — so it never sends two requests under
-- one number; before this paste that check is the only guard; after it, the
-- database holds the same rule for every writer. No app code reads the key's
-- name.
--
-- PASTE ORDER: independent of every other file — it needs only tickets
-- (supabase/schema.sql); the prerequisite block refuses without it, changing
-- nothing. Deploy the P16 app first (recommended, not required): until it is
-- deployed, a restore into a workspace that uses a backup request's number is
-- refused 23505 per row by this key (reported, the rest of the table lands —
-- BKP-12), and after it, the same row is restored under a fresh number, the
-- number it was issued recorded (TICKET_RENUMBERED).
--
-- LOCKING: the check and the build run under ACCESS EXCLUSIVE on tickets,
-- only in the world where the key is absent (the index build over the table
-- takes as long as the table is large — seconds for tens of thousands of
-- requests). lock_timeout is 10 s: a paste that cannot take the lock stops
-- with "canceling statement due to lock timeout", changes nothing, and can
-- simply be pasted again.
--
-- ROLLBACK (only if THIS file added the key — the final SELECT's world row
-- says so; never drop schema.sql's own key):
--   ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_org_id_ticket_id_key;
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count), in the order written.
--
-- EXPECTED RESULT: probes 2, 4 and 5 are true on a correct paste in every
-- world (probe 2 is the world check). Probes 1 and 3 are true, except in the
-- REFUSED world — a workspace holds a number twice — where BOTH are false
-- (probe 1: no key; probe 3: the duplicates are still there), and inventory
-- rows 2–4 carry the counts.

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.tickets') IS NULL THEN
    RAISE EXCEPTION '20261244 needs the tickets table (supabase/schema.sql). Nothing was changed.';
  END IF;
END $$;

-- ── Before-apply inventory (aggregate counts only; captured BEFORE the DDL) ─
DROP TABLE IF EXISTS pg_temp._ao_g244_before;
CREATE TEMP TABLE _ao_g244_before AS
WITH dup AS (
  SELECT org_id, ticket_id, COUNT(*) AS n FROM tickets
   WHERE ticket_id IS NOT NULL
   GROUP BY org_id, ticket_id HAVING COUNT(*) > 1
)
SELECT 1 AS ord, 'inventory (before apply): EDGE-5 — tickets rows (all workspaces)' AS inventory,
       (SELECT COUNT(*) FROM tickets)::text AS n
UNION ALL
SELECT 2, 'inventory (before apply): EDGE-5 — request numbers held by more than one request in one workspace (each blocks the key; 0 = none)',
       (SELECT COUNT(*) FROM dup)::text
UNION ALL
SELECT 3, 'inventory (before apply): EDGE-5 — requests carrying one of those numbers',
       (SELECT COALESCE(SUM(n), 0) FROM dup)::text
UNION ALL
SELECT 4, 'inventory (before apply): EDGE-5 — workspaces holding at least one number twice',
       (SELECT COUNT(DISTINCT org_id) FROM dup)::text
UNION ALL
SELECT 5, 'inventory (before apply): EDGE-5 — plain unique keys on exactly tickets (org_id, ticket_id), valid, ready and immediate, before this paste (1 = schema.sql''s key was live; 0 = absent)',
       (SELECT COUNT(*) FROM pg_index i
         WHERE i.indrelid = 'public.tickets'::regclass AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
           AND i.indnkeyatts = 2 AND i.indisvalid AND i.indisready AND i.indimmediate
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                 WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)) = ARRAY['org_id', 'ticket_id'])::text;

BEGIN;

SET LOCAL lock_timeout = '10s';

-- EDGE-5: the key, only where it is absent and nothing blocks it.
DO $$
DECLARE
  v_dups bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i
              WHERE i.indrelid = 'public.tickets'::regclass AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
                AND i.indnkeyatts = 2 AND i.indisvalid AND i.indisready AND i.indimmediate
                AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                      WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)) = ARRAY['org_id', 'ticket_id']) THEN
    RAISE NOTICE '20261244: tickets already carries a unique key on (org_id, ticket_id) — nothing was changed.';
    RETURN;
  END IF;
  -- The check and the build under one lock: no request can be filed between them.
  LOCK TABLE tickets IN ACCESS EXCLUSIVE MODE;
  SELECT COUNT(*) INTO v_dups FROM (
    SELECT 1 FROM tickets WHERE ticket_id IS NOT NULL GROUP BY org_id, ticket_id HAVING COUNT(*) > 1
  ) d;
  IF v_dups > 0 THEN
    RAISE NOTICE '20261244 REFUSED: % request number(s) are held by more than one request in one workspace — nothing was changed. Decide which request keeps each number, then paste this file again.', v_dups;
    RETURN;
  END IF;
  IF to_regclass('public.tickets_org_id_ticket_id_key') IS NOT NULL THEN
    RAISE EXCEPTION '20261244: a relation named tickets_org_id_ticket_id_key exists but is not a unique key on tickets (org_id, ticket_id) — nothing was changed; inspect it before pasting again.';
  END IF;
  ALTER TABLE tickets ADD CONSTRAINT tickets_org_id_ticket_id_key UNIQUE (org_id, ticket_id);
END $$;

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- Probes 1 and 3 are false in exactly one world, and together: this file
-- refused because numbers are held twice (inventory rows 2–4 say how many).
-- Probe 2 says which world the paste is in and is true on a correct paste in
-- every world; probes 4 and 5 are true in every world.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord,
       'EDGE-5: tickets carries a unique key on exactly (org_id, ticket_id) — one request per number in a workspace (false only when this paste REFUSED: see probe 2 and inventory rows 2–4)' AS check,
       EXISTS (SELECT 1 FROM pg_index i
                WHERE i.indrelid = 'public.tickets'::regclass AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
                  AND i.indnkeyatts = 2 AND i.indisvalid AND i.indisready AND i.indimmediate
                  AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                        WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)) = ARRAY['org_id', 'ticket_id']) AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2,
       CASE
         WHEN (SELECT n FROM _ao_g244_before WHERE ord = 5) <> '0'
           THEN 'EDGE-5 world: the key was already live (schema.sql''s key, an earlier paste of this file, or another plain unique index on the two columns) — nothing was changed'
         WHEN EXISTS (SELECT 1 FROM pg_constraint
                       WHERE conrelid = 'public.tickets'::regclass AND conname = 'tickets_org_id_ticket_id_key' AND contype = 'u')
           THEN 'EDGE-5 world: the key was absent and no number was held twice — this paste ADDED tickets_org_id_ticket_id_key'
         ELSE 'EDGE-5 world: REFUSED — the key is absent and ' || (SELECT n FROM _ao_g244_before WHERE ord = 2)
              || ' request number(s) are held by more than one request in one workspace; nothing was changed — decide which request keeps each number, then paste again'
       END,
       -- consistent: the key is live exactly when nothing blocked it
       EXISTS (SELECT 1 FROM pg_index i
                WHERE i.indrelid = 'public.tickets'::regclass AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
                  AND i.indnkeyatts = 2 AND i.indisvalid AND i.indisready AND i.indimmediate
                  AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                        WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)) = ARRAY['org_id', 'ticket_id'])
         = ((SELECT n FROM _ao_g244_before WHERE ord = 5) <> '0' OR (SELECT n FROM _ao_g244_before WHERE ord = 2) = '0'),
       NULL
UNION ALL
SELECT 1, 3, 'EDGE-5: no request number is held by more than one request in one workspace now (false only when this paste REFUSED, with probe 1: see probe 2 and inventory rows 2–4)',
       NOT EXISTS (SELECT 1 FROM tickets WHERE ticket_id IS NOT NULL GROUP BY org_id, ticket_id HAVING COUNT(*) > 1),
       NULL
UNION ALL
SELECT 1, 4, 'EDGE-5: no request was removed by this paste (the count now is at least inventory row 1; a request filed meanwhile may add one)',
       (SELECT COUNT(*) FROM tickets) >= (SELECT n FROM _ao_g244_before WHERE ord = 1)::bigint,
       NULL
UNION ALL
SELECT 1, 5, 'EDGE-5: row-level security is still enabled on tickets (untouched)',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tickets'::regclass),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM _ao_g244_before
) AS final_rows
ORDER BY sec, ord;
