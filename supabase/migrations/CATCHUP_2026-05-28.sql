-- ════════════════════════════════════════════════════════════════════
-- CATCHUP_2026-05-28.sql
-- ════════════════════════════════════════════════════════════════════
--
-- Concatenated catch-up script for Supabase. Apply this once to any
-- environment that's behind on the 2026-05-28 migration set.
--
-- Bundles the seven migration files added in this push:
--
--   20260606_operational_entity_graph.sql   plants/units/systems + nullable FKs
--   20260607_search_foundation.sql          tsvector on documents + assets
--   20260608_phase0_deprecation_markers.sql COMMENT ON deprecated columns
--   20260609_phase1_normalization.sql       document_assets + project_documents
--   20260610_phase2_search_completion.sql   tsvector on versions + tickets
--   20260611_phase3_timeline_index.sql      audit_logs composite index
--   20260612_phase5_holds.sql               document_holds + RLS
--
-- How to run:
--
--   1. Open Supabase Studio → SQL Editor for your project.
--   2. Paste this entire file. Run.
--   3. If any section errors, the rest still runs — each is
--      independent. Re-running the whole file is safe; every
--      statement here uses IF NOT EXISTS / OR REPLACE / DROP IF
--      EXISTS so re-execution is idempotent.
--
-- Order matters between sections (later migrations depend on
-- earlier ones). DO NOT shuffle.
--
-- After running, the app should:
--   - boot with no "Could not find the table 'public.document_holds'"
--     errors
--   - show the Operational Scope admin page populated (after you
--     create at least one Plant)
--   - render the Holds strip on every document inspector
--   - show the Compare button + diff overlay on rev history
--
-- This file is a regenerable convenience artifact — the source of
-- truth is the individual migration files under supabase/migrations/.
-- ════════════════════════════════════════════════════════════════════

-- 20260606_operational_entity_graph.sql
--
-- Phase 1 — Operational Entity Graph.
--
-- Introduces the canonical Plant → Unit → System scope hierarchy that
-- documents and equipment hang off of. Until now, scope has lived as
-- freeform `unit TEXT` on tickets and as JSONB asset tags on documents.
-- That works at small scale but loses the operational graph the rest of
-- the platform (timelines, holds, scope-consolidation queue, whiteboard)
-- needs to query against.
--
-- Design choices:
--
-- 1. Strictly ADDITIVE. New tables, new nullable FK columns. No backfill,
--    no rewrite of existing rows, no destructive change. Every existing
--    document/asset/ticket keeps working with NULL scope until somebody
--    chooses to attach it.
--
-- 2. FK ON DELETE SET NULL on the document/asset side. Deleting a Unit
--    must never cascade into deleting drawings or equipment records —
--    the document is the source of truth, the scope is metadata.
--
-- 3. Per-org uniqueness on (org_id, code) where code is set. Two plants
--    in different orgs can share a code; within one org they cannot.
--    Names are NOT unique — refineries reuse names like "Crude Unit"
--    across plants, so uniqueness lives on the optional short code.
--
-- 4. RLS matches the existing org-member-all pattern from
--    20260605_rls_policies_new_tables.sql. Role-based authorization
--    (only Admins can delete a Plant) is application-level, not RLS.

