-- 20260825_team_targeting.sql
--
-- Department (team) targeting — Phase 2 of teams-as-departments. Read-&-
-- understood and pre-publish review policies can now name a whole department;
-- the app expands it to concrete members at issue time and records each roster
-- row with source='team' so the audit trail shows WHY someone was assigned.
--
-- The policies live in JSONB (no schema change needed); this migration only
-- widens the roster tables' `source` CHECK constraints to allow the new value.
--
-- Idempotent (drop-if-exists + re-add as a pair). Dated after 20260824.

ALTER TABLE document_acknowledgments DROP CONSTRAINT IF EXISTS document_acknowledgments_source_check;
ALTER TABLE document_acknowledgments ADD CONSTRAINT document_acknowledgments_source_check
  CHECK (source IN ('person', 'role', 'team'));

ALTER TABLE document_review_signoffs DROP CONSTRAINT IF EXISTS document_review_signoffs_source_check;
ALTER TABLE document_review_signoffs ADD CONSTRAINT document_review_signoffs_source_check
  CHECK (source IN ('person', 'role', 'team'));
