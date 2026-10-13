-- ─────────────────────────────────────────────────────────────────────────────
-- 20261194_intel_roundG_mention_run_state.sql
--
-- intelligence Round G (I-23) — the mention index records each build's
-- outcome, so the graph can name a build that failed elsewhere, and a
-- rebuild from the map that stops at its time limit is continued by the
-- next press (IRLS-14, done-when 1's remainder).
--
-- mention_index_runs — ONE ROW PER ORG (org_id is the key; the row goes
-- with its org, ON DELETE CASCADE):
--   * the last build: last_run_id (the build's own id — its end is written
--     only while it is still the last build), last_run_source ('ingest':
--     the pass that follows a document reaching 'ready',
--     lib/knowledgeIngest.ts rebuildDocumentMentions; 'map': a rebuild
--     pressed on the graph, lib/mentionIndexer.ts backfillOrgMentions),
--     last_run_document_id (the knowledge document of an ingest-time build;
--     NULL for a rebuild), last_run_started_at, last_run_finished_at,
--     last_run_outcome ('running' until it reports; 'succeeded', 'failed',
--     'stopped' at its time limit);
--   * the last FAILED build: last_failed_at, last_failed_source,
--     last_failed_document_id, last_failed_error — the error in plain words
--     (lib/mentionRunState.ts plainBuildError; the raw driver text stays in
--     the server log). It stands until the same document's next build
--     succeeds, or a rebuild from the map that began after it reads the
--     whole corpus;
--   * a rebuild's place, written by a rebuild from the map from its start
--     to its end: backfill_state ('running' while a press reads — re-saved
--     every 10 s; 'time_limit' or 'failed' when the press stopped),
--     backfill_cursor (the last knowledge document, by id, it finished),
--     backfill_started_at (when the rebuild began), backfill_documents (how
--     many it has read), backfill_saved_at (when the place was saved) and
--     backfill_dictionary (a fingerprint of the equipment dictionary it reads
--     with). The next press continues after the cursor only when the
--     dictionary is the same and the rebuild began less than 24 h ago;
--     otherwise it starts at the first document and overwrites the place. A
--     rebuild that reads to the end clears it.
-- The document ids are plain uuids, not foreign keys: a run's record
-- outlives the document it names (a failure is still a fact after the
-- document is deleted), and nothing here is ever joined for access.
--
-- WHO READS: an active member of the org reads their own org's row, and no
-- other (policy mention_index_runs_member_read, SELECT only — the map's
-- notice reads it as the member), and only the twelve member columns the
-- column-level GRANT below names (lib/mentionRunState.ts
-- MENTION_RUN_MEMBER_COLUMNS). The knowledge-document ids
-- (last_run_document_id, last_failed_document_id, backfill_cursor), the
-- build's run id and the dictionary's fingerprint are NOT granted: a
-- mirror's id may name a document KACL-7 hides from that member
-- (knowledge_documents_select, 20261120).
-- WHO WRITES: the service role only — both builders run server-side through
-- it. There is no INSERT / UPDATE / DELETE policy, and every write privilege
-- is revoked from anon and authenticated, so RLS is not the only wall; anon
-- holds nothing. No function is created, so there is
-- no SECURITY DEFINER body for DRLS-16's revoke and grant.
--
-- WIDENING? Yes, narrowly: a new table whose one row per org every active
-- member may now read, column by column — when the org's last mention build
-- ran, from where and how it ended; when and where the last failure was and
-- its plain-words error; and a rebuild's state, when it began and was last
-- saved, and how many documents it has read. No document id, name or text,
-- no person. Nothing existing is re-created or altered. The inventory below
-- (aggregate counts only, captured BEFORE the transaction) says whether
-- this paste is a first apply or a re-run and how many members gain the
-- read.
--
-- PASTE AND DEPLOY ORDER. Apply AFTER 20260929_mention_engine.sql (the
-- inventory counts its entity_mentions; the run state describes its builds).
-- Independent of every other pending file. The app may be deployed before
-- or after the paste, and keeps working while it is unpasted: every reader
-- and writer takes the table's absence (PGRST205 / 42P01) or a missing
-- column (42703 / PGRST204) as "no run state" — nothing is recorded, the
-- map says what it said before this file, and every rebuild starts at the
-- first document as before (lib/mentionRunState.ts says so once in the
-- server log). Builds that run before the paste are not recorded
-- retroactively.
--
-- ⚠ APPLIED BY HAND (DEC-30). Single paste: inventory → BEGIN/DDL/COMMIT →
-- ONE SELECT (check text, ok boolean, n text) — the editor shows only the
-- last result set. Probes carry ok with n NULL; inventory rows carry ok NULL
-- with n the count. Never a customer row. Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE any change) ────
DROP TABLE IF EXISTS pg_temp._intel_g94_before;
CREATE TEMP TABLE _intel_g94_before AS
SELECT 'mention_index_runs already existed before this paste (1 = a re-run)' AS what,
       (CASE WHEN to_regclass('public.mention_index_runs') IS NULL THEN 0 ELSE 1 END)::bigint AS n
