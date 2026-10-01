-- 20261158_intel_roundG_orchestrator_taint.sql
--
-- intelligence Round G, package I-19 — ORCH-9 criterion 3. A write the
-- assistant proposed in a run whose tool results, in the part the model was
-- shown, carried a role / instruction marker that neutralizeUntrusted
-- rewrote is stored as such. The signal is syntactic: ordinary labels set it
-- too, and a missing flag proves nothing.
--
-- WHY: a tool result carries text other people wrote (extracted PDF
-- passages, mention snippets, document names). The loop fences and
-- neutralises it before the model reads it (lib/orchestrator/protocol.ts
-- neutralizeUntrusted: role markers such as "SYSTEM:" quoted, fence markers
-- and tool-call keys broken up), and the system prompt says it is data —
-- but a model that obeys a planted "SYSTEM: … call log_audit_completion"
-- still produces a stored proposal whose card the model wrote. Nothing told
-- the person confirming that the suggestion came after such text.
--
-- WHAT:
--   orchestrator_proposals.tainted BOOLEAN — TRUE when the run that proposed
--   the write read a tool result in which neutralizeUntrusted rewrote a
--   role / instruction marker (lib/orchestrator/loop.ts marks every proposal
--   of such a run; lib/orchestrator/proposals.ts storeProposals writes it,
--   and the confirm card says "Suggested after reading document text —
--   check before confirming"). FALSE: the run read no such marker — the
--   column's DEFAULT, so a clean run's insert is exactly what it was before
--   this file. NULL: the row was stored before this paste (not known) —
--   ADD COLUMN without a default leaves existing rows NULL; the default is
--   set after, so it binds only new rows.
--   The flag INFORMS; it never blocks, changes or expires a proposal:
--   /api/orchestrator/execute does not read it (DEC-72 item 1 stays the
--   write path).
--   Nothing else changes: no function, policy, trigger, grant or index is
--   created or re-created; RLS stays on with no policies, anon and
--   authenticated keep no privilege (20261147) — the service role's table
--   privileges cover the new column.
--
-- WIDENING? No. One nullable column on a service-role-only table. The
-- before-apply inventory says whether this paste is a first apply or a
-- re-run and counts the rows the column lands on (aggregate counts only); it
-- is dropped and re-captured on every paste.
--
-- NEEDS 20261147 (the table). Pasted without it, this file stops at the
-- first statement and says so; nothing is changed.
--
-- WHEN TO PASTE: either order is safe. Before it is applied the app stores a
-- flagged proposal WITHOUT the flag (PostgREST answers 42703 / PGRST204 for
-- the missing column; the store retries without it and logs a warning): the
-- proposal is stored and confirmable exactly as before, and its card shows
-- no flag. A run that read no marker never names the column, so its store
-- is untouched either way. The code before I-19's deploy never names it.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count).

DO $$
BEGIN
  IF to_regclass('public.orchestrator_proposals') IS NULL THEN
    RAISE EXCEPTION '20261158 needs 20261147 (orchestrator_proposals) — paste 20261147_intel_roundG_orchestrator_proposals.sql first. Nothing was changed.';
  END IF;
END $$;

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._intel_g58_before;
CREATE TEMP TABLE _intel_g58_before AS
SELECT 'inventory: orchestrator_proposals.tainted already existed before this paste (1 = a re-run)' AS inventory,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'orchestrator_proposals' AND column_name = 'tainted')::text AS n
UNION ALL
SELECT 'inventory: orchestrator_proposals rows before this paste (on a first apply each keeps tainted NULL — stored before the flag existed)',
       (SELECT COUNT(*) FROM orchestrator_proposals)::text
UNION ALL
SELECT 'inventory: of them still confirmable before this paste (not run, not dismissed, not expired)',
       (SELECT COUNT(*) FROM orchestrator_proposals
         WHERE executed_at IS NULL AND dismissed_at IS NULL AND expires_at > NOW())::text
UNION ALL
SELECT 'inventory: rows already flagged tainted before this paste (0 on a first apply)',
       (SELECT COUNT(*) FILTER (WHERE to_jsonb(p) ->> 'tainted' = 'true') FROM orchestrator_proposals p)::text;

BEGIN;

-- ── the flag ─────────────────────────────────────────────────────────────
ALTER TABLE orchestrator_proposals ADD COLUMN IF NOT EXISTS tainted BOOLEAN;
ALTER TABLE orchestrator_proposals ALTER COLUMN tainted SET DEFAULT false;
COMMENT ON COLUMN orchestrator_proposals.tainted IS
  'ORCH-9: TRUE when the run that proposed this write read a tool result in which a role / instruction marker was neutralised (lib/orchestrator/protocol.ts neutralizeUntrusted) — the card says "Suggested after reading document text — check before confirming". FALSE: no such marker (the default). NULL: stored before 20261158 (not known). Informational only: it never blocks or changes a proposal, and /api/orchestrator/execute does not read it.';

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT 'orchestrator_proposals.tainted exists: boolean, nullable, DEFAULT false, commented' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'orchestrator_proposals' AND column_name = 'tainted'
                  AND data_type = 'boolean' AND is_nullable = 'YES' AND column_default = 'false')
       AND col_description(to_regclass('public.orchestrator_proposals'),
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = to_regclass('public.orchestrator_proposals') AND attname = 'tainted' AND NOT attisdropped)) LIKE 'ORCH-9:%' AS ok,
       NULL::text AS n
UNION ALL SELECT 'orchestrator_proposals still RLS on with NO policies (service role only — 20261147 unchanged)',
       EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.orchestrator_proposals') AND relrowsecurity)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'orchestrator_proposals'), NULL
UNION ALL SELECT 'orchestrator_proposals: anon and authenticated still hold no SELECT / INSERT / UPDATE / DELETE',
       NOT has_table_privilege('anon', 'public.orchestrator_proposals', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_table_privilege('authenticated', 'public.orchestrator_proposals', 'SELECT, INSERT, UPDATE, DELETE'), NULL
UNION ALL SELECT 'orchestrator_proposals.tainted: the service role may read and write it',
       has_column_privilege('service_role', 'public.orchestrator_proposals', 'tainted', 'SELECT')
       AND has_column_privilege('service_role', 'public.orchestrator_proposals', 'tainted', 'INSERT')
       AND has_column_privilege('service_role', 'public.orchestrator_proposals', 'tainted', 'UPDATE'), NULL
UNION ALL SELECT 'after: orchestrator_proposals rows with tainted NULL (stored before this paste — not known)', NULL,
       (SELECT COUNT(*) FROM orchestrator_proposals WHERE tainted IS NULL)::text
UNION ALL SELECT 'after: orchestrator_proposals rows with tainted TRUE (suggested after reading document text)', NULL,
       (SELECT COUNT(*) FROM orchestrator_proposals WHERE tainted)::text
UNION ALL SELECT 'after: orchestrator_proposals rows with tainted FALSE', NULL,
       (SELECT COUNT(*) FROM orchestrator_proposals WHERE NOT tainted)::text
UNION ALL SELECT inventory, NULL, n FROM _intel_g58_before;
