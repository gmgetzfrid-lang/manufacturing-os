-- Process flows: the plant's actual topology, as rows.
--
-- Until now the graph knew HIERARCHY (asset belongs to unit) and PAPER
-- (document references asset) but not FLOW — what feeds what. This table
-- holds directional edges between equipment and units: drawn by hand on the
-- graph, or read off a process flow diagram by AI and confirmed by a human.
-- The graph's Process lens renders these as the plant's flow map.
--
-- Endpoints are (kind, ref) pairs rather than hard FKs because the two ends
-- live in different registries: kind='asset' → assets.id (uuid), and
-- kind='unit' → the Site Codebook unit CODE ("20"), which is the identity
-- the org actually navigates by.

CREATE TABLE IF NOT EXISTS process_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('asset','unit')),
  from_ref TEXT NOT NULL,
  to_kind TEXT NOT NULL CHECK (to_kind IN ('asset','unit')),
  to_ref TEXT NOT NULL,
  -- The stream, in the plant's words ("crude feed", "overhead vapor").
  label TEXT,
  -- proposed (AI-read, awaiting a human) / confirmed / dismissed.
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed','confirmed','dismissed')),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','ai')),
  -- Where the AI read it: the knowledge document (a PFD) and page.
  source_document_id UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  source_page INTEGER,
  evidence JSONB,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by UUID,
  decided_by_name TEXT,
  decided_at TIMESTAMPTZ,
  UNIQUE (org_id, from_kind, from_ref, to_kind, to_ref)
);

CREATE INDEX IF NOT EXISTS process_flows_org_idx ON process_flows (org_id, status);

ALTER TABLE process_flows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS process_flows_select ON process_flows;
CREATE POLICY process_flows_select ON process_flows FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = process_flows.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
);

DROP POLICY IF EXISTS process_flows_insert ON process_flows;
CREATE POLICY process_flows_insert ON process_flows FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = process_flows.org_id
          AND m.uid = auth.uid() AND m.status = 'active')
  AND created_by = auth.uid()
);

DROP POLICY IF EXISTS process_flows_update ON process_flows;
CREATE POLICY process_flows_update ON process_flows FOR UPDATE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
) WITH CHECK (is_org_controller(org_id) OR created_by = auth.uid());

DROP POLICY IF EXISTS process_flows_delete ON process_flows;
CREATE POLICY process_flows_delete ON process_flows FOR DELETE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
);
