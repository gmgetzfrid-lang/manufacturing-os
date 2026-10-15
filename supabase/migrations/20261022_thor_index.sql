-- 20261022_thor_index.sql
--
-- THOR — the refinery NAS (\\thor\Equipment Files) as a searchable document
-- source. The THOR Indexer (a separate Python tool) crawled the share into a
-- SQLite knowledge database; scripts/thor_import.py copies that database here.
--
-- What lives here is METADATA ONLY: paths, names, sizes, dates, and what the
-- indexer inferred about equipment. The files themselves stay on THOR. A
-- browser opens an original read-only through the File System Access API
-- (lib/thor/nasAccess.ts) — no bytes are ever uploaded.
--
--   thor_roots          — an indexed share (one row per root the indexer knows)
--   thor_crawls         — each crawl of a root: when, how many files/dirs
--   thor_directories    — every folder the crawl walked, when it was indexed,
--                         its role (inspection / drawings / datasheets…) and
--                         rolled-up file counts
--   thor_files          — one row per file, exact UNC path preserved, plus a
--                         search vector built by the importer
--   thor_entities       — equipment, document families, projects the indexer
--                         derived (algorithmic, challengeable — not facts)
--   thor_aliases        — what an entity is called (2010.03, V-3, "PREFRACTIONATOR
--                         TOWER") with ambiguity status
--   thor_alias_entities — which entity an alias may mean, with confidence
--   thor_file_entities  — file ↔ entity links with basis and confidence
--   thor_relationships  — entity ↔ entity links with scores
--   thor_doc_families / thor_doc_members — drawing sheets and revisions
--   thor_identifiers    — every identifier read from a path or excerpt
--   thor_evidence       — why the indexer believes each link (provenance)
--   thor_issues         — what the crawl could not read or chose to exclude
--
-- Stable ids are the indexer's own (file_…, entity_…, alias_…), so a re-import
-- of a later crawl upserts in place. Every table is org-scoped and readable
-- only by active members of that org; nothing is writable through the API —
-- the importer writes as the database owner.
--
-- Idempotent. Apply after 20261021.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Roots and crawls ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS thor_roots (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  -- The document source this root belongs to. 'THOR' for the NAS.
  source TEXT NOT NULL DEFAULT 'THOR',
  -- Exact UNC path, e.g. \\thor\Equipment Files
  unc_path TEXT NOT NULL,
  norm_path TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  last_crawl_at TIMESTAMPTZ,
  explorer_completed_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  indexer_name TEXT,
  indexer_version TEXT,
  index_generated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, root_id)
);

CREATE TABLE IF NOT EXISTS thor_crawls (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  crawl_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  files_seen INTEGER,
  dirs_seen INTEGER,
  issues INTEGER,
  PRIMARY KEY (org_id, crawl_id)
);

-- ── Directories ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS thor_directories (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  -- Relative to the root, '/'-separated; '' is the root itself.
  rel_path TEXT NOT NULL,
  unc_path TEXT NOT NULL,
  parent_rel TEXT,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL,
  -- Top-level unit folder ("2000 - CRUDE UNIT") and its number ("2000").
  unit_folder TEXT,
  unit_code TEXT,
  -- inspection | drawings | datasheets | p_and_id | calculations | archive |
  -- code_documents | equipment_folder | equipment_category | directory
  role TEXT,
  role_confidence REAL,
  role_basis TEXT,
  -- When the crawler finished walking this folder, and its crawl state.
  indexed_at TIMESTAMPTZ,
  crawl_state TEXT,
  crawl_id TEXT,
  crawl_error TEXT,
  -- Files directly in this folder / anywhere beneath it.
  file_count INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  latest_modified_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, root_id, rel_path)
);
CREATE INDEX IF NOT EXISTS thor_directories_parent_idx ON thor_directories (org_id, root_id, parent_rel);
CREATE INDEX IF NOT EXISTS thor_directories_path_trgm_idx ON thor_directories USING gin (lower(rel_path) gin_trgm_ops);

