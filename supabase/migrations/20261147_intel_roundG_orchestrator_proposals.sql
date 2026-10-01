-- 20261147_intel_roundG_orchestrator_proposals.sql
--
-- intelligence Round G, package I-04 — ORCH-4 / PR-1 (criterion 2). The
-- server-side record of what the assistant PROPOSED.
--
-- WHY: /api/orchestrator/execute used to take a tool name and its parameters
-- from the request body, fingerprint them, and approve that fingerprint
-- itself — so any active member could run any write tool with any
-- parameters, a proposal the person declined stayed runnable forever, and
-- one approval ran as many times as it was posted.
--
-- WHAT:
--   orchestrator_proposals — one row per write the assistant proposed that
--   executes server-side (a handoff action with an href is never stored —
--   the real flow does that write): the org, the person it was proposed to,
--   the tool, the exact parameters, the fingerprint the tool computed over
--   them, the card's sentence, when it was proposed, when it expires (the
--   app writes created + 15 minutes), when it was run (executed_at — the
--   one-shot claim) and when it was dismissed (dismissed_at). A row is never
--   both run and dismissed.
--   /api/orchestrator/execute takes only the row's id and runs the STORED
--   tool and parameters, once, for that person, in that org, before
--   expires_at (lib/orchestrator/proposals.ts).
--   RLS ON with NO policies, and every table privilege revoked from anon and
--   authenticated: SERVICE ROLE ONLY (the verify_scans / intake_attempts
--   shape). No function is created. The prune (rows a week past expiry) is a
--   service-role DELETE in lib/orchestrator/proposals.ts, run on every
--   store — no cron entry, no vercel.json change. The permanent record of
--   what ran is audit_logs (AI_ACTION_EXECUTED / AI_ACTION_FAILED).
--   Indexed on (expires_at) for the prune and on (org_id, user_id,
--   created_at) for a person's recent proposals.
--
-- WIDENING? No. A new table nobody but the service role can read or write;
-- nothing existing is re-created or altered (no earlier migration defines
-- orchestrator_proposals). The before-apply inventory says whether this
-- paste is a first apply or a re-run, and counts the AI_ACTION_EXECUTED rows
-- written so far (the writes the old execute path ran); it is dropped and
-- re-captured on every paste.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count).
--
-- Before it is applied the app fails CLOSED: the assistant still answers
-- (reads are unaffected), but a write it proposes cannot be stored, so its
-- card says the migration is needed and cannot be confirmed, and
-- /api/orchestrator/execute answers 409 / 503 to anything it is sent.
-- Nothing a page holds can run a write.

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._intel_g47_before;
CREATE TEMP TABLE _intel_g47_before AS
SELECT 'inventory: orchestrator_proposals already existed before this paste (1 = a re-run)' AS inventory,
       (CASE WHEN to_regclass('public.orchestrator_proposals') IS NULL THEN 0 ELSE 1 END)::text AS n
UNION ALL
SELECT 'inventory: policies on orchestrator_proposals before this paste (must be 0 — service role only)',
       COUNT(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orchestrator_proposals'
UNION ALL
SELECT 'inventory: AI_ACTION_EXECUTED audit rows before this paste (writes the assistant ran so far)',
       COUNT(*)::text FROM audit_logs WHERE action = 'AI_ACTION_EXECUTED';

BEGIN;

-- ── the proposal record ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orchestrator_proposals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  fingerprint  TEXT NOT NULL,
  tool         TEXT NOT NULL,
  parameters   JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  executed_at  TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  CONSTRAINT orchestrator_proposals_run_or_dismissed CHECK (executed_at IS NULL OR dismissed_at IS NULL)
);
CREATE INDEX IF NOT EXISTS orchestrator_proposals_expires_idx ON orchestrator_proposals (expires_at);
CREATE INDEX IF NOT EXISTS orchestrator_proposals_owner_idx ON orchestrator_proposals (org_id, user_id, created_at DESC);
ALTER TABLE orchestrator_proposals ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only. The default grants Supabase
-- gives new tables are withdrawn too, so RLS is not the only wall.
REVOKE ALL ON TABLE orchestrator_proposals FROM anon, authenticated;
COMMENT ON TABLE orchestrator_proposals IS
  'ORCH-4: what the assistant proposed (tool, parameters, fingerprint) for one person in one org, confirmable once within 15 minutes through /api/orchestrator/execute by its id. Service role only; rows a week past expiry are pruned by lib/orchestrator/proposals.ts. The permanent record of what ran is audit_logs (AI_ACTION_EXECUTED).';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'orchestrator_proposals exists with RLS on and NO policies (service role only)' AS check,
       EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.orchestrator_proposals') AND relrowsecurity)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orchestrator_proposals') AS ok,
       NULL::text AS n
UNION ALL SELECT 'orchestrator_proposals: anon and authenticated hold no SELECT / INSERT / UPDATE / DELETE',
       NOT has_table_privilege('anon', 'public.orchestrator_proposals', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_table_privilege('authenticated', 'public.orchestrator_proposals', 'SELECT, INSERT, UPDATE, DELETE'), NULL
UNION ALL SELECT 'orchestrator_proposals: the service role may read and write it',
       has_table_privilege('service_role', 'public.orchestrator_proposals', 'SELECT, INSERT, UPDATE, DELETE'), NULL
UNION ALL SELECT 'orchestrator_proposals carries id, org_id, user_id, fingerprint, tool, parameters, summary, created_at, expires_at, executed_at, dismissed_at',
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'orchestrator_proposals'
           AND column_name IN ('id', 'org_id', 'user_id', 'fingerprint', 'tool', 'parameters', 'summary',
                               'created_at', 'expires_at', 'executed_at', 'dismissed_at')) = 11, NULL
UNION ALL SELECT 'orchestrator_proposals: a row is never both run and dismissed (CHECK present)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = to_regclass('public.orchestrator_proposals')
                  AND conname = 'orchestrator_proposals_run_or_dismissed' AND contype = 'c'), NULL
UNION ALL SELECT 'orchestrator_proposals indexed on (expires_at) and (org_id, user_id, created_at)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'orchestrator_proposals_expires_idx')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'orchestrator_proposals_owner_idx'), NULL
UNION ALL SELECT 'after: orchestrator_proposals rows (0 on a first apply)', NULL,
       (SELECT COUNT(*) FROM orchestrator_proposals)::text
UNION ALL SELECT inventory, NULL, n FROM _intel_g47_before;
