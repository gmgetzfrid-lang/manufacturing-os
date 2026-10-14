-- 20261020_one_estate.sql
--
-- ONE ESTATE — the facility as a single linked environment (docs/PRD_ONE_ESTATE.md).
--
--   knowledge_documents.file_hash — facts attach to BYTES. A copy of an
--                      indexed drawing anywhere inherits its OCR, tags and
--                      mentions; no page is ever read twice.
--   estate_edges     — the one place derived and declared relationships
--                      live, each with who/what asserted it, the evidence,
--                      and a confidence tier. Folder → unit, project → unit,
--                      document "also filed under", folder "about" an asset.
--                      Existing join tables (document_assets, project_documents,
--                      entity_mentions, supersessions) stay; the graph reads
--                      all of them as one.
--
-- Node ids are stable strings shared by every lens:
--   plant:<id>  unit:<id>  cbunit:<code>  system:<id>  asset:<id>
--   doc:<id>    folder:<id>  lib:<id>  proj:<id>  drive:<id>
--
-- Idempotent. Apply after 20261019.

ALTER TABLE knowledge_documents ADD COLUMN IF NOT EXISTS file_hash TEXT;
CREATE INDEX IF NOT EXISTS knowledge_documents_hash_idx ON knowledge_documents (org_id, file_hash);
-- Backfill from the version each mirror was read from.
UPDATE knowledge_documents kd
   SET file_hash = dv.file_hash
  FROM document_versions dv
 WHERE kd.source_version_id = dv.id
   AND kd.file_hash IS NULL
   AND dv.file_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS estate_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  -- belongs_to_unit | in_project | project_scope | about_asset | tagged_to |
  -- filed_under (also-filed, the symbolic link) | alias_of | related
  -- Text, not an enum: a DB allowlist that needs a migration every time the
  -- code learns a relationship is a proven footgun here.
  type TEXT NOT NULL,
  -- human | codebook | resolver | bridge | proposer | vision | scanner
  origin TEXT NOT NULL DEFAULT 'human',
  -- provable (arithmetic, not opinion) | strong | inferred
  tier TEXT NOT NULL DEFAULT 'provable' CHECK (tier IN ('provable', 'strong', 'inferred')),
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  -- applied (live) | pending (awaiting review) | dismissed (remembered so the
  -- engine never nags twice) | stale (the fact's revision is gone)
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'pending', 'dismissed', 'stale')),
  -- One human sentence. Rendered verbatim: "Folder '20 - Crude' names unit 20".
  summary TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  version_id UUID,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by UUID,
  decided_by_name TEXT,
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS estate_edges_unique_idx ON estate_edges (org_id, a, b, type);
CREATE INDEX IF NOT EXISTS estate_edges_a_idx ON estate_edges (org_id, a);
CREATE INDEX IF NOT EXISTS estate_edges_b_idx ON estate_edges (org_id, b);
CREATE INDEX IF NOT EXISTS estate_edges_status_idx ON estate_edges (org_id, status);

ALTER TABLE estate_edges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS estate_edges_read ON estate_edges;
CREATE POLICY estate_edges_read ON estate_edges FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = estate_edges.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS estate_edges_write ON estate_edges;
CREATE POLICY estate_edges_write ON estate_edges FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = estate_edges.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = estate_edges.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')));
