-- 20260918_ai_features_column.sql
--
-- Per-library AI feature toggles (additive checkboxes in Library AI setup).
-- JSONB so future features slot in without more migrations. First feature:
--   { "clarifyFacets": true } — when a question's answer spans several
--   distinct aspects (safety vs fabrication vs design…), the AI asks WHICH
--   aspects to answer instead of burying the asker in everything.
--
-- Real platform storage measurement needs no schema: R2 is listed directly
-- from the bucket and DB bytes come from the existing mfg_table_stats
-- function (20260805).
--
-- Idempotent. Apply after 20260917.

ALTER TABLE knowledge_libraries
  ADD COLUMN IF NOT EXISTS ai_features JSONB NOT NULL DEFAULT '{}';