-- ─── Plants ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,                      -- short code, e.g. "BR" for Baton Rouge
  description TEXT,
  location    TEXT,                      -- physical/geographic location
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS plants_org_idx ON plants(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS plants_org_code_uniq
  ON plants(org_id, code) WHERE code IS NOT NULL;

-- ─── Units (inside a Plant) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS units (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  plant_id    UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,             -- "Crude Unit", "Coker", "FCC"
  code        TEXT,                      -- "U100", "U200"
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS units_org_idx ON units(org_id);
CREATE INDEX IF NOT EXISTS units_plant_idx ON units(plant_id);
CREATE UNIQUE INDEX IF NOT EXISTS units_plant_code_uniq
  ON units(plant_id, code) WHERE code IS NOT NULL;

-- ─── Systems (inside a Unit) ────────────────────────────────────
-- "System" is operational language for a logically-grouped piece of a
-- Unit: feed system, overhead system, instrument-air system, etc.
CREATE TABLE IF NOT EXISTS systems (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  plant_id    UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,             -- "Overhead System", "Reflux"
  code        TEXT,
  description TEXT,
  metadata    JSONB DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  UUID NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID
);
CREATE INDEX IF NOT EXISTS systems_org_idx ON systems(org_id);
CREATE INDEX IF NOT EXISTS systems_unit_idx ON systems(unit_id);
CREATE INDEX IF NOT EXISTS systems_plant_idx ON systems(plant_id);
CREATE UNIQUE INDEX IF NOT EXISTS systems_unit_code_uniq
  ON systems(unit_id, code) WHERE code IS NOT NULL;

-- ─── Hang scope off existing tables (nullable, additive) ────────
--
-- Assets and documents both gain optional plant/unit/system pointers.
-- They denormalize plant_id and unit_id down to the system level so
-- queries like "all documents in Plant X" don't need a 3-way join.
-- Trade-off: a system that moves to a different unit requires updating
-- denormalized refs on its children. Acceptable — scope reorganization
-- is rare and is exactly the kind of operation that should leave an
-- audit trail.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS plant_id  UUID REFERENCES plants(id)  ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS unit_id   UUID REFERENCES units(id)   ON DELETE SET NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS system_id UUID REFERENCES systems(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS assets_plant_idx  ON assets(plant_id)  WHERE plant_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_unit_idx   ON assets(unit_id)   WHERE unit_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_system_idx ON assets(system_id) WHERE system_id IS NOT NULL;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS plant_id  UUID REFERENCES plants(id)  ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unit_id   UUID REFERENCES units(id)   ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS system_id UUID REFERENCES systems(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS documents_plant_idx  ON documents(plant_id)  WHERE plant_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_unit_idx   ON documents(unit_id)   WHERE unit_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_system_idx ON documents(system_id) WHERE system_id IS NOT NULL;

-- ─── RLS ────────────────────────────────────────────────────────
-- Matches the pattern from 20260605_rls_policies_new_tables.sql:
-- any active member of the org may read/write rows for that org.
-- App-level role gating (only Admin/DocCtrl can write Plants etc.)
-- is enforced in lib/, not at the DB.

ALTER TABLE plants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "plants_member_all" ON plants;
CREATE POLICY "plants_member_all" ON plants
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = plants.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = plants.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "units_member_all" ON units;
CREATE POLICY "units_member_all" ON units
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = units.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = units.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE systems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "systems_member_all" ON systems;
CREATE POLICY "systems_member_all" ON systems
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = systems.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = systems.org_id AND uid = auth.uid() AND status = 'active'));
-- 20260607_search_foundation.sql
--
-- Phase 2 — Search & Retrieval Foundation.
--
-- Adds operational full-text search to documents and assets without
-- introducing any external dependency (no Algolia, no vector DB, no
-- AI keys). Uses Postgres' built-in `tsvector` + GIN indexes, which
-- ship with every Supabase project.
--
-- Design choices:
--
-- 1. tsvector is maintained by a BEFORE INSERT/UPDATE trigger, not a
--    GENERATED column. Triggers let us flatten JSONB asset_tags into
--    text and concatenate metadata values, which `GENERATED ALWAYS AS`
--    can't easily express. The cost is one extra function call per
--    write; that's a refinery doc-control workload, not a write-heavy
--    OLTP system, so the trade is fine.
--
-- 2. The English dictionary is used as a baseline. Synonyms (e.g.
--    "exchanger" ⇄ "HE" ⇄ "heat exchanger") will plug in later via a
--    Postgres synonym dictionary. The schema's ready for it — the
--    trigger calls `to_tsvector('english', …)` so swapping in a
--    custom config is a one-line change.
--
-- 3. Weights matter. Document title and document_number get weight A
--    (highest), rev/status/tags get B, free metadata/change_log
--    extracts get C. ts_rank_cd then naturally prioritizes title
--    matches over fuzzy metadata hits.
--
-- 4. Strictly additive. No existing row needs touching to keep
--    working; backfill is a single UPDATE the migration runs at the
--    end so existing rows are immediately searchable.

-- ─── documents.search_tsv ───────────────────────────────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION documents_search_tsv_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  asset_tag_text TEXT;
  metadata_text  TEXT;
BEGIN
  -- Flatten asset_tags JSONB → space-separated list of tag strings.
  -- Keeps the tag column searchable without exploding the JSONB.
  asset_tag_text := COALESCE(
    (SELECT string_agg(elem->>'tag', ' ')
       FROM jsonb_array_elements(COALESCE(NEW.asset_tags, '[]'::jsonb)) AS elem
      WHERE elem ? 'tag'),
    ''
  );

  -- Flatten metadata JSONB values to text. Numbers, dates, and
  -- strings all land in the tsv; nested objects/arrays serialize.
  metadata_text := COALESCE(
    (SELECT string_agg(val::text, ' ')
       FROM jsonb_each_text(COALESCE(NEW.metadata, '{}'::jsonb))),
    ''
  );

  NEW.search_tsv :=
      setweight(to_tsvector('english', COALESCE(NEW.title, '')),           'A')
   || setweight(to_tsvector('english', COALESCE(NEW.document_number, '')), 'A')
   || setweight(to_tsvector('english', COALESCE(NEW.name, '')),            'A')
   || setweight(to_tsvector('english', COALESCE(NEW.rev, '')),             'B')
   || setweight(to_tsvector('english', COALESCE(NEW.status, '')),          'B')
   || setweight(to_tsvector('english', COALESCE(array_to_string(NEW.tags, ' '), '')), 'B')
   || setweight(to_tsvector('english', asset_tag_text),                    'B')
   || setweight(to_tsvector('english', metadata_text),                     'C');

  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS documents_search_tsv_trg ON documents;
CREATE TRIGGER documents_search_tsv_trg
  BEFORE INSERT OR UPDATE OF title, document_number, name, rev, status, tags, asset_tags, metadata
  ON documents
  FOR EACH ROW
  EXECUTE FUNCTION documents_search_tsv_refresh();

CREATE INDEX IF NOT EXISTS documents_search_tsv_idx ON documents USING GIN(search_tsv);

-- Backfill once so existing rows are searchable immediately.
-- Touching `title` (a watched column) fires the BEFORE UPDATE trigger
-- which fills search_tsv. The WHERE keeps re-runs idempotent — once
-- a row has a tsv it's skipped.
UPDATE documents SET title = title WHERE search_tsv IS NULL;

-- ─── assets.search_tsv ──────────────────────────────────────────
ALTER TABLE assets ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION assets_search_tsv_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
      setweight(to_tsvector('english', COALESCE(NEW.tag, '')),         'A')
   || setweight(to_tsvector('english', COALESCE(NEW.tag_normalized,'')),'A')
   || setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B')
   || setweight(to_tsvector('english', COALESCE(NEW.location, '')),    'C');
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS assets_search_tsv_trg ON assets;
CREATE TRIGGER assets_search_tsv_trg
  BEFORE INSERT OR UPDATE OF tag, tag_normalized, description, location
  ON assets
  FOR EACH ROW
  EXECUTE FUNCTION assets_search_tsv_refresh();

CREATE INDEX IF NOT EXISTS assets_search_tsv_idx ON assets USING GIN(search_tsv);

UPDATE assets SET tag = tag WHERE search_tsv IS NULL;
-- 20260608_phase0_deprecation_markers.sql
--
-- Phase 0 stabilization — documentation-only migration.
--
-- Adds Postgres COMMENT metadata to the deprecated mirror columns
-- identified in the Phase 0 audit (see docs/ARCHITECTURE.md
-- "Canonical sources of truth"). COMMENT is read by `psql \d+`,
-- by Supabase Studio, and by any schema-introspection tool — future
-- contributors who look at the table see the deprecation note
-- without having to grep the codebase.
--
-- ZERO behavior change. No data touched. No constraints altered.
-- Pure metadata. Safe to run repeatedly (COMMENT is idempotent).

COMMENT ON COLUMN documents.revision IS
  'DEPRECATED mirror of documents.rev. No active reader. Future writers should set only `rev`. See docs/ARCHITECTURE.md.';

COMMENT ON COLUMN documents.revision_history IS
  'DEPRECATED legacy JSONB. Canonical revision history is the document_versions table. No active reader. See docs/ARCHITECTURE.md.';
-- 20260609_phase1_normalization.sql
--
-- Phase 1 completion — normalize document↔asset and project↔document
-- relationships into proper join tables. Until now, those relationships
-- were carried implicitly:
--
--   - document↔asset: documents.asset_tags JSONB held free-form tag
--     strings; the canonical assets row was found by ad-hoc tag lookup.
--     Useful for grids, useless for "which documents reference asset X".
--
--   - project↔document: there was no direct link at all. The only way
--     to find a project's documents was to LEFT JOIN through
--     checkout_sessions and dedupe. That's not normalization, that's
--     archaeology.
--
-- Design choices:
--
-- 1. Two new join tables. RLS by org-member-all. Both populated
--    automatically by triggers from the existing write surfaces:
--    - asset_tags JSONB changes on documents → resync document_assets
--    - new asset created → backfill document_assets for matching tags
--    - checkout_sessions row with project_id → upsert project_documents
--    No caller has to change. The JSONB and checkout writes remain
--    the source-of-truth write surface; the join tables are the
--    normalized read view.
--
-- 2. Strict ON DELETE CASCADE on the join rows — when a document or
--    asset or project is hard-deleted, the join rows go with it.
--    Documents are typically archived (not deleted), so this rarely
--    fires; when it does, the join rows are pure derivable state.
--
-- 3. tag_text preserved on document_assets so we can see *which* tag
--    string in the JSONB matched the canonical asset (`FE-201` vs
--    `FE 201` vs `fe201` — all normalize the same, but humans want
--    to see what was actually written).
--
-- 4. SQL-side tag normalization mirrors lib/assets.ts:normalizeTag:
--    lowercase + strip non-alphanumerics. Lives in a SECURITY DEFINER
--    function so triggers can call it from any row's RLS context.

-- ─── normalize_tag(text) — mirror of lib/assets.ts normalizeTag ──
CREATE OR REPLACE FUNCTION normalize_tag(t TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(regexp_replace(COALESCE(t,''), '[^a-zA-Z0-9]+', '', 'g'));
$$;

-- ─── document_assets join table ────────────────────────────────
CREATE TABLE IF NOT EXISTS document_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  asset_id      UUID NOT NULL REFERENCES assets(id)    ON DELETE CASCADE,
  tag_text      TEXT,           -- the human-typed tag that resolved to this asset
  source        TEXT NOT NULL DEFAULT 'jsonb_sync' CHECK (source IN ('jsonb_sync','manual')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (document_id, asset_id)
);
CREATE INDEX IF NOT EXISTS document_assets_doc_idx   ON document_assets(document_id);
CREATE INDEX IF NOT EXISTS document_assets_asset_idx ON document_assets(asset_id);
CREATE INDEX IF NOT EXISTS document_assets_org_idx   ON document_assets(org_id);

-- ─── project_documents join table ──────────────────────────────
CREATE TABLE IF NOT EXISTS project_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  source        TEXT NOT NULL DEFAULT 'checkout' CHECK (source IN ('checkout','manual')),
  UNIQUE (project_id, document_id)
);
CREATE INDEX IF NOT EXISTS project_documents_project_idx  ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS project_documents_document_idx ON project_documents(document_id);
CREATE INDEX IF NOT EXISTS project_documents_org_idx      ON project_documents(org_id);

-- ─── Trigger: documents.asset_tags ⇄ document_assets ────────────
-- On every documents INSERT/UPDATE-of-asset_tags-or-org_id, rebuild
-- the jsonb_sync rows for that document. We delete and re-insert
-- (rather than diff) because a sheet rarely has more than a handful
-- of tags; the simpler logic is worth the extra writes.
CREATE OR REPLACE FUNCTION documents_resync_assets()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tag_record RECORD;
BEGIN
  -- Wipe existing trigger-managed rows. Manual links (source='manual')
  -- are preserved.
  DELETE FROM document_assets
   WHERE document_id = NEW.id AND source = 'jsonb_sync';

  IF NEW.asset_tags IS NULL OR jsonb_array_length(NEW.asset_tags) = 0 THEN
    RETURN NEW;
  END IF;

  FOR tag_record IN
    SELECT DISTINCT elem->>'tag' AS tag_text
      FROM jsonb_array_elements(NEW.asset_tags) AS elem
     WHERE elem ? 'tag' AND COALESCE(elem->>'tag','') <> ''
  LOOP
    INSERT INTO document_assets (org_id, document_id, asset_id, tag_text, source)
    SELECT NEW.org_id, NEW.id, a.id, tag_record.tag_text, 'jsonb_sync'
      FROM assets a
     WHERE a.org_id = NEW.org_id
       AND a.tag_normalized = normalize_tag(tag_record.tag_text)
     LIMIT 1
    ON CONFLICT (document_id, asset_id) DO NOTHING;
  END LOOP;

  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS documents_resync_assets_trg ON documents;
CREATE TRIGGER documents_resync_assets_trg
  AFTER INSERT OR UPDATE OF asset_tags, org_id ON documents
  FOR EACH ROW
  EXECUTE FUNCTION documents_resync_assets();

-- ─── Trigger: assets INSERT → backfill document_assets ─────────
-- When a new canonical asset is created, link it to any existing
-- documents whose asset_tags JSONB already references it. Without
-- this, an asset that gets registered AFTER the drawings already
-- tag it would have empty back-references.
CREATE OR REPLACE FUNCTION assets_backfill_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO document_assets (org_id, document_id, asset_id, tag_text, source)
  SELECT NEW.org_id, d.id, NEW.id, elem->>'tag', 'jsonb_sync'
    FROM documents d
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.asset_tags, '[]'::jsonb)) AS elem
   WHERE d.org_id = NEW.org_id
     AND elem ? 'tag'
     AND normalize_tag(elem->>'tag') = NEW.tag_normalized
  ON CONFLICT (document_id, asset_id) DO NOTHING;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS assets_backfill_documents_trg ON assets;
