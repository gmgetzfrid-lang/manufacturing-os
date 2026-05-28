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
