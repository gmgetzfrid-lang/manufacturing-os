-- 20261019_file_finder.sql
--
-- THE FILE FINDER — searching a messy document estate the way a person would.
--
-- Two tables, both org-scoped, both teachable only by document control:
--
--   finder_aliases   — what people SAY versus what the files SAY. "born"
--                      means the crude unit; "U1-A" is the same thing as
--                      "U1A"; "the north furnace" is F-101. Each alias
--                      carries where it came from and how often results
--                      reached through it were actually opened, so the
--                      ranker can trust a proven alias more than a guess.
--   finder_listings  — a pasted directory listing of a drive the system does
--                      not hold (tree /f, dir /s, or a list of paths). Path
--                      and name only, no bytes. Lets a search answer "not in
--                      the system, but the Thor drive has prospects here".
--
-- Idempotent. Apply after 20261018. A workspace without this migration
-- keeps the finder working from browser storage (per-user, not shared).

CREATE TABLE IF NOT EXISTS finder_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- What people type.
  term TEXT NOT NULL,
  term_canonical TEXT NOT NULL,
  -- What the files say: a unit code/label, a tag, or a word.
  means TEXT NOT NULL,
  means_canonical TEXT NOT NULL,
  -- 'unit' | 'equipment' | 'term'. Text, not an enum (see proposed_links).
  kind TEXT NOT NULL DEFAULT 'term',
  -- 'human' (typed by doc control) | 'ingest' (proposed at upload) | 'usage'
  -- (learned from what people opened). Only humans write here today; the
  -- other two are reserved for the ingestion pre/post engine.
  origin TEXT NOT NULL DEFAULT 'human',
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS finder_aliases_unique_idx
  ON finder_aliases (org_id, term_canonical, means_canonical);
CREATE INDEX IF NOT EXISTS finder_aliases_org_idx ON finder_aliases (org_id);

ALTER TABLE finder_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finder_aliases_read ON finder_aliases;
CREATE POLICY finder_aliases_read ON finder_aliases FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = finder_aliases.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS finder_aliases_write ON finder_aliases;
CREATE POLICY finder_aliases_write ON finder_aliases FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = finder_aliases.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = finder_aliases.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl')));

CREATE TABLE IF NOT EXISTS finder_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- "Thor drive", "T: engineering share"
  name TEXT NOT NULL,
  -- Which listing format was recognised, for the UI's own sanity check.
  format TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  -- [{ "path": ["Crude","Heaters"], "name": "U1A.pdf", "sizeBytes": 123, "date": "2019-01-15" }]
  files JSONB NOT NULL DEFAULT '[]',
  -- ["Crude", "Crude/Heaters", …] including empty folders.
  folders JSONB NOT NULL DEFAULT '[]',
  created_by UUID,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finder_listings_org_idx ON finder_listings (org_id);

ALTER TABLE finder_listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finder_listings_read ON finder_listings;
CREATE POLICY finder_listings_read ON finder_listings FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = finder_listings.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'));
DROP POLICY IF EXISTS finder_listings_write ON finder_listings;
CREATE POLICY finder_listings_write ON finder_listings FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = finder_listings.org_id
                 AND m.uid = auth.uid() AND m.status = 'active'
                 AND m.role IN ('Admin', 'DocCtrl')))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = finder_listings.org_id
                      AND m.uid = auth.uid() AND m.status = 'active'
                      AND m.role IN ('Admin', 'DocCtrl')));