CREATE TRIGGER assets_backfill_documents_trg
  AFTER INSERT ON assets
  FOR EACH ROW
  EXECUTE FUNCTION assets_backfill_documents();

-- ─── Trigger: checkout_sessions.project_id → project_documents ─
-- Any checkout that names a project_id contributes a row. last_seen_at
-- moves forward on every touch so "most-recently-active documents in
-- a project" is a cheap query.
CREATE OR REPLACE FUNCTION checkouts_resync_project_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NULL OR NEW.document_id IS NULL OR NEW.org_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO project_documents (org_id, project_id, document_id, first_seen_at, last_seen_at, source)
  VALUES (NEW.org_id, NEW.project_id, NEW.document_id, NOW(), NOW(), 'checkout')
  ON CONFLICT (project_id, document_id) DO UPDATE
    SET last_seen_at = NOW();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS checkouts_resync_project_documents_trg ON checkout_sessions;
CREATE TRIGGER checkouts_resync_project_documents_trg
  AFTER INSERT OR UPDATE OF project_id, document_id ON checkout_sessions
  FOR EACH ROW
  EXECUTE FUNCTION checkouts_resync_project_documents();

-- ─── Backfill existing data ────────────────────────────────────
-- Fire the resync trigger for every existing document by touching
-- asset_tags = asset_tags (idempotent, safe to re-run). Same for
-- checkouts. New assets backfill themselves via the assets trigger.
UPDATE documents
   SET asset_tags = asset_tags
 WHERE jsonb_typeof(asset_tags) = 'array'
   AND jsonb_array_length(asset_tags) > 0;

