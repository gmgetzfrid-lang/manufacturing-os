-- Reasoning Skills: the second class of skill in the library.
--
-- Connection Skills (link_rules) govern how the engine DISCOVERS links;
-- Reasoning Skills govern how the AI REASONS AND REPORTS when it answers.
-- Each is an instruction pack that rides the answer prompt when enabled.
-- Packs are self-gating (they open by naming when they apply), so enabling
-- several is safe — only the relevant one changes a given answer.
--
-- Same authority model as link_rules: any active member may author;
-- controllers manage org skills, authors manage their own; visibility is
-- org-wide or private. A private reasoning skill rides ONLY its author's
-- questions — it never changes a teammate's answers.

CREATE TABLE IF NOT EXISTS answer_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULL for custom skills; built-ins carry a stable key so seeding is idempotent.
  builtin_key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  -- The instruction pack injected into the answer prompt when enabled.
  instructions TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org','private')),
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS answer_skills_builtin_uniq
  ON answer_skills (org_id, builtin_key) WHERE builtin_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS answer_skills_org_idx ON answer_skills (org_id, enabled);

ALTER TABLE answer_skills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS answer_skills_select ON answer_skills;
CREATE POLICY answer_skills_select ON answer_skills FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = answer_skills.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND (visibility = 'org' OR created_by = auth.uid())
);

DROP POLICY IF EXISTS answer_skills_insert ON answer_skills;
CREATE POLICY answer_skills_insert ON answer_skills FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = answer_skills.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND created_by = auth.uid()
);

DROP POLICY IF EXISTS answer_skills_update ON answer_skills;
CREATE POLICY answer_skills_update ON answer_skills FOR UPDATE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
) WITH CHECK (is_org_controller(org_id) OR created_by = auth.uid());

DROP POLICY IF EXISTS answer_skills_delete ON answer_skills;
CREATE POLICY answer_skills_delete ON answer_skills FOR DELETE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
);
