-- Site Codebook — the org-defined language of the site, taught once and read
-- everywhere (knowledge AI decoder, drafting request forms, equipment
-- registry, the drawing→equipment bridge). NOTHING in the app assumes any
-- particular convention: an org with an empty codebook behaves exactly as
-- before. Two tables:
--
--   codebook_entries — one row per vocabulary item, discriminated by kind:
--     'unit'           code "20"  label "Crude Unit"
--     'equipment_type' code "30"  label "Exchangers"   meta.tagPrefixes ["E"]
--     'drawing_type'   code "02"  label "P&ID"
--
--   codebook_config — one row per org: the drawing-number decoder (an ordered
--     segment map, not a regex), the tag-iterable rule (how E-22 maps to the
--     .22 in 2030.22), attached legend documents, and import provenance.

CREATE TABLE IF NOT EXISTS codebook_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('unit', 'equipment_type', 'drawing_type')),
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  -- kind-specific extras. equipment_type: {"tagPrefixes":["E","EA"]}.
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort        INT NOT NULL DEFAULT 0,
  -- 'manual' | 'import' — display-only provenance; imported rows are just as
  -- editable as typed ones.
  origin      TEXT NOT NULL DEFAULT 'manual',
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, code)
);

CREATE INDEX IF NOT EXISTS idx_codebook_entries_org_kind
  ON codebook_entries (org_id, kind, sort);

CREATE TABLE IF NOT EXISTS codebook_config (
  org_id      UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  -- Ordered segment map for drawing numbers, e.g.
  -- {"segments":[{"kind":"unit","digits":2},{"kind":"drawing_type","digits":2},
  --   {"kind":"size","letters":1},{"kind":"iterable"},{"kind":"sheet"}]}
  -- Interpreted by lib/codebook.ts parseDrawingNumber — separators in the real
  -- numbers (dashes, dots, spaces, "SHT") are tolerated between segments.
  drawing_number  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- {"mirrorsTag":true,"padTo":0} — how a field tag's number becomes the code
  -- iterable (E-22 -> .22). padTo 0 = no padding; 2 = "05" style.
  iterable_rule   JSONB NOT NULL DEFAULT '{"mirrorsTag":true,"padTo":0}'::jsonb,
  -- Knowledge document ids of attached legend sheets (ride into every ask).
  legend_doc_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE codebook_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE codebook_config  ENABLE ROW LEVEL SECURITY;

-- Every org member reads the codebook (all features consume it)…
DROP POLICY IF EXISTS codebook_entries_select ON codebook_entries;
CREATE POLICY codebook_entries_select ON codebook_entries FOR SELECT
  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'));
DROP POLICY IF EXISTS codebook_config_select ON codebook_config;
CREATE POLICY codebook_config_select ON codebook_config FOR SELECT
  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'));

-- …only Admin / DocCtrl write it.
DROP POLICY IF EXISTS codebook_entries_write ON codebook_entries;
CREATE POLICY codebook_entries_write ON codebook_entries FOR ALL
  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin', 'DocCtrl')))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin', 'DocCtrl')));
DROP POLICY IF EXISTS codebook_config_write ON codebook_config;
CREATE POLICY codebook_config_write ON codebook_config FOR ALL
  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin', 'DocCtrl')))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role IN ('Admin', 'DocCtrl')));

-- ── Registry v2 groundwork: assets learn the site's two languages ──────────
-- unit_code ties an asset to a codebook unit ("20"); code is its full site
-- identity ("2030.22"); origin records HOW the asset entered the registry.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS unit_code TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS discovered_from JSONB;
CREATE INDEX IF NOT EXISTS idx_assets_org_unit ON assets (org_id, unit_code);
CREATE INDEX IF NOT EXISTS idx_assets_org_code ON assets (org_id, code);

-- ── The bridge's review state: one row per doc-control document ────────────
-- Holds the latest computed proposal (per-sheet tags + registry resolution)
-- until it's applied (or auto-applied). Recomputes overwrite the proposal;
-- applied history stays in `applied` for idempotent re-runs.
CREATE TABLE IF NOT EXISTS document_equipment_suggestions (
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- [{tag, code, pages:[int], assetId, assetStatus:'existing'|'created'}]
  suggested    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Tags (normalized) that have been written to the document's column by the
  -- bridge — the diff base so re-index never duplicates or re-suggests.
  applied      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at   TIMESTAMPTZ,
  applied_by   UUID,
  PRIMARY KEY (org_id, document_id)
);

ALTER TABLE document_equipment_suggestions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_equip_sugg_select ON document_equipment_suggestions;
CREATE POLICY doc_equip_sugg_select ON document_equipment_suggestions FOR SELECT
  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'));
DROP POLICY IF EXISTS doc_equip_sugg_write ON document_equipment_suggestions;
CREATE POLICY doc_equip_sugg_write ON document_equipment_suggestions FOR ALL
  USING (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active'));

-- Per-library bridge settings (which column receives tags; auto-apply).
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS equipment_bridge JSONB;