UPDATE checkout_sessions
   SET project_id = project_id
 WHERE project_id IS NOT NULL
   AND document_id IS NOT NULL;

-- ─── RLS ───────────────────────────────────────────────────────
ALTER TABLE document_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_assets_member_all" ON document_assets;
CREATE POLICY "document_assets_member_all" ON document_assets
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_assets.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_assets.org_id AND uid = auth.uid() AND status = 'active'));

ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_documents_member_all" ON project_documents;
CREATE POLICY "project_documents_member_all" ON project_documents
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = project_documents.org_id AND uid = auth.uid() AND status = 'active'));
-- 20260610_phase2_search_completion.sql
--
-- Phase 2 completion — extend the tsvector-based search foundation to
-- the two surfaces the directive's example queries hit but
-- 20260607_search_foundation.sql skipped:
--
--   - document_versions (so "find revisions modified during TAR"
--     can match against change_log, moc_reference, signoff names)
--   - tickets (so "drawings awaiting engineering over 7 days" can
--     match by title/description/status/keyword)
--
-- Plus a documented synonym-dictionary extension path. The English
-- text-search config is the baseline; refineries that want
-- "exchanger" ⇄ "HE" ⇄ "heat exchanger" can add a custom dictionary
-- without touching the trigger.
--
-- Hold-state search is explicitly out of scope — holds don't exist
-- yet. That ships in Phase 5. The Phase 2 search surface is shaped
-- to accommodate holds when they arrive (separate per-table
-- tsvector + a thin lib function), not to predict their schema.

