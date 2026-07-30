-- 20260915_knowledge_links.sql
--
-- Library intelligence upgrades:
--
--   1. knowledge_libraries.ai_instructions — standing orders the library
--      owner writes ("these standards cross-reference constantly; chase
--      references; our standards supersede code minimums…") injected into
--      every question asked of that library.
--   2. knowledge_library_links — bridge libraries: asking library X also
--      searches its linked libraries. The asked library is GOVERNING, links
--      are REFERENCE — the precedence doctrine (site standards beat code
--      minimums except where they defer) rides in the prompt.
--   3. knowledge_questions.missing_docs — documents the passages referenced
--      but no linked library contains ("you need ASME B31.3"), stored with
--      the Q&A record.
--
-- Idempotent. Apply after 20260914.

ALTER TABLE knowledge_libraries ADD COLUMN IF NOT EXISTS ai_instructions TEXT;
ALTER TABLE knowledge_questions ADD COLUMN IF NOT EXISTS missing_docs JSONB;

CREATE TABLE IF NOT EXISTS knowledge_library_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  linked_library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_library_links_no_self CHECK (library_id <> linked_library_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_library_links_pair_idx
  ON knowledge_library_links (library_id, linked_library_id);

ALTER TABLE knowledge_library_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_library_links_select ON knowledge_library_links;
CREATE POLICY knowledge_library_links_select ON knowledge_library_links FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_library_links.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS knowledge_library_links_write ON knowledge_library_links;
CREATE POLICY knowledge_library_links_write ON knowledge_library_links FOR ALL USING (
  is_org_controller(org_id)
) WITH CHECK (is_org_controller(org_id));