-- ── Files ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS thor_files (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  -- Exact UNC path as the crawler saw it. Never rewritten.
  unc_path TEXT NOT NULL,
  norm_path TEXT NOT NULL,
  -- Relative to the root, '/'-separated — what the browser resolves inside a
  -- folder the user granted.
  rel_path TEXT NOT NULL,
  folder_rel TEXT NOT NULL,
  filename TEXT NOT NULL,
  stem TEXT NOT NULL,
  -- As crawled ('.PDF') and normalised ('pdf', '' when none).
  extension TEXT NOT NULL,
  ext TEXT NOT NULL,
  depth INTEGER NOT NULL,
  size_bytes BIGINT,
  -- Filesystem timestamps. These are NOT engineering-event dates.
  mtime_ns BIGINT,
  ctime_ns BIGINT,
  modified_at TIMESTAMPTZ,
  fs_created_at TIMESTAMPTZ,
  unit_folder TEXT,
  unit_code TEXT,
  -- Second-level folder under the unit ("10 - VESSELS").
  category_folder TEXT,
  -- Nearest ancestor folder's indexer role (inspection, drawings…), if any.
  folder_role TEXT,
  -- Equipment numbers read from this file's path/name or linked by the indexer.
  equipment_numbers TEXT[] NOT NULL DEFAULT '{}',
  filename_class TEXT,
  useful BOOLEAN NOT NULL DEFAULT TRUE,
  observation_state TEXT NOT NULL,
  change_state TEXT,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  first_crawl TEXT,
  last_crawl TEXT,
  content_hash TEXT,
  hash_alg TEXT,
  inspection_value REAL,
  information_value REAL,
  parsed_at TIMESTAMPTZ,
  content_excerpt TEXT,
  content_method TEXT,
  -- Built by the importer from filename (A), linked equipment names (B) and
  -- folder path (C) tokens. See lib/thor/tokens.ts — the query side uses the
  -- same normaliser.
  search_tsv TSVECTOR,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, file_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS thor_files_norm_path_idx ON thor_files (org_id, norm_path);
CREATE INDEX IF NOT EXISTS thor_files_tsv_idx ON thor_files USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS thor_files_name_trgm_idx ON thor_files USING gin (lower(filename) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS thor_files_equipment_idx ON thor_files USING gin (equipment_numbers);
CREATE INDEX IF NOT EXISTS thor_files_modified_idx ON thor_files (org_id, modified_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS thor_files_size_idx ON thor_files (org_id, size_bytes);
CREATE INDEX IF NOT EXISTS thor_files_ext_idx ON thor_files (org_id, ext, modified_at DESC);
CREATE INDEX IF NOT EXISTS thor_files_unit_idx ON thor_files (org_id, unit_code, modified_at DESC);
CREATE INDEX IF NOT EXISTS thor_files_folder_idx ON thor_files (org_id, folder_rel text_pattern_ops);
CREATE INDEX IF NOT EXISTS thor_files_name_sort_idx ON thor_files (org_id, lower(filename));
CREATE INDEX IF NOT EXISTS thor_files_role_idx ON thor_files (org_id, folder_role, modified_at DESC);

-- ── Entities, aliases, links ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS thor_entities (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  -- equipment | document_family | project | document_concept
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  -- Unit number derived from an equipment number (2010.03 → 2000).
  unit_code TEXT,
  scope TEXT,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  -- 'algorithmic' for everything the indexer produced. Not verified.
  authority TEXT NOT NULL,
  persistence_class INTEGER,
  first_seen TIMESTAMPTZ,
  last_validated TIMESTAMPTZ,
  attributes JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, entity_id)
);
CREATE INDEX IF NOT EXISTS thor_entities_name_idx ON thor_entities (org_id, entity_type, canonical_name);

CREATE TABLE IF NOT EXISTS thor_aliases (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  alias_id TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized TEXT NOT NULL,
  -- Compact match key from lib/thor/tokens.ts ("V-3" → "v3").
  match_key TEXT NOT NULL,
  -- equipment_number | equipment_tag | equipment_description | pid_family | afe | u1a
  alias_type TEXT NOT NULL,
  specificity REAL NOT NULL,
  globally_unique BOOLEAN NOT NULL DEFAULT FALSE,
  -- active | ambiguous (one tag, several units: V-3 exists in six units)
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, alias_id)
);
CREATE INDEX IF NOT EXISTS thor_aliases_key_idx ON thor_aliases (org_id, match_key);
CREATE INDEX IF NOT EXISTS thor_aliases_value_trgm_idx ON thor_aliases USING gin (lower(value) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS thor_alias_entities (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  alias_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  independent_sources INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  PRIMARY KEY (org_id, alias_id, entity_id)
);
CREATE INDEX IF NOT EXISTS thor_alias_entities_entity_idx ON thor_alias_entities (org_id, entity_id);

CREATE TABLE IF NOT EXISTS thor_file_entities (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  -- DOCUMENT_FOR_EQUIPMENT | MEMBER_OF_DOCUMENT_FAMILY
  link_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  -- How the indexer decided: filename_identifier, parsed_filename, …
  basis TEXT NOT NULL,
  evidence_path TEXT,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, link_id)
);
CREATE INDEX IF NOT EXISTS thor_file_entities_file_idx ON thor_file_entities (org_id, file_id);
CREATE INDEX IF NOT EXISTS thor_file_entities_entity_idx ON thor_file_entities (org_id, entity_id);

CREATE TABLE IF NOT EXISTS thor_relationships (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rel_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  authority TEXT NOT NULL,
  persistence_class INTEGER,
  positive_score REAL,
  negative_score REAL,
  created_at TIMESTAMPTZ,
  last_validated TIMESTAMPTZ,
  PRIMARY KEY (org_id, rel_id)
);
CREATE INDEX IF NOT EXISTS thor_relationships_from_idx ON thor_relationships (org_id, from_id);
CREATE INDEX IF NOT EXISTS thor_relationships_to_idx ON thor_relationships (org_id, to_id);

CREATE TABLE IF NOT EXISTS thor_doc_families (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  base_identifier TEXT NOT NULL,
  family_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, family_id)
);

