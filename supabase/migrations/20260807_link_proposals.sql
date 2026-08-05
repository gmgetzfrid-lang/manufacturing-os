-- 20260807_link_proposals.sql
--
-- THE PROPOSAL SPINE — autonomous link discovery that never writes behind
-- your back.
--
-- The system finds connections (off-page connector continuity, shared
-- equipment tags, aliases) and files them as PROPOSALS carrying their
-- evidence. Provable ones apply themselves; everything inferred waits for a
-- human. Every applied link records where it came from and who approved it,
-- so six months from now "why is this here?" has an answer.
--
--   proposed_links   — discovered connections awaiting (or exempt from)
--                      review, with evidence, confidence and revision keying
--   asset_aliases    — the nicknames a normalizer can't derive ("the north
--                      furnace", the pre-renumber tag, the vendor's name)
--   document_related_resources + provenance — approved links say who/why
--   documents.ai_excluded — per-document carve-out from AI reading
--
-- Idempotent. Apply after 20260806.

-- ── Proposed links ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proposed_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- Endpoints. Always stored with the smaller id first (see the unique
  -- index below) so A→B and B→A can never both exist.
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,

  -- Which proposer produced it: 'opc' (off-page continuity), 'tag' (shared
  -- equipment), 'alias' (nickname match), 'semantic' (embedding similarity,
  -- reserved). Text, not an enum — a DB allowlist that needs a migration
  -- every time the code learns something new is a proven footgun here.
  proposer TEXT NOT NULL,

  -- Confidence tier decides the workflow:
  --   'provable'  — arithmetic, not opinion (an OPC ref resolving to exactly
  --                 one sheet). Applied automatically, still fully visible.
  --   'strong'    — good evidence, some ambiguity. Queued.
  --   'inferred'  — a guess with reasons shown. Queued, always.
  tier TEXT NOT NULL DEFAULT 'strong'
    CHECK (tier IN ('provable', 'strong', 'inferred')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),

  -- Why. Rendered to the reviewer verbatim — a link with no visible reason
  -- is worse than no link. e.g. {"summary":"OPC box 44-098 continues here",
  -- "detail":"sheet 12 → sheet 13", "page": 3, "tags": ["E-101"]}
  evidence JSONB NOT NULL DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed', 'stale')),

  -- Revision keying: extracted facts belong to the revision they were read
  -- from. When the source document publishes a new revision, pending
  -- proposals derived from the old one go 'stale' instead of lingering as
  -- ghosts of a drawing that no longer says that.
  source_rev TEXT,

  decided_by UUID,
  decided_by_name TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live proposal per (pair, proposer). Dismissals stay as rows so the
-- engine never nags twice about the same pair — see the proposer code.
CREATE UNIQUE INDEX IF NOT EXISTS proposed_links_pair_idx
  ON proposed_links (document_id, target_document_id, proposer);
CREATE INDEX IF NOT EXISTS proposed_links_org_status_idx
  ON proposed_links (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS proposed_links_doc_idx
  ON proposed_links (document_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS proposed_links_target_idx
  ON proposed_links (target_document_id) WHERE status = 'pending';

ALTER TABLE proposed_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS proposed_links_read ON proposed_links;
CREATE POLICY proposed_links_read ON proposed_links FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = proposed_links.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
-- Deciding a proposal is the same authority as pinning a related link.
DROP POLICY IF EXISTS proposed_links_write ON proposed_links;
CREATE POLICY proposed_links_write ON proposed_links FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = proposed_links.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = proposed_links.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')));

-- ── Provenance on approved links ─────────────────────────────────────────
-- An applied link must be able to answer "who put this here and on what
-- basis" long after the fact.
ALTER TABLE document_related_resources
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'human';
ALTER TABLE document_related_resources
  ADD COLUMN IF NOT EXISTS proposer TEXT;
ALTER TABLE document_related_resources
  ADD COLUMN IF NOT EXISTS evidence JSONB;
ALTER TABLE document_related_resources
  ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE document_related_resources
  ADD COLUMN IF NOT EXISTS approved_by_name TEXT;
-- Set when a later revision removed the evidence this link was built on:
-- the link stays (a human may still want it) but the system says so.
ALTER TABLE document_related_resources
  ADD COLUMN IF NOT EXISTS evidence_lost_at TIMESTAMPTZ;

-- The engine and the graph both need "is this pair already linked?" fast.
CREATE UNIQUE INDEX IF NOT EXISTS document_related_resources_doc_target_idx
  ON document_related_resources (document_id, target_document_id)
  WHERE target_document_id IS NOT NULL;

-- ── Equipment aliases ────────────────────────────────────────────────────
-- Punctuation and case are already handled deterministically by tag
-- normalization (E-22 = E22 = e 22). This table is for what a normalizer
-- can NEVER derive: human nicknames, pre-renumber tags, vendor names.
CREATE TABLE IF NOT EXISTS asset_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  -- Same normalization as tags, so matching is punctuation-blind.
  alias_normalized TEXT NOT NULL,
  -- 'human' (typed by someone) | 'extraction' (a drawing called it this)
  -- | 'vision' (read off a page image). Extraction-sourced aliases are
  -- proposals in spirit: they widen matching but say where they came from.
  origin TEXT NOT NULL DEFAULT 'human',
  note TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_aliases_unique_idx
  ON asset_aliases (asset_id, alias_normalized);
CREATE INDEX IF NOT EXISTS asset_aliases_lookup_idx
  ON asset_aliases (org_id, alias_normalized);

ALTER TABLE asset_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_aliases_read ON asset_aliases;
CREATE POLICY asset_aliases_read ON asset_aliases FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = asset_aliases.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS asset_aliases_write ON asset_aliases;
CREATE POLICY asset_aliases_write ON asset_aliases FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = asset_aliases.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = asset_aliases.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')));

-- ── Visible AI boundary ──────────────────────────────────────────────────
-- The knowledge system already only reads documents inside linked sources.
-- This is the per-document carve-out: index the library, exclude the one
-- confidential file inside it. Enforced server-side at sync/ingest.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ai_excluded BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS documents_ai_excluded_idx
  ON documents (org_id) WHERE ai_excluded;