UNION ALL
SELECT 'workspaces (orgs) — each holds at most one run-state row', COUNT(*) FROM orgs
UNION ALL
SELECT 'active members — each may read their own workspace''s row once this file is applied (the widening)', COUNT(*)
  FROM org_members WHERE status = 'active'
UNION ALL
SELECT 'mention rows in the index (entity_mentions) — the index as built so far; this file changes none', COUNT(*)
  FROM entity_mentions
UNION ALL
SELECT 'ready knowledge documents — what one whole rebuild from the map reads', COUNT(*)
  FROM knowledge_documents WHERE status = 'ready';

BEGIN;

CREATE TABLE IF NOT EXISTS mention_index_runs (
  org_id                  UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  last_run_id             UUID,
  last_run_source         TEXT,
  last_run_document_id    UUID,
  last_run_started_at     TIMESTAMPTZ,
  last_run_finished_at    TIMESTAMPTZ,
  last_run_outcome        TEXT,
  last_failed_at          TIMESTAMPTZ,
  last_failed_source      TEXT,
  last_failed_document_id UUID,
  last_failed_error       TEXT,
  backfill_cursor         UUID,
  backfill_started_at     TIMESTAMPTZ,
  backfill_documents      INTEGER NOT NULL DEFAULT 0,
  backfill_state          TEXT,
  backfill_saved_at       TIMESTAMPTZ,
  backfill_dictionary     TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A re-paste over a table an earlier draft created: every column, idempotently.
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_run_id UUID;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_run_source TEXT;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_run_document_id UUID;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_run_started_at TIMESTAMPTZ;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_run_finished_at TIMESTAMPTZ;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_run_outcome TEXT;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_failed_source TEXT;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_failed_document_id UUID;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS last_failed_error TEXT;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS backfill_cursor UUID;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS backfill_started_at TIMESTAMPTZ;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS backfill_documents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS backfill_state TEXT;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS backfill_saved_at TIMESTAMPTZ;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS backfill_dictionary TEXT;
ALTER TABLE mention_index_runs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The vocabulary the code writes (lib/mentionRunState.ts). A NULL passes.
ALTER TABLE mention_index_runs DROP CONSTRAINT IF EXISTS mention_index_runs_run_source_chk;
ALTER TABLE mention_index_runs ADD CONSTRAINT mention_index_runs_run_source_chk
  CHECK (last_run_source IN ('ingest', 'map'));
ALTER TABLE mention_index_runs DROP CONSTRAINT IF EXISTS mention_index_runs_failed_source_chk;
ALTER TABLE mention_index_runs ADD CONSTRAINT mention_index_runs_failed_source_chk
  CHECK (last_failed_source IN ('ingest', 'map'));
ALTER TABLE mention_index_runs DROP CONSTRAINT IF EXISTS mention_index_runs_outcome_chk;
ALTER TABLE mention_index_runs ADD CONSTRAINT mention_index_runs_outcome_chk
  CHECK (last_run_outcome IN ('running', 'succeeded', 'failed', 'stopped'));
ALTER TABLE mention_index_runs DROP CONSTRAINT IF EXISTS mention_index_runs_backfill_documents_chk;
ALTER TABLE mention_index_runs ADD CONSTRAINT mention_index_runs_backfill_documents_chk
  CHECK (backfill_documents >= 0);
ALTER TABLE mention_index_runs DROP CONSTRAINT IF EXISTS mention_index_runs_error_len_chk;
ALTER TABLE mention_index_runs ADD CONSTRAINT mention_index_runs_error_len_chk
  CHECK (last_failed_error IS NULL OR char_length(last_failed_error) <= 2000);
ALTER TABLE mention_index_runs DROP CONSTRAINT IF EXISTS mention_index_runs_backfill_state_chk;
ALTER TABLE mention_index_runs ADD CONSTRAINT mention_index_runs_backfill_state_chk
  CHECK (backfill_state IN ('running', 'time_limit', 'failed'));
ALTER TABLE mention_index_runs DROP CONSTRAINT IF EXISTS mention_index_runs_backfill_dictionary_chk;
ALTER TABLE mention_index_runs ADD CONSTRAINT mention_index_runs_backfill_dictionary_chk
  CHECK (backfill_dictionary IS NULL OR char_length(backfill_dictionary) <= 128);

ALTER TABLE mention_index_runs ENABLE ROW LEVEL SECURITY;

-- A member reads their own org's row; nobody else's.
DROP POLICY IF EXISTS mention_index_runs_member_read ON mention_index_runs;
CREATE POLICY mention_index_runs_member_read ON mention_index_runs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = mention_index_runs.org_id
                    AND m.uid = auth.uid()
                    AND m.status = 'active'));

-- Writes are the builders' (service role). The default grants Supabase gives
-- a new table are withdrawn, so RLS is not the only wall (a table-level
-- REVOKE also revokes every column privilege, so a re-paste starts clean); a
-- signed-in session gets SELECT on the member columns only, which the policy
-- above narrows to its own org — never a document id, the cursor, the run id
-- or the fingerprint.
REVOKE ALL ON TABLE mention_index_runs FROM anon, authenticated;
GRANT SELECT (org_id, last_run_source, last_run_started_at, last_run_finished_at, last_run_outcome,
              last_failed_at, last_failed_source, last_failed_error,
              backfill_started_at, backfill_documents, backfill_state, backfill_saved_at)
  ON TABLE mention_index_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mention_index_runs TO service_role;

