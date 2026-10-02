-- ─────────────────────────────────────────────────────────────────────────────
-- 20261153_intel_roundG_ask_answer_context.sql
--
-- intelligence Round G (I-03) — what an answer was built from, recorded on
-- its row (ASK-1 / KACL-1 / IEDGE-5; with ASK-3, ASK-5, PR-9 and IRLS-13).
--
-- knowledge_questions.context (JSONB, nullable) — written by
-- /api/knowledge/ask on every library answer:
--   documents  every knowledge document whose passages, legend text, page
--              images or drawing facts reached the model (not only the ones
--              the answer cites);
--   complete   false when there were more than the route records
--              (ANSWER_CONTEXT_DOC_CAP) — such a row is its asker's alone;
--   history    where the conversation context came from: "thread" (the
--              asker's own stored turns), "client" (unverified client input —
--              the row is its asker's alone), or "none";
--   partial    the answer stopped at the model's length limit (ASK-3);
--   arithmetic "unverified" — the answer carries model arithmetic (PR-9);
--   skills     the Reasoning Skills that rode the prompt (IRLS-13).
-- /api/knowledge/history (lib/knowledgeHistory planVisibleHistory) shows a
-- teammate a row only when every document it cites AND every document in
-- context.documents is readable to them; the ask route's proven-ground pass
-- never seats the pages of a partial or unverified-arithmetic answer.
--
-- Rows written before this file carry NULL and are judged by what they cite,
-- exactly as before (nothing is backfilled: what reached the model was never
-- recorded and cannot be recovered). Until this is pasted the route saves
-- every answer without the column (one retry) and nothing else changes.
--
-- NARROWS what a teammate may read from the team's record (through the app);
-- WIDENS nothing — no policy, grant or function is touched; RLS on
-- knowledge_questions (20261120: the asker and controllers) is unchanged, so
-- the asker reads their own row's context, and controllers every row's. No
-- data is changed, so the inventory below is informational (aggregate counts
-- only, captured before the transaction). Single paste: inventory →
-- BEGIN/DDL/COMMIT → ONE SELECT (check text, ok boolean, n text) — the editor
-- shows only the last result. Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE any change) ────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g53_before AS
SELECT 'stored answers (rows written before this file are judged by their citations alone)' AS what,
       COUNT(*) AS n
  FROM knowledge_questions
UNION ALL
SELECT 'stored library answers rated thumbs-up (proven ground)', COUNT(*)
  FROM knowledge_questions WHERE rating = 1;

BEGIN;

ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS context JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'knowledge_questions_context_object'
                    AND conrelid = 'public.knowledge_questions'::regclass) THEN
    -- Every row is NULL when the column is first added, so validating is free.
    ALTER TABLE knowledge_questions ADD CONSTRAINT knowledge_questions_context_object
      CHECK (context IS NULL OR jsonb_typeof(context) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN knowledge_questions.context IS
  'What reached the model for this answer (intelligence Round G I-03): documents, complete, history, partial, arithmetic, skills. NULL before 20261153 — judged by citations alone.';

COMMIT;

-- ── Verification (read-only) — ONE result set ───────────────────────────────
SELECT 'knowledge_questions.context exists as JSONB' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'knowledge_questions'
                  AND column_name = 'context' AND data_type = 'jsonb') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'knowledge_questions.context is NULL or a JSON object (validated CHECK)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'knowledge_questions_context_object' AND convalidated
                  AND conrelid = 'public.knowledge_questions'::regclass
                  AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(context)%'),
       NULL
UNION ALL
SELECT 'knowledge_questions_select is unchanged (still the asker and controllers, 20261120)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'knowledge_questions'
                  AND policyname = 'knowledge_questions_select'
                  AND qual LIKE '%auth.uid()%' AND qual LIKE '%is_org_controller%'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g53_before;
