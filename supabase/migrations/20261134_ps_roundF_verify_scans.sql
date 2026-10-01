-- 20261134_ps_roundF_verify_scans.sql
--
-- public-surfaces Round F — PS-VERIFY (VFY-12). The scan record of the four
-- unauthenticated verify endpoints, which is also their per-IP rate window.
--
-- WHAT:
--   1. verify_scans — one row per ANSWERED scan of /api/verify,
--      /api/verify-package, /api/verify-hold or /api/verify-ticket: the
--      endpoint, the target id (the document / package / hold / ticket UUID
--      the QR carried; NULL for a malformed code — the org is derivable from
--      the target, so no org column), the printing the QR names (printed_ref:
--      the ?v= version id of a sheet, the ?print= id of a pack; NULL when the
--      QR names none — so two papers of one document stay distinguishable as
--      evidence), the verdict the scanner was shown, the client IP and user
--      agent, and the time. No person. A scan refused by
--      the rate cap writes no row (lib/verifyRateLimit.ts), so one address
--      adds at most the cap per hour.
--      RLS ON with NO policies, and every table privilege revoked from anon
--      and authenticated: SERVICE ROLE ONLY — the signup_attempts /
--      intake_attempts shape (20261010 / 20261105).
--      Indexed on (ip, created_at) — the window lib/verifyRateLimit.ts
--      counts before every scan — on (target_id, created_at) for the
--      evidence question "was this print scanned, and what did it say?",
--      and on (created_at) for the prune.
--   2. prune_verify_scans() — deletes rows older than 90 days (the
--      user-informed default, 2026-09-17) and returns the count. SECURITY
--      INVOKER: it runs as its caller, the service role, which bypasses RLS
--      — it needs no definer rights (and so carries none of DRLS-16's
--      NULL-uid hazard). search_path pinned; EXECUTE revoked from PUBLIC,
--      anon and authenticated, granted to service_role only. Called by the
--      ONE step in /api/cron/maintenance (no new vercel.json cron — a third
--      entry fails deployment on this plan).
--
-- WIDENING? No. A new table nobody but the service role can read or write,
-- and a function only the service role may execute; nothing existing is
-- re-created or altered (no earlier migration defines verify_scans or
-- prune_verify_scans). The before-apply inventory below says whether this
-- paste is a first apply or a re-run; it is dropped and re-captured on every
-- paste, so a second paste in the same editor session reports the counts
-- from before THAT paste, never the first one's.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. A verify_scans table an earlier draft of this file
-- created without printed_ref gains the column (ADD COLUMN IF NOT EXISTS). The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count).
--
-- Before it is applied the app still answers every scan: the verify routes
-- log "DEPLOY ORDER: verify_scans does not exist" once per runtime, record
-- nothing and rate-limit nothing (the limiter fails open), and the cron step
-- no-ops on the missing function.

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ps_f34_before;
CREATE TEMP TABLE _ps_f34_before AS
SELECT 'inventory: verify_scans already existed before this paste (1 = a re-run)' AS inventory,
       (CASE WHEN to_regclass('public.verify_scans') IS NULL THEN 0 ELSE 1 END)::text AS n
UNION ALL
SELECT 'inventory: verify_scans.printed_ref already existed before this paste',
       COUNT(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'verify_scans' AND column_name = 'printed_ref'
UNION ALL
SELECT 'inventory: prune_verify_scans() already existed before this paste',
       COUNT(*)::text FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.proname = 'prune_verify_scans'
UNION ALL
SELECT 'inventory: policies on verify_scans before this paste (must be 0 — service role only)',
       COUNT(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'verify_scans';

BEGIN;

-- ── 1. the scan record / rate window ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS verify_scans (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint   TEXT NOT NULL CHECK (endpoint IN ('verify', 'verify-package', 'verify-hold', 'verify-ticket')),
  target_id  UUID,                    -- the UUID the QR carried; NULL for a malformed code
  printed_ref UUID,                   -- the printing the QR names (?v= version / ?print= print id); NULL if none
  verdict    TEXT NOT NULL,           -- what the scanner was shown ('current', 'held', 'invalid', …)
  ip         TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A table an earlier draft of this file created before printed_ref existed.
ALTER TABLE verify_scans ADD COLUMN IF NOT EXISTS printed_ref UUID;
CREATE INDEX IF NOT EXISTS verify_scans_ip_time_idx ON verify_scans (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS verify_scans_target_time_idx ON verify_scans (target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS verify_scans_time_idx ON verify_scans (created_at);
ALTER TABLE verify_scans ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only. The default grants Supabase
-- gives new tables are withdrawn too, so RLS is not the only wall.
REVOKE ALL ON TABLE verify_scans FROM anon, authenticated;
COMMENT ON TABLE verify_scans IS
  'VFY-12: one row per answered scan of the public verify endpoints (endpoint, target UUID, the printing the QR names, verdict shown, client IP / user agent) — scan evidence and the per-IP rate window. Service role only; pruned to 90 days by prune_verify_scans() from the maintenance cron.';

-- ── 2. the 90-day prune ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prune_verify_scans() RETURNS integer
LANGUAGE sql SET search_path = public AS $$
  WITH gone AS (DELETE FROM verify_scans WHERE created_at < NOW() - INTERVAL '90 days' RETURNING 1)
  SELECT COUNT(*)::integer FROM gone;
$$;
REVOKE ALL ON FUNCTION prune_verify_scans() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION prune_verify_scans() TO service_role;

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'verify_scans exists with RLS on and NO policies (service role only)' AS check,
       EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.verify_scans') AND relrowsecurity)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'verify_scans') AS ok,
       NULL::text AS n
UNION ALL SELECT 'verify_scans: anon and authenticated hold no SELECT / INSERT / UPDATE / DELETE',
       NOT has_table_privilege('anon', 'public.verify_scans', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_table_privilege('authenticated', 'public.verify_scans', 'SELECT, INSERT, UPDATE, DELETE'), NULL
UNION ALL SELECT 'verify_scans carries id, endpoint, target_id, printed_ref, verdict, ip, user_agent, created_at',
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'verify_scans'
           AND column_name IN ('id', 'endpoint', 'target_id', 'printed_ref', 'verdict', 'ip', 'user_agent', 'created_at')) = 8, NULL
UNION ALL SELECT 'verify_scans indexed on (ip, created_at), (target_id, created_at) and (created_at)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'verify_scans_ip_time_idx')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'verify_scans_target_time_idx')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'verify_scans_time_idx'), NULL
UNION ALL SELECT 'prune_verify_scans keeps 90 days; SECURITY INVOKER; search_path pinned',
       COALESCE((SELECT NOT p.prosecdef
                        AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                        AND p.prosrc LIKE '%INTERVAL ''90 days''%'
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'prune_verify_scans'), false), NULL
UNION ALL SELECT 'prune_verify_scans: service_role may execute; anon and authenticated may not',
       has_function_privilege('service_role', 'public.prune_verify_scans()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.prune_verify_scans()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.prune_verify_scans()', 'EXECUTE'), NULL
UNION ALL SELECT inventory, NULL, n FROM _ps_f34_before;