CREATE TABLE IF NOT EXISTS thor_doc_members (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  sheet TEXT,
  revision TEXT,
  member_type TEXT,
  confidence REAL NOT NULL,
  PRIMARY KEY (org_id, family_id, file_id)
);
CREATE INDEX IF NOT EXISTS thor_doc_members_file_idx ON thor_doc_members (org_id, file_id);

CREATE TABLE IF NOT EXISTS thor_identifiers (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  identifier_id TEXT NOT NULL,
  file_id TEXT,
  root_id TEXT,
  -- equipment_number | revision | pid_family | sheet | u1a | afe
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  raw_value TEXT,
  -- path_or_filename | embedded_text
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  semantic_power REAL,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, identifier_id)
);
CREATE INDEX IF NOT EXISTS thor_identifiers_file_idx ON thor_identifiers (org_id, file_id);
CREATE INDEX IF NOT EXISTS thor_identifiers_value_idx ON thor_identifiers (org_id, type, value);

CREATE TABLE IF NOT EXISTS thor_evidence (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  polarity INTEGER NOT NULL,
  weight REAL NOT NULL,
  source_file_id TEXT,
  source_root_id TEXT,
  lineage_key TEXT NOT NULL,
  description TEXT,
  -- observed | inferred
  observed_or_inferred TEXT NOT NULL,
  authority TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS thor_evidence_subject_idx ON thor_evidence (org_id, subject_type, subject_id);

CREATE TABLE IF NOT EXISTS thor_issues (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL,
  crawl_id TEXT,
  root_id TEXT,
  unc_path TEXT,
  reason_code TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, issue_id)
);

-- ── Row-level security: members read, nobody writes through the API ──────────

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['thor_roots','thor_crawls','thor_directories','thor_files',
    'thor_entities','thor_aliases','thor_alias_entities','thor_file_entities',
    'thor_relationships','thor_doc_families','thor_doc_members','thor_identifiers',
    'thor_evidence','thor_issues']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (caller_is_active_member(org_id))',
                   t || '_read', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM authenticated', t);
  END LOOP;
END $$;

-- ── Word rarity ──────────────────────────────────────────────────────────────
--
-- How many files hold each search token. A rare word ("tray": 913 files) says
-- far more about what is wanted than a common one ("crude": 40,000), so the
-- search weighs every word by its rarity. Rebuilt from the search vectors by
-- thor_refresh_lexemes() after each import; the '' row holds the file count.

CREATE TABLE IF NOT EXISTS thor_lexemes (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lexeme TEXT NOT NULL,
  df INTEGER NOT NULL,
  PRIMARY KEY (org_id, lexeme)
);
CREATE INDEX IF NOT EXISTS thor_lexemes_prefix_idx ON thor_lexemes (org_id, lexeme text_pattern_ops);
ALTER TABLE thor_lexemes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS thor_lexemes_read ON thor_lexemes;
CREATE POLICY thor_lexemes_read ON thor_lexemes FOR SELECT USING (caller_is_active_member(org_id));
REVOKE ALL ON thor_lexemes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON thor_lexemes FROM authenticated;

