-- 20260925_entity_kinds.sql
--
-- The original knowledge_page_entities migration (20260921) constrained
-- kind to ('equipment','ref'). The entity layer has since grown two more:
--   'self' — the sheet's own identity read from its title block
--   'opc'  — off-page connector box numbers
-- Every insert batch containing one violated the CHECK and failed WHOLESALE
-- (500 rows at a time), so a rebuild deleted the old entities and wrote
-- nothing — an empty tag index. Drop the constraint: kind is an internal
-- enum owned by the ingest code, and a database allowlist that has to be
-- migrated every time the code learns something new is a footgun, proven.
--
-- Idempotent. Apply after 20260924.

ALTER TABLE knowledge_page_entities
  DROP CONSTRAINT IF EXISTS knowledge_page_entities_kind_check;