-- ─── document_versions.search_tsv ─────────────────────────────
-- Weighted: revision_label + moc_reference + source_file_name = A
-- (anchors a user would actually type), change_log = B, signoff
-- names = C.
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION document_versions_search_tsv_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
      setweight(to_tsvector('english', COALESCE(NEW.revision_label,'')),    'A')
   || setweight(to_tsvector('english', COALESCE(NEW.moc_reference,'')),     'A')
   || setweight(to_tsvector('english', COALESCE(NEW.source_file_name,'')),  'A')
   || setweight(to_tsvector('english', COALESCE(NEW.change_log,'')),        'B')
   || setweight(to_tsvector('english', COALESCE(NEW.issue_type,'')),        'B')
   || setweight(to_tsvector('english', COALESCE(NEW.change_type,'')),       'B')
   || setweight(to_tsvector('english', COALESCE(NEW.drawn_by_name,'')),     'C')
   || setweight(to_tsvector('english', COALESCE(NEW.checked_by_name,'')),   'C')
   || setweight(to_tsvector('english', COALESCE(NEW.approved_by_name,'')),  'C')
   || setweight(to_tsvector('english', COALESCE(NEW.created_by_name,'')),   'C');
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS document_versions_search_tsv_trg ON document_versions;
CREATE TRIGGER document_versions_search_tsv_trg
  BEFORE INSERT OR UPDATE OF revision_label, moc_reference, source_file_name,
                              change_log, issue_type, change_type,
                              drawn_by_name, checked_by_name, approved_by_name,
                              created_by_name
  ON document_versions
  FOR EACH ROW
  EXECUTE FUNCTION document_versions_search_tsv_refresh();

