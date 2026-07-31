-- 20260923_output_templates.sql
--
-- OUTPUT TEMPLATES — turn data + a blank template + an example into finished,
-- correctly formatted documents (scopes of work, transmittal letters, job
-- packs) instead of authoring them one by one.
--
-- The design principle that makes this reliable: THE AI NEVER BUILDS THE
-- FILE. A .docx is a zip of XML that carries its own fonts, colours, table
-- styles, headers and logos; we inject text into marked placeholders and
-- hand the SAME file back, so formatting cannot drift. The model only ever
-- writes the words that go in the blanks.
--
--   1. output_templates — one row per reusable template:
--        template_file_key   the blank .docx/.xlsx in R2 (never regenerated)
--        example_files       [{key,name}] finished examples — read as a
--                            STYLE GUIDE (voice, nomenclature, detail level)
--        placeholders        [{tag,label,kind,guidance}] detected/approved
--                            fill points; kind 'ai' is drafted, 'data' is
--                            mapped straight from a column, 'static' is text
--        instructions        standing rules ("written for contractors…")
--        mode                'per_row' | 'summary' | 'both'
--        column_map          remembered column→tag mapping from last use
--   2. output_generations — the production record: which template, which
--      source data, how many documents, by whom. Audit, not a cache.
--
-- Both tables are org-scoped with member-read / controller-write RLS, the
-- same shape as knowledge_libraries.
--
-- Idempotent. Apply after 20260922.

CREATE TABLE IF NOT EXISTS output_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'docx' CHECK (kind IN ('docx', 'xlsx')),
  template_file_key TEXT,
  template_file_name TEXT,
  example_files JSONB NOT NULL DEFAULT '[]',
  example_text TEXT,                        -- distilled style guide (cached)
  placeholders JSONB NOT NULL DEFAULT '[]',
  instructions TEXT,
  mode TEXT NOT NULL DEFAULT 'per_row' CHECK (mode IN ('per_row', 'summary', 'both')),
  column_map JSONB NOT NULL DEFAULT '{}',
  filename_pattern TEXT,                    -- e.g. "SOW-{wo_number}-{unit}"
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS output_templates_org_idx ON output_templates (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS output_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  template_id UUID REFERENCES output_templates(id) ON DELETE SET NULL,
  template_name TEXT,
  source_name TEXT,                         -- the spreadsheet / data source
  document_count INTEGER NOT NULL DEFAULT 0,
  filed_count INTEGER NOT NULL DEFAULT 0,   -- how many landed in doc control
  mode TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS output_generations_org_idx ON output_generations (org_id, created_at DESC);

ALTER TABLE output_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE output_generations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS output_templates_select ON output_templates;
CREATE POLICY output_templates_select ON output_templates FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = output_templates.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS output_templates_write ON output_templates;
CREATE POLICY output_templates_write ON output_templates FOR ALL USING (
  is_org_controller(org_id)
) WITH CHECK (is_org_controller(org_id));

DROP POLICY IF EXISTS output_generations_select ON output_generations;
CREATE POLICY output_generations_select ON output_generations FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = output_generations.org_id
          AND uid = auth.uid() AND status = 'active')
);
-- Generation rows are written server-side (service role) by the generate API.
