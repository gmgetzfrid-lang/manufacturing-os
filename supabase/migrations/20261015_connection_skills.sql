-- Connection Skills: link detection stops being hardcoded industry logic.
--
-- The proposer engine's detectors were built for one industry's paperwork
-- (P&ID off-page connectors). This turns every detector into a ROW the org
-- controls: what to look for (a cross-reference pattern, shared equipment,
-- questions answered from two documents together), whether it runs, and who
-- sees it. The original detectors are seeded per-org as built-in skills so
-- they can be disabled or reasoned about like any other — nothing about the
-- refinery default is special anymore.
--
-- visibility:
--   'org'     — every member sees and benefits from the skill
--   'private' — the author's experiment; it still runs, but its findings
--               NEVER auto-apply and only reach the normal review queue

CREATE TABLE IF NOT EXISTS link_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULL for custom skills. Built-ins carry a stable key so seeding is
  -- idempotent and the engine can find its own defaults.
  builtin_key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('reference','shared_entity','co_citation')),
  -- reference:   { "patterns": ["\\bWO-\\d{5}\\b"] }  — regexes matched
  --              against indexed document text; hits resolve against
  --              document numbers to become links.
  -- co_citation: { "minCoCitations": 2 }
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org','private')),
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS link_rules_builtin_uniq
  ON link_rules (org_id, builtin_key) WHERE builtin_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS link_rules_org_idx ON link_rules (org_id, enabled);

ALTER TABLE link_rules ENABLE ROW LEVEL SECURITY;

-- Members see org skills plus their own private ones.
DROP POLICY IF EXISTS link_rules_select ON link_rules;
CREATE POLICY link_rules_select ON link_rules FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = link_rules.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND (visibility = 'org' OR created_by = auth.uid())
);

-- Any active member may author a skill (it can only ever QUEUE proposals;
-- applying a link still goes through the review roles).
DROP POLICY IF EXISTS link_rules_insert ON link_rules;
CREATE POLICY link_rules_insert ON link_rules FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = link_rules.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND created_by = auth.uid()
);

-- Controllers manage org skills; authors manage their own.
DROP POLICY IF EXISTS link_rules_update ON link_rules;
CREATE POLICY link_rules_update ON link_rules FOR UPDATE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
) WITH CHECK (is_org_controller(org_id) OR created_by = auth.uid());

DROP POLICY IF EXISTS link_rules_delete ON link_rules;
CREATE POLICY link_rules_delete ON link_rules FOR DELETE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
);