CREATE INDEX IF NOT EXISTS document_versions_search_tsv_idx
  ON document_versions USING GIN(search_tsv);

-- Idempotent backfill: touch a watched column to fire the trigger.
UPDATE document_versions SET revision_label = revision_label WHERE search_tsv IS NULL;

-- ─── tickets.search_tsv ───────────────────────────────────────
-- Weighted: ticket_id + title + requester_name = A, request_type +
-- unit + status = B, description + assigned drafter/engineer names
-- + search_keywords = C. Existing comments JSONB and history are NOT
-- flattened in — they grow without bound and would balloon the index
-- without proportionate value.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE OR REPLACE FUNCTION tickets_search_tsv_refresh()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  keywords_text TEXT;
BEGIN
  keywords_text := COALESCE(array_to_string(NEW.search_keywords, ' '), '');
  NEW.search_tsv :=
      setweight(to_tsvector('english', COALESCE(NEW.ticket_id,'')),               'A')
   || setweight(to_tsvector('english', COALESCE(NEW.title,'')),                   'A')
   || setweight(to_tsvector('english', COALESCE(NEW.requester_name,'')),          'A')
   || setweight(to_tsvector('english', COALESCE(NEW.request_type,'')),            'B')
   || setweight(to_tsvector('english', COALESCE(NEW.unit,'')),                    'B')
   || setweight(to_tsvector('english', COALESCE(NEW.status,'')),                  'B')
   || setweight(to_tsvector('english', COALESCE(NEW.description,'')),             'C')
   || setweight(to_tsvector('english', COALESCE(NEW.assigned_drafter_name,'')),   'C')
   || setweight(to_tsvector('english', COALESCE(NEW.assigned_engineer_name,'')),  'C')
   || setweight(to_tsvector('english', keywords_text),                            'C');
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS tickets_search_tsv_trg ON tickets;
CREATE TRIGGER tickets_search_tsv_trg
  BEFORE INSERT OR UPDATE OF ticket_id, title, requester_name, request_type,
                              unit, status, description, assigned_drafter_name,
                              assigned_engineer_name, search_keywords
  ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION tickets_search_tsv_refresh();