COMMENT ON TABLE mention_index_runs IS
  'IRLS-14 (intelligence Round G I-23): the mention index''s run state, one row per org — the last build (ingest-time pass or a rebuild from the map: started, finished, outcome), the last failed build (where, when, which knowledge document, its error in plain words) and a rebuild''s place (backfill_state running / time_limit / failed; backfill_cursor, the last knowledge document by id it finished; the equipment dictionary''s fingerprint). Written by the service role only (lib/mentionRunState.ts, from lib/knowledgeIngest.ts and lib/mentionIndexer.ts); an active member reads their own org''s row, member columns only (no document id, cursor or fingerprint). Re-derived by the next build; never restored.';

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'mention_index_runs exists with row level security on' AS check,
       EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.mention_index_runs') AND relrowsecurity) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'mention_index_runs carries the 18 columns the code reads and writes, keyed by org_id',
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'mention_index_runs'
           AND column_name IN ('org_id', 'last_run_id', 'last_run_source', 'last_run_document_id', 'last_run_started_at',
                               'last_run_finished_at', 'last_run_outcome', 'last_failed_at', 'last_failed_source',
                               'last_failed_document_id', 'last_failed_error', 'backfill_cursor', 'backfill_started_at',
                               'backfill_documents', 'backfill_state', 'backfill_saved_at', 'backfill_dictionary',
                               'updated_at')) = 18
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = to_regclass('public.mention_index_runs') AND contype = 'p'),
       NULL
UNION ALL
SELECT 'mention_index_runs has exactly one policy: SELECT for authenticated, its own org''s row to an active member',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mention_index_runs') = 1
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'mention_index_runs'
                      AND policyname = 'mention_index_runs_member_read' AND cmd = 'SELECT'
                      AND roles = ARRAY['authenticated']::name[]
                      AND qual LIKE '%org_members%' AND qual LIKE '%auth.uid()%'
                      AND qual LIKE '%mention_index_runs.org_id%' AND qual LIKE '%active%'),
       NULL
UNION ALL
SELECT 'mention_index_runs: anon holds no privilege, and authenticated holds no INSERT / UPDATE / DELETE and no table-wide SELECT',
       NOT has_table_privilege('anon', 'public.mention_index_runs', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_any_column_privilege('anon', 'public.mention_index_runs', 'SELECT, INSERT, UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.mention_index_runs', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_any_column_privilege('authenticated', 'public.mention_index_runs', 'INSERT, UPDATE'),
       NULL
UNION ALL
SELECT 'mention_index_runs: authenticated may SELECT exactly the 12 member columns — no document id, cursor, run id or fingerprint',
       (SELECT COUNT(*) FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = 'mention_index_runs'
           AND has_column_privilege('authenticated', 'public.mention_index_runs', c.column_name, 'SELECT')) = 12
       AND (SELECT bool_and(has_column_privilege('authenticated', 'public.mention_index_runs', x, 'SELECT'))
              FROM unnest(ARRAY['org_id', 'last_run_source', 'last_run_started_at', 'last_run_finished_at', 'last_run_outcome',
                                'last_failed_at', 'last_failed_source', 'last_failed_error', 'backfill_started_at',
                                'backfill_documents', 'backfill_state', 'backfill_saved_at']) AS x),
       NULL
UNION ALL
SELECT 'mention_index_runs: the service role may read and write it (the builders)',
       has_table_privilege('service_role', 'public.mention_index_runs', 'SELECT')
       AND has_table_privilege('service_role', 'public.mention_index_runs', 'INSERT')
       AND has_table_privilege('service_role', 'public.mention_index_runs', 'UPDATE')
       AND has_table_privilege('service_role', 'public.mention_index_runs', 'DELETE'),
       NULL
UNION ALL
SELECT 'mention_index_runs: the seven CHECKs (sources, outcome, documents, error length, place state, fingerprint length) are present',
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conrelid = to_regclass('public.mention_index_runs') AND contype = 'c'
           AND conname IN ('mention_index_runs_run_source_chk', 'mention_index_runs_failed_source_chk',
                           'mention_index_runs_outcome_chk', 'mention_index_runs_backfill_documents_chk',
                           'mention_index_runs_error_len_chk', 'mention_index_runs_backfill_state_chk',
                           'mention_index_runs_backfill_dictionary_chk')) = 7,
       NULL
UNION ALL
SELECT 'mention_index_runs: no trigger on it (nothing runs as anyone else on its writes)',
       NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.mention_index_runs') AND NOT tgisinternal),
       NULL
UNION ALL
SELECT 'after: mention_index_runs rows (0 on a first apply, then one per org that has run a build since)', NULL,
       (SELECT COUNT(*) FROM mention_index_runs)::text
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g94_before;
