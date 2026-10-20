-- ─────────────────────────────────────────────────────────────────────────────
-- 20261233 — intelligence Round G, I-15 GRAPH SERVER ASSEMBLY: an index for
-- the graph's keyset read of pending proposals (GM-7's recorded residual).
--
-- The graph reads pending proposals newest first in keyset windows of 1,000
-- on (created_at DESC, id DESC) (lib/linkProposals.ts
-- readPendingProposalPairs — since I-15 run by GET /api/graph, as the
-- caller). The only index on that path, proposed_links_org_status_idx
-- (20260807), is (org_id, status, created_at DESC): it holds no id. The rows
-- one Find-connections run inserts share one created_at (one upsert,
-- lib/linkProposerServer.ts), so inside that tie the index cannot order by
-- id: every window read — and ran the RESTRICTIVE read policy
-- proposed_links_read_endpoints (20261126) on — every remaining row of the
-- run. Measured on PostgreSQL 16 for one 9,000-row run: 9,000 rows for the
-- first window, 8,000 for the second.
--
-- What this file does:
--   · CREATE INDEX IF NOT EXISTS proposed_links_org_status_keyset_idx
--     ON proposed_links (org_id, status, created_at DESC, id DESC) — the
--     reader's own order under its own filters, so each window is an index
--     scan in that order that stops at its LIMIT, inside a run's tie too —
--     no sort of the tie (measured below).
--   · Nothing else. No row is changed; no policy, function or trigger is
--     re-created; the reader is unchanged (it already orders created_at
--     DESC, id DESC and bounds each later window with created_at <= c).
--     proposed_links_org_status_idx stays: the review queue
--     (/admin/proposed-links, listProposals) and the proposer read by it.
--
-- Not widening (DEC-30): an index lets nobody read or write anything new.
-- The inventory below (aggregate counts only, read BEFORE the change) sizes
-- what the index covers and the largest single tie it now orders.
--
-- PASTE AND DEPLOY ORDER: either order, any time after 20260807 (the
-- table). The app reads the same rows in the same order with or without the
-- index; only the cost of a window inside one run's tie changes. A database
-- without proposed_links stops at the inventory ('relation "proposed_links"
-- does not exist'), before BEGIN, and nothing is changed — and the graph
-- treats a missing table as "nothing pending" (42P01 / PGRST205), as before.
--
-- Plain CREATE INDEX (not CONCURRENTLY: the SQL editor runs a paste inside
-- one transaction, where CONCURRENTLY is refused). It holds a SHARE lock on
-- proposed_links while it builds — proposals cannot be written for that
-- moment (Find-connections waits; reads are not blocked). The table holds
-- one org's proposals in the thousands, so the build takes well under a
-- second at that size.
--
-- ⚠ APPLIED BY HAND (DEC-30). One script; re-running is safe (IF NOT
-- EXISTS; the inventory is re-read; a re-run shows inventory row 4 as 1).
--
-- Exercised on PostgreSQL 16.13 (intelligence Round G, I-15), on a throwaway
-- cluster deleted afterwards: proposed_links, its four indexes and both
-- SELECT policies exactly as 20260807 / 20261126 define them (the
-- RESTRICTIVE proposed_links_read_endpoints included), read as a signed-in
-- member; 9,000 pending rows of ONE run (one created_at) and 9,000 spread
-- rows. The reader's own windows (ORDER BY created_at DESC, id DESC
-- LIMIT 1000; each later window bounded by created_at <= c and the keyset
-- `or`), EXPLAIN ANALYZE, rows the index scan read (returned + removed by
-- the filter):
--   before: windows 1–4 inside the run's tie read 9,001 rows EACH (36,004
--           for the reader's four windows) — an Index Scan on
--           proposed_links_org_status_idx and an Incremental Sort of the tie;
--   after:  1,000 / 2,000 / 3,000 / 4,000 (10,000) — an Index Scan on
--           proposed_links_org_status_keyset_idx with no sort; window k still
--           steps over the k − 1 windows before it, because the keyset `or`
--           is a filter, not an index bound (the reader is unchanged by
--           design: PostgREST cannot send a row comparison).
--   The same 5,000 ids came back in the same order before and after (one
--   digest of the ordered ids). The result set: ok = true × 4, then the
--   counts (18,000; 18,000; 9,000; 0). A re-paste: the same ok rows and
--   inventory row 4 = 1, the index unchanged. A database without
--   proposed_links: the paste stopped at the inventory
--   ('relation "proposed_links" does not exist'), no index created.
--
-- ROLLBACK: DROP INDEX IF EXISTS proposed_links_org_status_keyset_idx;
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; read BEFORE the change) ─────
DROP TABLE IF EXISTS intel_i15_20261233_before;
CREATE TEMP TABLE intel_i15_20261233_before AS
SELECT 1 AS ord, 'BEFORE: proposed_links rows (every status)' AS inventory,
       (SELECT COUNT(*) FROM proposed_links)::text AS n
UNION ALL
SELECT 2, 'BEFORE: pending proposals (the rows the graph''s keyset read pages through)',
       (SELECT COUNT(*) FROM proposed_links WHERE status = 'pending')::text
UNION ALL
SELECT 3, 'BEFORE: the largest group of pending proposals sharing one org and one created_at (one Find-connections run — the tie the old index could not order)',
       (SELECT COALESCE(MAX(c), 0) FROM (SELECT COUNT(*) AS c FROM proposed_links
          WHERE status = 'pending' GROUP BY org_id, created_at) t)::text
UNION ALL
SELECT 4, 'BEFORE: proposed_links_org_status_keyset_idx present (1) or not yet (0)',
       (SELECT COUNT(*) FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'proposed_links'
           AND indexname = 'proposed_links_org_status_keyset_idx')::text;

BEGIN;

-- ── 1. The reader's order, indexed ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS proposed_links_org_status_keyset_idx
  ON proposed_links (org_id, status, created_at DESC, id DESC);

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- Expect: ok = true × 4; then the 4 BEFORE inventory counts (ok NULL).
SELECT 'proposed_links_org_status_keyset_idx exists on proposed_links (org_id, status, created_at DESC, id DESC) — the keyset read''s own order (GM-7)' AS check,
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'proposed_links'
                  AND indexname = 'proposed_links_org_status_keyset_idx'
                  AND indexdef LIKE '%(org_id, status, created_at DESC, id DESC)%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the new index is valid and ready (not left half-built)',
       COALESCE((SELECT i.indisvalid AND i.indisready FROM pg_index i
                  JOIN pg_class c ON c.oid = i.indexrelid
                  JOIN pg_namespace ns ON ns.oid = c.relnamespace
                 WHERE ns.nspname = 'public' AND c.relname = 'proposed_links_org_status_keyset_idx'), false),
       NULL
UNION ALL
SELECT 'proposed_links_org_status_idx (20260807) still stands — the review queue and the proposer read by it',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'proposed_links'
                  AND indexname = 'proposed_links_org_status_idx'),
       NULL
UNION ALL
SELECT 'row level security is still enabled on proposed_links (an index changes no policy)',
       COALESCE((SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                  WHERE ns.nspname = 'public' AND c.relname = 'proposed_links'), false),
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM (SELECT inventory, n FROM intel_i15_20261233_before ORDER BY ord) b;