CREATE INDEX IF NOT EXISTS tickets_search_tsv_idx ON tickets USING GIN(search_tsv);

UPDATE tickets SET title = title WHERE search_tsv IS NULL;

-- ─── Synonym extension path (documentation only) ─────────────
--
-- To add a custom synonym dictionary for refinery vocabulary
-- ("exchanger" ⇄ "HE", "vessel" ⇄ "vsl", etc.):
--
--   1. Create a synonym dictionary file in the Postgres tsearch_data
--      directory (or use CREATE TEXT SEARCH DICTIONARY in newer
--      PG versions).
--   2. Create a custom text-search configuration that maps the
--      'asciiword' token type through the synonym dictionary
--      *before* the english_stem dictionary.
--   3. Swap `'english'` for the new config name in the trigger
--      functions above. Re-touch each table's watched columns to
--      rebuild search_tsv.
--
-- We deliberately do NOT install a default synonym dict — refineries
-- have site-specific vocabulary, and shipping a generic one would
-- create silent search drift.-- 20260611_phase3_timeline_index.sql
--
-- Phase 3 completion — composite index on audit_logs.
--
-- lib/timeline.ts:getDocumentTimeline filters on
-- (resource_type='document', resource_id=<uuid>) and sorts by
-- timestamp DESC. The existing single-column audit_logs_resource_id_idx
-- matches resource_id alone, forcing the planner to filter on
-- resource_type and re-sort on timestamp at query time. With this
-- composite index the read becomes a single ordered range scan.
--
-- This was flagged in the Phase 0 weak-points list as deferred to
-- "the phase that produces real timeline load." Phase 3 is that
-- phase — every document inspector opens its history, every project
-- page renders its timeline, so audit_logs becomes a hot read path.
--
-- Pure additive index. No data touched. CREATE INDEX IF NOT EXISTS
-- makes it idempotent. CONCURRENTLY would be nicer in prod (avoids
-- write lock during the build) but it's not supported inside a
-- transaction block — Supabase's migration runner wraps everything
-- in a transaction, so we use the plain form. On a fresh org the
-- audit_logs table is small enough that the lock is invisible.