-- Importer-only (not granted to API roles).
CREATE OR REPLACE FUNCTION thor_refresh_lexemes(p_org UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_n INTEGER;
BEGIN
  DELETE FROM thor_lexemes WHERE org_id = p_org;
  INSERT INTO thor_lexemes (org_id, lexeme, df)
  SELECT p_org, word, ndoc FROM ts_stat(format('SELECT search_tsv FROM thor_files WHERE org_id = %L', p_org));
  INSERT INTO thor_lexemes (org_id, lexeme, df)
  SELECT p_org, '', count(*) FROM thor_files WHERE org_id = p_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN (SELECT count(*) FROM thor_lexemes WHERE org_id = p_org);
END;
$$;
REVOKE ALL ON FUNCTION thor_refresh_lexemes FROM PUBLIC, anon, authenticated;

-- ── Search ───────────────────────────────────────────────────────────────────
--
-- One call answers a search box + filters with a page of ranked results.
--
-- What the person asked for outright is REQUIRED: a type ("only PDFs"), a
-- document kind ("only drawings"), a unit, an equipment tag that resolved,
-- dates, sizes, a folder. p_tags are equipment tags ("v3"); with p_units they
-- resolve through thor_aliases — "V-3 in the crude unit" means 2010.03, not
-- the five other V-3s. A tag that does not resolve is still required, matched
-- whole as a word (V-1 in a unit that has none finds nothing, and says so).
--
-- Every other word RANKS. p_terms are normalised by lib/thor/tokens.ts and
-- each is a prefix ("prefrac" finds PREFRACTIONATOR). A file's score is, per
-- word it holds, the word's rarity (log of files / files holding it) × where
-- it hit (3 in the filename, 2 in its linked equipment's names, 1 in its
-- folder chain) × 2 for what the person said they are looking for
-- (p_primary: "…I'm looking for TRAY DRAWINGS"). Files are grouped strong /
-- partial / weak by score against the best possible; within a group the
-- requested order applies (newest…), or the score itself for best match.
-- Backup and lock files (.bak, .tmp, .dwl) score half: real, rarely wanted.
--
-- Fast on 211k files: the rarest words pick the candidates (a few thousand
-- files at most, scored whole); files holding only common words follow in
-- date order, scored a page at a time. Counts stop at 1,000.
--
-- matched_terms says, per word hit, where: 'tray:name', 'prefrac:folder',
-- 'v3:equipment' — the UI turns that into "why this file".

DO $$
DECLARE f REGPROCEDURE;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'thor_search'
  LOOP EXECUTE 'DROP FUNCTION ' || f; END LOOP;
END $$;

CREATE OR REPLACE FUNCTION thor_search(
  p_org UUID,
  p_terms TEXT[] DEFAULT '{}',
  p_tags TEXT[] DEFAULT '{}',
  p_kind_exts TEXT[] DEFAULT NULL,
  p_kind_roles TEXT[] DEFAULT NULL,
  p_exts TEXT[] DEFAULT NULL,
  p_units TEXT[] DEFAULT NULL,
  p_equipment TEXT[] DEFAULT NULL,
  p_folder TEXT DEFAULT NULL,
  p_roles TEXT[] DEFAULT NULL,
  p_min_size BIGINT DEFAULT NULL,
  p_max_size BIGINT DEFAULT NULL,
  p_after TIMESTAMPTZ DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_name_contains TEXT DEFAULT NULL,
  p_include_excluded BOOLEAN DEFAULT FALSE,
  p_sort TEXT DEFAULT 'relevance',
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_primary TEXT[] DEFAULT '{}'
)
RETURNS TABLE (
  file_id TEXT,
  root_id TEXT,
  unc_path TEXT,
  rel_path TEXT,
  folder_rel TEXT,
  filename TEXT,
  ext TEXT,
  size_bytes BIGINT,
  modified_at TIMESTAMPTZ,
  unit_folder TEXT,
  unit_code TEXT,
  category_folder TEXT,
  folder_role TEXT,
  equipment_numbers TEXT[],
  observation_state TEXT,
  -- Score as a share of the best possible (0–1), and its group: 2 strong, 1 partial, 0 weak.
  rank REAL,
  strength INTEGER,
  matched_terms TEXT[],
  total_count BIGINT,
  total_capped BOOLEAN,
  full_count BIGINT,
  full_capped BOOLEAN,
  resolved_equipment TEXT[]
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_words TEXT[] := '{}';
  v_q TSQUERY[] := '{}';
  v_qa TSQUERY[] := '{}';
  v_qb TSQUERY[] := '{}';
  v_wt REAL[] := '{}';
  v_df BIGINT[] := '{}';
  v_any TSQUERY;
  v_all TSQUERY;
  v_sel TSQUERY;
  v_must TSQUERY;
  v_tag_equipment TEXT[];
  v_unresolved TEXT[] := '{}';
  v_tag TEXT;
  v_hit TEXT[];
  v_w TEXT;
  v_pre BOOLEAN;
  v_lex TEXT;
  v_n BIGINT;
  v_d BIGINT;
  v_max REAL := 0;
  v_cum BIGINT := 0;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_cap CONSTANT INTEGER := 1000;
  v_sel_cap CONSTANT INTEGER := 6000;
  v_total BIGINT;
  v_full BIGINT;
  v_c BIGINT;
  v_got BIGINT;
  v_where TEXT;
  v_order TEXT;
  v_hard BOOLEAN;
  v_folder_like TEXT;
  v_name_like TEXT;
  -- Per file: the score, its group, and where each word hit.
  v_score CONSTANT TEXT := 'SELECT COALESCE(sum(u.wt * CASE WHEN f.search_tsv @@ u.qa THEN 3 WHEN f.search_tsv @@ u.qb THEN 2
                                     WHEN f.search_tsv @@ u.q THEN 1 ELSE 0 END), 0) / $27
         * CASE WHEN f.ext IN (''bak'', ''tmp'', ''dwl'', ''dwl2'', ''sv$'') THEN 0.5 ELSE 1 END AS score,
       COALESCE(array_agg(u.w || CASE WHEN f.search_tsv @@ u.qa THEN '':name'' WHEN f.search_tsv @@ u.qb THEN '':equipment''
                                      ELSE '':folder'' END) FILTER (WHERE f.search_tsv @@ u.q), ''{}'') AS words
  FROM unnest($23::text[], $24::tsquery[], $25::tsquery[], $26::tsquery[], $28::real[]) AS u(w, q, qa, qb, wt)';
  v_cols CONSTANT TEXT := 'f.file_id, f.root_id, f.unc_path, f.rel_path, f.folder_rel, f.filename, f.ext, f.size_bytes,
       f.modified_at, f.unit_folder, f.unit_code, f.category_folder, f.folder_role, f.equipment_numbers,
       f.observation_state, s.score::real,
       (CASE WHEN s.score >= 0.6 THEN 2 WHEN s.score >= 0.3 THEN 1 ELSE 0 END)::int, s.words,
       $17::bigint, $18::boolean, $21::bigint, $22::boolean, $3::text[]';
