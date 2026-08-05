-- 20260806_intelligence_layer.sql
--
-- The intelligence layer: what we took from studying Obsidian, HashiCorp
-- Hermes, and Nous Research's Hermes Agent, rebuilt native to this system.
--
--   org_ai_instructions        — Org Playbooks: teachable standing instructions
--                                appended to every governed AI call, scoped per
--                                feature. Teach once, applies everywhere.
--   knowledge_questions (+FTS)  — Ask memory: the existing Q&A record gains
--                                full-text search, so answers are findable
--                                and repeat questions cost nothing.
--   document_related_resources — Curated related links on any document:
--                                internal documents or external URLs, ordered.
--   recently_viewed_docs       — Per-user recents, cross-device.
--   library_numbering          — Optional per-library auto-issued document
--                                numbers (atomic counter, prefix + padding).
--
-- Everything is org data behind RLS. Nothing is hardcoded to one site.

-- ── Org Playbooks ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_ai_instructions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Where this instruction applies: every AI call, or one feature.
  scope TEXT NOT NULL DEFAULT 'global'
    CHECK (scope IN ('global', 'knowledge', 'codebook', 'equipment')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS org_ai_instructions_org_idx
  ON org_ai_instructions(org_id, scope) WHERE enabled;

ALTER TABLE org_ai_instructions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_ai_instructions_read ON org_ai_instructions;
CREATE POLICY org_ai_instructions_read ON org_ai_instructions FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = org_ai_instructions.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS org_ai_instructions_write ON org_ai_instructions;
CREATE POLICY org_ai_instructions_write ON org_ai_instructions FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = org_ai_instructions.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = org_ai_instructions.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl')));

-- ── Ask memory ───────────────────────────────────────────────────────────
-- Q&A already lands in knowledge_questions; make the whole org's history
-- full-text searchable so answers are findable and repeat questions can be
-- answered from memory before spending an AI call.
ALTER TABLE knowledge_questions
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(question, '') || ' ' || coalesce(answer, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS knowledge_questions_tsv_idx
  ON knowledge_questions USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS knowledge_questions_org_recent_idx
  ON knowledge_questions (org_id, created_at DESC);

-- ── Curated related resources ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_related_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'url')),
  target_document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  url TEXT,
  label TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'document' AND target_document_id IS NOT NULL)
      OR (kind = 'url' AND url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS document_related_resources_doc_idx
  ON document_related_resources(document_id, sort_order);

ALTER TABLE document_related_resources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_related_resources_read ON document_related_resources;
CREATE POLICY document_related_resources_read ON document_related_resources FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = document_related_resources.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS document_related_resources_write ON document_related_resources;
CREATE POLICY document_related_resources_write ON document_related_resources FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = document_related_resources.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = document_related_resources.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')));

-- ── Recently viewed ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recently_viewed_docs (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, document_id)
);
CREATE INDEX IF NOT EXISTS recently_viewed_user_idx
  ON recently_viewed_docs(user_id, viewed_at DESC);

ALTER TABLE recently_viewed_docs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recently_viewed_own ON recently_viewed_docs;
CREATE POLICY recently_viewed_own ON recently_viewed_docs FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = recently_viewed_docs.org_id
                AND m.uid = auth.uid() AND m.status = 'active'));

-- ── Auto document numbering ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS library_numbering (
  library_id UUID PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  prefix TEXT NOT NULL DEFAULT '',
  pad INTEGER NOT NULL DEFAULT 4 CHECK (pad BETWEEN 1 AND 8),
  next_number INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE library_numbering ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS library_numbering_read ON library_numbering;
CREATE POLICY library_numbering_read ON library_numbering FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = library_numbering.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS library_numbering_write ON library_numbering;
CREATE POLICY library_numbering_write ON library_numbering FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = library_numbering.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = library_numbering.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl')));

-- Atomically issue the next number (row-locked so two simultaneous uploads
-- can never receive the same one). Members of the org may call it; it only
-- does anything when numbering is enabled for the library.
CREATE OR REPLACE FUNCTION issue_document_number(p_library_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg library_numbering%ROWTYPE;
  n INTEGER;
BEGIN
  SELECT * INTO cfg FROM library_numbering
    WHERE library_id = p_library_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = cfg.org_id
                 AND m.uid = auth.uid() AND m.status = 'active') THEN
    RETURN NULL;
  END IF;
  n := cfg.next_number;
  UPDATE library_numbering
    SET next_number = next_number + 1, updated_at = NOW()
    WHERE library_id = p_library_id;
  RETURN cfg.prefix || lpad(n::text, cfg.pad, '0');
END;
$$;

-- ── Short-link lookup speed ───────────────────────────────────────────────
-- /d/<number> resolves a typed document number with punctuation forgiveness.
CREATE INDEX IF NOT EXISTS documents_number_norm_idx
  ON documents (lower(regexp_replace(coalesce(document_number, ''), '[^a-zA-Z0-9]+', '', 'g')));