CREATE INDEX IF NOT EXISTS audit_logs_resource_timeline_idx
  ON audit_logs(resource_type, resource_id, timestamp DESC);
-- 20260612_phase5_holds.sql
--
-- Phase 5 — Hold tracking & roadblock metrics.
--
-- A "hold" is an explicit operational stop on a document: it can't
-- be advanced until the blocker is cleared. Until now, this state
-- lived only in chat threads, sticky notes, and people's memory.
-- Putting it in the data model makes:
--
--   - "What's blocking this drawing?" answerable in one query
--   - "How long did this hold last?" automatic via released_at - opened_at
--   - "What's the most common blocker this quarter?" a GROUP BY away
--   - "Show me everything still blocked on Vendor Data >7 days"
--     a single search
--
-- Design choices:
--
-- 1. document_holds is a per-document log, NOT a single-column flag.
--    Multiple holds can be open on the same document simultaneously
--    (typical: "Awaiting Engineering" AND "Missing Vendor Data").
--    released_at = NULL means active.
--
-- 2. Partial UNIQUE on (document_id, reason) WHERE released_at IS NULL
--    prevents accidentally opening two of the same hold. Re-opening
--    a previously-released hold is fine — it gets a new row.
--
-- 3. reason is TEXT with NO check constraint. The four directive-named
--    reasons (Awaiting Engineering / Field Verification Needed /
--    Missing Vendor Data / Client Review) live in the UI's predefined
--    picker; orgs can also enter free-form reasons via "Other". The
--    DB is intentionally permissive — operations vocabulary varies
--    by site and locking the schema would force migrations for
--    every new blocker type.
--
-- 4. Audit row is written by the application (lib/holds.ts) using the
--    existing audit_logs flow, not by a trigger. That keeps the audit
--    actor accurate (we know who pressed the button) instead of
--    fabricating it from session_user.
--
-- 5. No FK to a "current holds" cached column on documents. The
--    listActiveHoldsByDocument query is cheap (partial index) and
--    avoids a denormalized-flag drift problem.

CREATE TABLE IF NOT EXISTS document_holds (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id           UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reason                TEXT NOT NULL,
  notes                 TEXT,
  expected_release_at   TIMESTAMPTZ,
  opened_by             UUID NOT NULL,
  opened_by_name        TEXT,
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by           UUID,
  released_by_name      TEXT,
  released_at           TIMESTAMPTZ,
  released_reason       TEXT
);

-- Single document, single hot reason, single active row at a time.
CREATE UNIQUE INDEX IF NOT EXISTS document_holds_open_reason_uniq
  ON document_holds(document_id, reason) WHERE released_at IS NULL;

-- "Active holds on this document" — covers the inspector strip.
CREATE INDEX IF NOT EXISTS document_holds_active_doc_idx
  ON document_holds(document_id) WHERE released_at IS NULL;

-- "Org-wide active queue" + "by reason" — covers the bottleneck dashboard.
CREATE INDEX IF NOT EXISTS document_holds_active_org_idx
  ON document_holds(org_id, opened_at DESC) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS document_holds_org_reason_idx
  ON document_holds(org_id, reason);

-- Aggregation index for duration metrics over completed holds.
CREATE INDEX IF NOT EXISTS document_holds_org_released_idx
  ON document_holds(org_id, released_at) WHERE released_at IS NOT NULL;

-- RLS — org-member-all, mirroring the established pattern.
ALTER TABLE document_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_holds_member_all" ON document_holds;
CREATE POLICY "document_holds_member_all" ON document_holds
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_holds.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_holds.org_id AND uid = auth.uid() AND status = 'active'));
