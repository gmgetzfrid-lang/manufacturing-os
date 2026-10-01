-- ─────────────────────────────────────────────────────────────────────────────
-- 20261123_intel_roundG_knowledge_questions_order.sql
--
-- intelligence Round G (I-06) — IRLS-6: migration hygiene for the ask-memory
-- search column.
--
-- 20260806_intelligence_layer.sql ALTERed knowledge_questions (search_tsv +
-- two indexes) 105 days before 20260911_knowledge_ai.sql CREATEs the table.
-- On a fresh database replayed in filename order that raised 42P01 and rolled
-- the whole of 20260806 back (Org Playbooks, related resources, recents,
-- library numbering, issue_document_number()), and 20260807 failed after it.
--
-- 20260806 now runs its ALTER only when the table exists (a to_regclass
-- guard; unchanged behaviour on every live deployment). This file carries the
-- SAME statements, byte for byte, after 20260911 — so a fresh replay ends
-- with the column and both indexes, and a live database (which already has
-- them) sees three no-ops. It re-defines no function, policy or trigger
-- (DB-8, lib/__tests__/migrationSourceOfTruth.test.ts).
--
-- NARROWS nothing and WIDENS nothing. No data is touched, so there is no
-- pre-apply inventory. Single paste: BEGIN/DDL/COMMIT → ONE SELECT
-- (check text, ok boolean, n text). Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE knowledge_questions
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(question, '') || ' ' || coalesce(answer, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS knowledge_questions_tsv_idx
  ON knowledge_questions USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS knowledge_questions_org_recent_idx
  ON knowledge_questions (org_id, created_at DESC);

COMMIT;

-- ── Verification (read-only) — ONE result set ───────────────────────────────
SELECT 'knowledge_questions.search_tsv exists as a STORED generated column' AS check,
       EXISTS (SELECT 1 FROM pg_attribute
                WHERE attrelid = to_regclass('public.knowledge_questions')
                  AND attname = 'search_tsv' AND attgenerated = 's' AND NOT attisdropped) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'search_tsv is generated from question and answer (to_tsvector over both)',
       (SELECT pg_get_expr(d.adbin, d.adrelid) LIKE '%to_tsvector(%'
               AND pg_get_expr(d.adbin, d.adrelid) LIKE '%question%'
               AND pg_get_expr(d.adbin, d.adrelid) LIKE '%answer%'
          FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
         WHERE d.adrelid = to_regclass('public.knowledge_questions') AND a.attname = 'search_tsv'),
       NULL
UNION ALL
SELECT 'index knowledge_questions_tsv_idx (GIN on search_tsv) exists',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'knowledge_questions'
                  AND indexname = 'knowledge_questions_tsv_idx' AND indexdef LIKE '%USING gin (search_tsv)%'),
       NULL
UNION ALL
SELECT 'index knowledge_questions_org_recent_idx (org_id, created_at DESC) exists',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'knowledge_questions'
                  AND indexname = 'knowledge_questions_org_recent_idx'),
       NULL;