BEGIN
  IF NOT caller_is_active_member(p_org) THEN
    RAISE EXCEPTION 'not a member of this organisation' USING ERRCODE = '42501';
  END IF;

  -- Equipment tags: resolve each through aliases, scoped by unit when given.
  FOREACH v_tag IN ARRAY COALESCE(p_tags, '{}') LOOP
    SELECT array_agg(DISTINCT e.canonical_name) INTO v_hit
      FROM thor_aliases a
      JOIN thor_alias_entities ae ON ae.org_id = a.org_id AND ae.alias_id = a.alias_id
      JOIN thor_entities e ON e.org_id = ae.org_id AND e.entity_id = ae.entity_id
     WHERE a.org_id = p_org AND a.match_key = v_tag
       AND a.alias_type IN ('equipment_tag', 'equipment_number')
       AND e.entity_type = 'equipment'
       AND (p_units IS NULL OR e.unit_code = ANY (p_units));
    IF v_hit IS NULL THEN
      v_unresolved := v_unresolved || v_tag;
    ELSE
      v_tag_equipment := COALESCE(v_tag_equipment, '{}') || v_hit;
    END IF;
  END LOOP;
  SELECT string_agg(quote_literal(t), ' & ')::tsquery INTO v_must
    FROM (SELECT regexp_replace(lower(x), '[^a-z0-9.]', '', 'g') AS t FROM unnest(v_unresolved) x) u
   WHERE t !~ '^[.]*$';

  -- Words, rarest first, each with its weight. Lexemes keep [a-z0-9.] only —
  -- they are quoted straight into a tsquery.
  SELECT df INTO v_n FROM thor_lexemes WHERE org_id = p_org AND lexeme = '';
  v_n := GREATEST(COALESCE(v_n, 1), 1);
  FOR v_w, v_pre IN
    SELECT w, bool_or(pr) FROM (
      SELECT regexp_replace(lower(x), '[^a-z0-9.]', '', 'g') AS w,
             regexp_replace(lower(x), '[^a-z0-9.]', '', 'g') = ANY (
               SELECT regexp_replace(lower(y), '[^a-z0-9.]', '', 'g') FROM unnest(COALESCE(p_primary, '{}')) y) AS pr
        FROM unnest(COALESCE(p_terms, '{}')) x) s
     WHERE w !~ '^[.]*$' GROUP BY w
  LOOP
    SELECT COALESCE(sum(l.df), 0) INTO v_d FROM thor_lexemes l
     WHERE l.org_id = p_org AND l.lexeme LIKE replace(v_w, '_', '\_') || '%' AND l.lexeme <> '';
    v_d := LEAST(v_d, v_n);
    v_lex := quote_literal(v_w) || ':*';
    v_words := v_words || v_w;
    v_q := v_q || v_lex::tsquery;
    v_qa := v_qa || (v_lex || 'A')::tsquery;
    v_qb := v_qb || (v_lex || 'AB')::tsquery;
    v_df := v_df || v_d;
    v_wt := v_wt || (ln((v_n + 1)::real / (v_d + 1)) * CASE WHEN v_pre THEN 2 ELSE 1 END)::real;
  END LOOP;
  IF array_length(v_words, 1) > 0 THEN
    SELECT string_agg('(' || q::text || ')', ' | ')::tsquery, string_agg('(' || q::text || ')', ' & ')::tsquery
      INTO v_any, v_all FROM unnest(v_q) q;
    SELECT sum(w * 3) INTO v_max FROM unnest(v_wt) w;
    v_max := GREATEST(v_max, 0.0001);
    -- The selective words: rarest first, until they cover ~6,000 files.
    FOR v_lex, v_d IN SELECT q::text, d FROM unnest(v_q, v_df) AS t(q, d) ORDER BY d LOOP
      EXIT WHEN v_sel IS NOT NULL AND v_cum + v_d > v_sel_cap;
      EXIT WHEN v_d > v_sel_cap * 2;
      v_sel := CASE WHEN v_sel IS NULL THEN v_lex::tsquery ELSE v_sel || v_lex::tsquery END;
      v_cum := v_cum + v_d;
    END LOOP;
  END IF;

  -- Required: only what was asked for outright. Values travel as
  -- parameters, never as SQL text.
  v_where := 'f.org_id = $1';
  IF NOT COALESCE(p_include_excluded, FALSE) THEN v_where := v_where || ' AND f.useful'; END IF;
  IF v_tag_equipment IS NOT NULL THEN v_where := v_where || ' AND f.equipment_numbers && $3'; END IF;
  IF v_must IS NOT NULL THEN v_where := v_where || format(' AND f.search_tsv @@ %L::tsquery', v_must::text); END IF;
  IF p_equipment IS NOT NULL THEN v_where := v_where || ' AND f.equipment_numbers && $4'; END IF;
  IF p_kind_exts IS NOT NULL OR p_kind_roles IS NOT NULL THEN
    v_where := v_where || ' AND (f.ext = ANY (COALESCE($5, ''{}''::text[])) OR f.folder_role = ANY (COALESCE($6, ''{}''::text[])))';
  END IF;
  IF p_exts IS NOT NULL THEN v_where := v_where || ' AND f.ext = ANY ($7)'; END IF;
  IF p_units IS NOT NULL THEN v_where := v_where || ' AND f.unit_code = ANY ($8)'; END IF;
  IF p_roles IS NOT NULL THEN v_where := v_where || ' AND f.folder_role = ANY ($9)'; END IF;
  IF COALESCE(p_folder, '') <> '' THEN
    v_where := v_where || ' AND (f.folder_rel = $10 OR f.folder_rel LIKE $11)';
    v_folder_like := replace(replace(replace(p_folder, '\', '\\'), '%', '\%'), '_', '\_') || '/%';
  END IF;
  IF p_min_size IS NOT NULL THEN v_where := v_where || ' AND f.size_bytes >= $12'; END IF;
  IF p_max_size IS NOT NULL THEN v_where := v_where || ' AND f.size_bytes <= $13'; END IF;
  IF p_after IS NOT NULL THEN v_where := v_where || ' AND f.modified_at >= $14'; END IF;
  IF p_before IS NOT NULL THEN v_where := v_where || ' AND f.modified_at < $15'; END IF;
  IF COALESCE(p_name_contains, '') <> '' THEN
    v_where := v_where || ' AND lower(f.filename) LIKE $16';
    v_name_like := '%' || replace(replace(replace(lower(p_name_contains), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;
  v_hard := v_where !~ '^f\.org_id = \$1( AND f\.useful)?$';
  -- Nothing required: a file must hit at least one word.
  IF v_any IS NOT NULL AND NOT v_hard THEN v_where := v_where || ' AND f.search_tsv @@ $2'; END IF;

  -- Counted up to a cap (the UI says "1,000+"): counting 100,000 matches
  -- would read 100,000 rows.
  EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM thor_files f WHERE %s LIMIT %s) c', v_where, v_cap + 1)
     INTO v_total
    USING p_org, v_any, v_tag_equipment, p_equipment, p_kind_exts, p_kind_roles, p_exts, p_units, p_roles,
          p_folder, v_folder_like, p_min_size, p_max_size, p_after, p_before, v_name_like;
  IF v_all IS NOT NULL THEN
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM thor_files f WHERE %s AND f.search_tsv @@ $17 LIMIT %s) c', v_where, v_cap + 1)
       INTO v_full
      USING p_org, v_any, v_tag_equipment, p_equipment, p_kind_exts, p_kind_roles, p_exts, p_units, p_roles,
            p_folder, v_folder_like, p_min_size, p_max_size, p_after, p_before, v_name_like, v_all;
  ELSE
    v_full := v_total;
  END IF;

  v_order := CASE
    WHEN p_sort = 'oldest' THEN 'f.modified_at ASC NULLS FIRST, f.file_id'
    WHEN p_sort = 'largest' THEN 'f.size_bytes DESC NULLS FIRST, f.file_id'
    WHEN p_sort = 'smallest' THEN 'f.size_bytes ASC NULLS LAST, f.file_id'
    WHEN p_sort = 'name' THEN 'lower(f.filename), f.file_id'
    ELSE 'f.modified_at DESC NULLS LAST, f.file_id' END;

  IF v_any IS NULL THEN
    -- No words: a plain ORDER BY; the planner estimates these filters well.
    RETURN QUERY EXECUTE format(
      'SELECT f.file_id, f.root_id, f.unc_path, f.rel_path, f.folder_rel, f.filename, f.ext, f.size_bytes,
              f.modified_at, f.unit_folder, f.unit_code, f.category_folder, f.folder_role, f.equipment_numbers,
              f.observation_state, 0::real, 0, ''{}''::text[], $17::bigint, $18::boolean, $17::bigint, $18::boolean, $3::text[]
         FROM thor_files f WHERE %s ORDER BY %s LIMIT $19 OFFSET $20', v_where, v_order)
      USING p_org, v_any, v_tag_equipment, p_equipment, p_kind_exts, p_kind_roles, p_exts, p_units, p_roles,
            p_folder, v_folder_like, p_min_size, p_max_size, p_after, p_before, v_name_like,
            LEAST(v_total, v_cap), v_total > v_cap, v_limit, v_offset;
    RETURN;
  END IF;

  -- 1. Files holding a rare word: scored whole, best group first.
  IF v_sel IS NOT NULL THEN
    RETURN QUERY EXECUTE format(
      'SELECT %s FROM thor_files f CROSS JOIN LATERAL (%s) s WHERE %s AND f.search_tsv @@ $29
        ORDER BY (CASE WHEN s.score >= 0.6 THEN 2 WHEN s.score >= 0.3 THEN 1 ELSE 0 END) DESC, %s
        LIMIT $19 OFFSET $20',
      v_cols, v_score, v_where,
      CASE WHEN p_sort IN ('newest', 'oldest', 'largest', 'smallest', 'name') THEN v_order || ', s.score DESC'
           ELSE 's.score DESC, f.modified_at DESC NULLS LAST, f.file_id' END)
      USING p_org, v_any, v_tag_equipment, p_equipment, p_kind_exts, p_kind_roles, p_exts, p_units, p_roles,
            p_folder, v_folder_like, p_min_size, p_max_size, p_after, p_before, v_name_like,
            LEAST(v_total, v_cap), v_total > v_cap, v_limit, v_offset,
            LEAST(v_full, v_cap), v_full > v_cap, v_words, v_q, v_qa, v_qb, v_max, v_wt, v_sel;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got >= v_limit THEN RETURN; END IF;
    -- How many there were, to know where the rest starts.
    EXECUTE format('SELECT count(*) FROM thor_files f WHERE %s AND f.search_tsv @@ $17', v_where)
       INTO v_c
      USING p_org, v_any, v_tag_equipment, p_equipment, p_kind_exts, p_kind_roles, p_exts, p_units, p_roles,
            p_folder, v_folder_like, p_min_size, p_max_size, p_after, p_before, v_name_like, v_sel;
    v_offset := GREATEST(v_offset - v_c, 0);
    v_limit := v_limit - v_got::int;
  END IF;

  -- 2. The rest — files holding only common words (or, when something else
  -- was required, none): in the requested order, a page at a time. The
  -- planner can't tell a word in half the files from one in a few, so for a
  -- broad set it is told to walk the order's index.
  PERFORM set_config('enable_bitmapscan', 'off', TRUE);
  RETURN QUERY EXECUTE format(
    'SELECT %s FROM (SELECT * FROM thor_files f WHERE %s %s ORDER BY %s LIMIT $19 OFFSET $20) f
       CROSS JOIN LATERAL (%s) s ORDER BY %s',
    v_cols, v_where, CASE WHEN v_sel IS NOT NULL THEN 'AND NOT (f.search_tsv @@ $29)' ELSE '' END,
    v_order, v_score,
    CASE WHEN v_sel IS NULL AND p_sort NOT IN ('newest', 'oldest', 'largest', 'smallest', 'name')
         THEN 's.score DESC, ' || v_order ELSE v_order END)
    USING p_org, v_any, v_tag_equipment, p_equipment, p_kind_exts, p_kind_roles, p_exts, p_units, p_roles,
          p_folder, v_folder_like, p_min_size, p_max_size, p_after, p_before, v_name_like,
          LEAST(v_total, v_cap), v_total > v_cap, v_limit, v_offset,
          LEAST(v_full, v_cap), v_full > v_cap, v_words, v_q, v_qa, v_qb, v_max, v_wt, v_sel;
  PERFORM set_config('enable_bitmapscan', 'on', TRUE);
END;
$$;

REVOKE ALL ON FUNCTION thor_search FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION thor_search TO authenticated;

-- What the search box can suggest: units, the equipment-type folders under
-- them (VESSELS, EXCHANGERS…), and every piece of equipment with its tags, a
-- readable description and how many files mention it. Read once per visit
-- for ghost-text completion, example searches and tag-to-unit feedback.
CREATE OR REPLACE FUNCTION thor_vocabulary(p_org UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v JSONB;
BEGIN
  IF NOT caller_is_active_member(p_org) THEN
    RAISE EXCEPTION 'not a member of this organisation' USING ERRCODE = '42501';
  END IF;
  WITH counts AS (
    SELECT n, count(*) AS files FROM thor_files f, unnest(f.equipment_numbers) n
     WHERE f.org_id = p_org GROUP BY n
  ), eq AS (
    SELECT e.canonical_name AS number, e.unit_code,
           COALESCE(array_agg(DISTINCT a.value) FILTER (WHERE a.alias_type = 'equipment_tag'), '{}') AS tags,
           (array_agg(a.value ORDER BY (a.value ~* '^[a-z]{1,4}-?\d') DESC, length(a.value) DESC)
              FILTER (WHERE a.alias_type = 'equipment_description' AND a.value ~ '[A-Za-z]{4}'))[1] AS description
      FROM thor_entities e
      LEFT JOIN thor_alias_entities ae ON ae.org_id = e.org_id AND ae.entity_id = e.entity_id
      LEFT JOIN thor_aliases a ON a.org_id = ae.org_id AND a.alias_id = ae.alias_id
     WHERE e.org_id = p_org AND e.entity_type = 'equipment'
     GROUP BY e.canonical_name, e.unit_code
  )
  SELECT jsonb_build_object(
    'units', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', d.unit_code, 'folder', d.name, 'files', d.total_files) ORDER BY d.name), '[]')
                FROM thor_directories d WHERE d.org_id = p_org AND d.depth = 1 AND d.unit_code IS NOT NULL),
    'categories', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', c.name, 'files', c.files) ORDER BY c.files DESC), '[]')
                     FROM (SELECT regexp_replace(d.name, '^\d+[A-Z]?\s*-\s*', '') AS name, sum(d.total_files) AS files
                             FROM thor_directories d
                            WHERE d.org_id = p_org AND d.depth = 2 AND d.unit_code IS NOT NULL AND d.name ~ '^\d+[A-Z]?\s*-\s*[A-Za-z]'
                            GROUP BY 1 HAVING sum(d.total_files) > 0) c),
    'equipment', (SELECT COALESCE(jsonb_agg(jsonb_build_object('number', eq.number, 'unit', eq.unit_code, 'tags', eq.tags,
                          'description', eq.description, 'files', COALESCE(c.files, 0)) ORDER BY COALESCE(c.files, 0) DESC), '[]')
                    FROM eq LEFT JOIN counts c ON c.n = eq.number)
  ) INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION thor_vocabulary FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION thor_vocabulary TO authenticated;

-- Facet counts for the quick filters: how many hits per type group and unit.
-- Same filter semantics as thor_search minus the facet being counted.
CREATE OR REPLACE FUNCTION thor_overview(p_org UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v JSONB;
BEGIN
  IF NOT caller_is_active_member(p_org) THEN
    RAISE EXCEPTION 'not a member of this organisation' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'roots', (SELECT COALESCE(jsonb_agg(to_jsonb(r) - 'org_id'), '[]') FROM thor_roots r WHERE r.org_id = p_org),
    'crawls', (SELECT COALESCE(jsonb_agg(to_jsonb(c) - 'org_id' ORDER BY c.started_at DESC), '[]') FROM thor_crawls c WHERE c.org_id = p_org),
    'files', (SELECT COUNT(*) FROM thor_files f WHERE f.org_id = p_org),
    'directories', (SELECT COUNT(*) FROM thor_directories d WHERE d.org_id = p_org),
    'units', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', d.unit_code, 'folder', d.name,
                       'files', d.total_files, 'bytes', d.total_bytes, 'indexed_at', d.indexed_at) ORDER BY d.name), '[]')
                FROM thor_directories d WHERE d.org_id = p_org AND d.depth = 1),
    'exts', (SELECT COALESCE(jsonb_object_agg(x.ext, x.n), '{}')
               FROM (SELECT f.ext, COUNT(*) n FROM thor_files f WHERE f.org_id = p_org GROUP BY f.ext ORDER BY 2 DESC LIMIT 40) x)
  ) INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION thor_overview FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION thor_overview TO authenticated;
