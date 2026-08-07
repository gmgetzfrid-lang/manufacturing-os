-- 20261011_symbol_vocabulary.sql
--
-- THE COMPILED VOCABULARY — a legend stops being a document to search and
-- becomes the SCHEMA the rest of the set is read through.
--
-- What exists today: app/api/knowledge/ask/route.ts pulls up to 40 chunks
-- from the pinned legend documents, slices them to a 6000-character budget,
-- and pastes the result into the prompt under a heading hardcoded to say
-- "P&ID LEGEND". That is the whole of "the legend is ingested", and it has
-- three hard limits:
--
--   · lossy in an unbounded way — a real legend sheet is far more than 6000
--     characters and the truncation point is arbitrary;
--   · invisible to everything except the answering model — lib/pipeTrace.ts
--     is pure geometry and lib/knowledgeVision.ts has a fixed system prompt;
--     neither can read a paragraph of prose;
--   · it costs the same tokens on every single question whether or not any
--     symbol on it is relevant, while crowding out real passages.
--
-- A legend has shapes and names and words that say what things are, and line
-- styles that say what a dashed line means. None of that survives being
-- flattened to text. So compile it: the model NAMES and BOXES, the PIXELS
-- supply every number, a human accepts the result, and three consumers read
-- the same rows.
--
--   1. lib/knowledgeVision.ts — the symbol inventory is appended to
--      VISION_SYSTEM so transcription NAMES glyphs against THIS set's key
--      ("gate valve GV-4 on 6\"-P-1024") instead of transcribing only the
--      text that happens to sit near them. Highest-leverage use: it converts
--      geometry into searchable text AT INGEST, and the named symbols land in
--      knowledge_page_entities where the census already lives, so "count the
--      control valves in unit 20" becomes deterministic.
--   2. lib/pipeTrace.ts — line_style rows tell it a dashed run is a signal
--      and not pipe (today the minRun filter deletes the entire dashed layer
--      along with the text, so it cannot follow a signal line and cannot tell
--      that it has wandered onto one); measured dash periods let short runs
--      be re-stitched instead of discarded; matched glyph footprints replace
--      the blind bridgeRadius guess at valve bodies.
--   3. app/api/knowledge/ask/route.ts — retrieval-time resolution replaces
--      the 6000-character blob: scan the CITED pages for tokens that are keys
--      here and inject only those ~20 definitions. Cheaper AND more accurate
--      than today, which is the argument that makes this worth building.
--
-- GENERALIZATION IS THE POINT, not a P&ID feature. `discipline` and `kind`
-- are open TEXT (20260925 — a CHECK over a code-owned enum is a proven
-- footgun), so an electrical one-line's device key, a loop sheet's signal
-- key, a civil hatch key, a welding-symbol chart, a vendor manual's parts
-- table, a spec's definitions clause and a standards shelf's abbreviation
-- front matter all compile into these same rows through the same resolver.
-- A collection with no drawings in it at all uses this machinery for its
-- abbreviations and its "list of referenced standards" page.
--
-- DEGRADATION IS A CONTRACT, not a hope. Empty vocabulary => every consumer
-- behaves exactly as it does today, byte for byte. That is the acceptance
-- criterion, mirroring EMPTY_CODEBOOK in lib/codebook.ts.
--
-- Service-role only (RLS enabled, no policies) — same posture as
-- knowledge_page_entities and knowledge_line_traces, and for the same
-- reason: these rows are derived from ACL-protected documents and carry a
-- page + bbox + crop back to them, so the API filters per caller through the
-- real ACL engine rather than trusting a row-level rule to split a row.
--
-- Additive + idempotent. Apply after 20261010.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── 1. The compiled artifact ──────────────────────────────────────────────
--
-- This row IS the compilation record. There is deliberately no separate
-- "compilations" table: two tables for one concept is the parallel-system
-- trap this whole design exists to avoid. run_at / model / entry_count /
-- conflict_count / warnings live here.
--
-- It is a PUBLISHABLE, VERSIONED unit because the tracer acts on it. A
-- cached trace has to be able to say which revision named the components on
-- screen, and a legend revision has to be able to invalidate exactly the
-- traces it affects and no others.

CREATE TABLE IF NOT EXISTS knowledge_vocabularies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                      -- "P&ID Legend Rev C"
  -- 'org' | 'library'. An org-scope vocabulary is the site legend every
  -- library inherits; a library-scope one overrides it, exactly the way a
  -- library decoder already overrides codebookToDecoderText().
  scope TEXT NOT NULL DEFAULT 'library',
  library_id UUID REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  -- Open TEXT: 'pid' | 'electrical_oneline' | 'loop' | 'isometric' | 'civil'
  -- | 'ga' | 'general' | anything a site invents. Never a CHECK.
  discipline TEXT NOT NULL DEFAULT 'general',
  -- Which drafting axes the source set uses. RESERVED and load-bearing:
  -- lib/pipeTrace.ts scans rows and columns, so an isometric set must be
  -- refused tracing WITH A REASON rather than traced into silence.
  axes TEXT NOT NULL DEFAULT 'orthogonal',   -- 'orthogonal' | 'isometric' | 'free'

  revision INT NOT NULL DEFAULT 1,
  supersedes_id UUID REFERENCES knowledge_vocabularies(id) ON DELETE SET NULL,
  -- 'compiling' | 'review' | 'active' | 'superseded' | 'stale' | 'error'.
  -- Consumers read ONLY 'active'. A compile lands in 'review' and the
  -- previous active vocabulary keeps serving until a human publishes —
  -- the same publish discipline used elsewhere in this codebase.
  status TEXT NOT NULL DEFAULT 'compiling',
  -- Set when a sanity gate fires: a symbol_key run that yields 2 assertions
  -- off a 40-symbol sheet, or a run against a page with no glyph/label
  -- pairs, completes SUSPECT and feeds no consumer until acknowledged. This
  -- catches the common mis-role — the wrong sheet — at the moment it happens
  -- rather than three weeks of bad answers later.
  suspect_reason TEXT,
  stale_reason TEXT,

  -- Geometry provenance. Every px measurement in the entries is expressed in
  -- the coordinate system of a page rendered at THIS width; consumers scale
  -- by raster.width / template_render_width before use, the way
  -- scaledOptions() already handles pipeTrace DEFAULTS. Without this a
  -- vocabulary cut at 2400px silently mismatches a sheet rendered at 1400px.
  template_render_width INT NOT NULL DEFAULT 2400,
  -- Match thresholds, named rather than buried as literals: at/above accept
  -- the glyph is identified; between reject and accept we say a valve is
  -- there and refuse to say which kind; below reject there is no glyph and
  -- behavior is today's.
  accept REAL NOT NULL DEFAULT 0.62,
  reject REAL NOT NULL DEFAULT 0.45,

  -- Compile bookkeeping.
  segmenter TEXT,                          -- 'grid' | 'projection' | 'definition-list' | 'manual'
  model TEXT,
  provider TEXT,
  entry_count INT NOT NULL DEFAULT 0,
  candidate_cell_count INT NOT NULL DEFAULT 0,
  conflict_count INT NOT NULL DEFAULT 0,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,

  compiled_at TIMESTAMPTZ,
  compiled_by UUID,
  published_at TIMESTAMPTZ,
  published_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one ACTIVE vocabulary per (scope target, discipline). Two active
-- vocabularies for one discipline is not a conflict to resolve at read time,
-- it is a publish that should have been refused.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_vocabularies_active_library_idx
  ON knowledge_vocabularies (library_id, discipline)
  WHERE status = 'active' AND scope = 'library';
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_vocabularies_active_org_idx
  ON knowledge_vocabularies (org_id, discipline)
  WHERE status = 'active' AND scope = 'org';
CREATE INDEX IF NOT EXISTS knowledge_vocabularies_org_idx
  ON knowledge_vocabularies (org_id, status, discipline);

-- ── 2. Sources: which pages of which documents taught it ──────────────────
--
-- A join table rather than an FK on the vocabulary, because "LEGEND SHEET 1
-- OF 3" is routinely three separate files, sometimes living in a different
-- library than the drawings they govern. source_rev per row is what makes
-- "sheet 2 was revised, 1 and 3 were not" a partial recompile instead of a
-- full one.

CREATE TABLE IF NOT EXISTS knowledge_vocabulary_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  vocabulary_id UUID NOT NULL REFERENCES knowledge_vocabularies(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  pages INT[] NOT NULL DEFAULT '{}',       -- empty = the whole document
  -- The document's revision AT COMPILE TIME. A vocabulary compiled from rev
  -- B of a legend and used against rev D drawings is quietly wrong; this is
  -- what makes that detectable (see the staleness view below).
  source_rev TEXT,
  UNIQUE (vocabulary_id, document_id)
);
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_sources_doc_idx
  ON knowledge_vocabulary_sources (document_id);

-- ── 3. Bindings: which collections this vocabulary governs ────────────────
--
-- The cross-library case is the normal one: the legend lives in "Site
-- Standards" and governs the drawings in "Unit 20 P&IDs". Scope alone cannot
-- express that, so bindings are many-to-many with an explicit priority. The
-- workbench must show, per library, exactly which vocabulary wins and which
-- entries are shadowed — a binding graph with invisible resolution is a new
-- place to misconfigure things silently.

CREATE TABLE IF NOT EXISTS knowledge_vocabulary_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  vocabulary_id UUID NOT NULL REFERENCES knowledge_vocabularies(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  folder_id UUID,                          -- NULL = the whole library
  priority INT NOT NULL DEFAULT 0,         -- higher wins
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vocabulary_id, library_id, folder_id)
);
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_bindings_lib_idx
  ON knowledge_vocabulary_bindings (library_id, priority DESC);

-- ── 4. The entries — one row shape for every discipline ───────────────────
--
-- The load-bearing design decision: a SUPERSET table with honest NULLs, not
-- a drawing table with prose bolted on. The columns every collection uses
-- (kind, key, label, meaning, aliases, payload, embedding, provenance) are
-- the majority; `geometry` and `line_style` are optional payloads for the
-- drawing case and are NULL for every abbreviation, definition and schedule
-- row without anything downstream requiring them.
--
-- WHY GEOMETRY IS A COLUMN AND NOT DECORATION: the question is "I just ran
-- into a valve — is it a gate valve or a control valve?" That cannot be
-- answered from a name and a category; something has to compare what is on
-- the drawing to what the legend showed. A model saying "two triangles
-- meeting at a point" is a sentence. Port count, fill state, stroke census
-- and Hu moments are a lookup key. Every number in `geometry` and
-- `line_style` is MEASURED from the crop's own pixels — the model is never
-- asked for a coordinate or a length, which is the lesson pipeTrace.ts
-- already paid for.
--
-- NO ENTRY EXISTS WITHOUT A CROP. Every row is anchored to pixels on a real
-- page, which is what makes both hallucination-resistance and human review
-- possible: a reviewer confirms a legend by LOOKING, and an answer that
-- leaned on a row cites the legend page like any other source, so a bad
-- entry surfaces as a wrong citation rather than as invisible drift.

CREATE TABLE IF NOT EXISTS knowledge_vocabulary_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  vocabulary_id UUID NOT NULL REFERENCES knowledge_vocabularies(id) ON DELETE CASCADE,

  -- Mirrors knowledge_documents.reference_family: 'decode' | 'name' |
  -- 'enumerate'. This is what consumers branch on, because the three
  -- families have three different consumption paths (prompt injection at
  -- retrieval time / compiled into codecs / answered deterministically).
  family TEXT NOT NULL,
  -- Open TEXT, owned by the compiler. 'symbol' | 'line_style' | 'abbrev' |
  -- 'annotation' | 'tag_prefix' | 'device_code' | 'classification' |
  -- 'title_block_field' | 'index_row' | 'schedule_row' | 'boundary' |
  -- 'governing' | whatever a new discipline needs. NEVER a CHECK.
  kind TEXT NOT NULL,

  -- The normalized lookup key: 'FC', 'DASH-LONG', 'GATE VALVE', 'A1A',
  -- '025-PID-0107'. `normalized_key` is what every lookup and every
  -- duplicate check uses; storing it generated means the two can never drift.
  key TEXT NOT NULL,
  normalized_key TEXT GENERATED ALWAYS AS
    (upper(regexp_replace(btrim(key), '\s+', ' ', 'g'))) STORED,
  label TEXT,                              -- the legend's own words, verbatim
  meaning TEXT,                            -- the expansion / definition
  aliases TEXT[] NOT NULL DEFAULT '{}',    -- only alternates the tile itself prints
  code TEXT,                               -- ISA letters, device number, abbreviation
  category TEXT,                           -- 'valve' | 'instrument' | 'fitting' | …
  subcategory TEXT,                        -- 'gate' | 'globe' | 'control' | 'check'

  -- Kind-specific typed body. Examples:
  --   line_style: {"pattern":"dash","dashPx":[18,9],"weightPx":2,
  --                "double":false,"carries":"signal","traceable":false,
  --                "connectsTo":["process"]}
  --   symbol:     {"flow":"through","directional":false,
  --                "rotations":[0,90,180,270],"tagHint":"PSV-"}
  --   index_row:  {"identifier":"025-PID-0107","title":"…","sheetOf":"3 OF 8","rev":"C"}
  --   boundary:   {"fromRegime":"A1A","toRegime":"B2C","atIdentifier":"…"}
  --   governing:  {"governedScope":"piping","governingDoc":"B31.3",
  --                "amendments":["…"]}
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- MEASURED from the crop, no model involved. NULL for every text-domain
  -- entry and nothing downstream requires it.
  --   {"portCount":2,"ports":[{"nx":0,"ny":0.5,"dir":"W"},…],
  --    "outline":"triangle_pair","fill":"hollow","aspect":1.15,
  --    "strokes":{"h":3,"v":2,"diag":4},
  --    "circles":[{"cx":0.5,"cy":0.14,"r":0.18,"rule":"single_solid"}],
  --    "hasStem":true,"innerText":["FV"],"inkFraction":0.21,"hu":[…],
  --    "footprint":{"w":41,"h":22},"templateKey":"r2://…/mask.png"}
  -- Ports are found by walking the crop's border and recording where ink
  -- crosses it — deterministic, and exactly the distinction between a 2-port
  -- inline valve and a 3-port three-way. `hu` + the mask give a rotation- and
  -- scale-tolerant nearest-neighbour key, positioned as a candidate RANKER
  -- that returns top-k with scores, NEVER as a classifier that returns one
  -- answer.
  geometry JSONB,

  -- PRECEDENCE, resolved in lib/refVocabulary.ts, in this order:
  --   1. scope specificity: 'document' > 'set' > 'library' > 'org'
  --   2. a governing_authority entry naming a document as governing
  --   3. authority_rank (the admin's explicit override; resolving a conflict
  --      in the UI writes a bump here, so resolution is durable)
  --   4. effective_date (newer wins, reusing 20260819's machinery)
  --   5. library tier: GOVERNING beats REFERENCE, reusing the link semantics
  --      the ask route already implements so the two precedence systems agree
  --      instead of competing
  --   6. nothing left -> a CONFLICT row: both values retained, neither used
  --      silently. Injected into the prompt as an explicit ambiguity note,
  --      and it BLOCKS the tracer consumer (a contradictory line_key means
  --      the tracer falls back to self-detection rather than coin-flipping).
  scope TEXT NOT NULL DEFAULT 'library',   -- 'org'|'library'|'set'|'document'
  scope_ref TEXT,
  authority_rank INT NOT NULL DEFAULT 0,
  effective_date DATE,

  -- PROVENANCE — required, not optional.
  source_document_id UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  page INT,
  bbox JSONB,                              -- {x,y,w,h} normalized 0..1
  crop_key TEXT,                           -- R2 object key of the cell crop
  raw TEXT,                                -- the printed text exactly as read

  -- TRUST. `confidence` is a weighted mean; `confidence_parts` stores each
  -- term WITH ITS EVIDENCE so a doubtful row explains itself instead of
  -- being a mystery number:
  --   {"segmentation":{"v":0.95,"why":"ruled cell, clean borders"},
  --    "pairing":{"v":1.00,"why":"symbol and label in same cell"},
  --    "textAgreement":{"v":0.42,"why":"text layer 'GATE VALVE' vs model 'GATE VAWE'"},
  --    "model":{"v":0.90,"why":"self-reported","cap":0.70},
  --    "geometry":{"v":0.80,"why":"2 ports, hollow — consistent with 'valve'"}}
  -- The model's self-report is CAPPED so no row is high-confidence on the
  -- model's own say-so alone. Hard flags force a row to red regardless of
  -- score — flags are not averaged away.
  confidence REAL,
  confidence_parts JSONB NOT NULL DEFAULT '{}'::jsonb,
  flags TEXT[] NOT NULL DEFAULT '{}',      -- duplicate_name|illegible|ambiguous_pairing|…
  pair_method TEXT,                        -- 'cell' | 'proximity' | 'vision'
  -- Anything else worth keeping for review or for the learning loop —
  -- including {"modelSaid":…,"humanSaid":…} written when a reviewer corrects
  -- a row. The top corrections for an org are rendered into the next
  -- compile's system prompt as a site glossary ("this site calls this a BLOCK
  -- VALVE, not a GATE VALVE"), so the second compile is visibly better than
  -- the first. That is why there is no separate corrections table.
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- REVIEW STATE OVERRIDES CONFIDENCE FOR CONSUMERS. A confirmed or
  -- corrected entry is used at full weight and never hedged. An unreviewed
  -- entry below the red threshold is excluded from prompt injection and from
  -- glyph matching entirely. So a freshly compiled, unreviewed vocabulary is
  -- USEFUL but conservative and gets sharper as review proceeds, rather than
  -- being all-or-nothing on publish.
  --
  -- GRADUATED TRUST BY CONSEQUENCE (enforced in code, recorded here):
  -- low-consequence kinds (abbrev, index_row) auto-accept above threshold;
  -- high-consequence kinds — line_style (drives the tracer), boundary,
  -- classification, governing (drives precedence itself) — stay 'proposed'
  -- until a human accepts them, in the same accept/reject surface diffImport
  -- already established for the codebook. Proposed entries are visible in
  -- settings and influence nothing.
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|accepted|rejected|retracted
  review_state TEXT NOT NULL DEFAULT 'unreviewed', -- unreviewed|confirmed|corrected|rejected
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  -- 'ai' | 'manual' | 'promoted' (from a coverage gap) | 'seed' (shipped
  -- starter vocabulary) | 'import'. A 'manual' entry or a 'corrected' one is
  -- NEVER overwritten by a recompile — it appears in the diff as a conflict
  -- the reviewer resolves. applyImport already holds this line for the
  -- codebook; it holds here identically.
  origin TEXT NOT NULL DEFAULT 'ai',
  -- Revision carry-forward: set when diffVocabulary matched this row to an
  -- entry in the superseded vocabulary, so a Rev D that changed the title
  -- block requires reviewing ZERO entries.
  carried_from_entry_id UUID,
  replaced_by_entry_id UUID,

  -- "Do we have a symbol for anything that isolates flow" — same pattern as
  -- knowledge_chunks (20260930): 1024 dims, provider recorded per row,
  -- because vectors from different providers are not comparable.
  embedding vector(1024),
  embedding_model TEXT,

  seq INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live definition per (vocabulary, kind, key, scope). Rejected and
-- retracted rows are RETAINED — nothing here is ever destructive, so an
-- answer logged under an old compilation stays explainable — but they do not
-- compete for the key.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_vocabulary_entries_key_idx
  ON knowledge_vocabulary_entries
     (vocabulary_id, kind, normalized_key, scope, coalesce(scope_ref, ''))
  WHERE status IN ('proposed', 'accepted');

-- The resolver's hot path: "what does this token mean, here, right now".
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_entries_lookup_idx
  ON knowledge_vocabulary_entries (org_id, kind, normalized_key)
  WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_entries_vocab_idx
  ON knowledge_vocabulary_entries (vocabulary_id, family, kind, seq);
-- The review queue: red band and flagged rows first.
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_entries_review_idx
  ON knowledge_vocabulary_entries (vocabulary_id, review_state, confidence);
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_entries_doc_idx
  ON knowledge_vocabulary_entries (source_document_id, page);
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_entries_embedding_idx
  ON knowledge_vocabulary_entries USING hnsw (embedding vector_cosine_ops);

-- ── 5. Coverage gaps: what the drawings use that the legend never defined ──
--
-- Two failure modes bracket this design. Day one a library has no compiled
-- vocabulary and the feature does nothing. Forever after, real drawing sets
-- use symbols and abbreviations their legend never defined — site
-- conventions, vendor symbols, things added after the legend was last
-- revised in 2011 — so a vocabulary that only ever reflects the legend sheet
-- drifts out of contact with the drawings it is supposed to explain.
--
-- Coverage itself is COMPUTED, not stored: join accepted entries against
-- knowledge_page_entities, no AI call. This table stores only what a join
-- cannot recover — the occurrence rollup that keeps the panel cheap, and the
-- human's dismissal ("not a tag"), which must survive the next re-index.
--
-- Written from three sources that already run: the vision page reader (asked
-- to list what it saw that the injected block does NOT define), the ask route
-- (buildEquipmentCensus already computes unknownPrefixes and tells the user
-- "you need the site's tag legend" — that signal currently evaporates), and
-- classifyLine() returning null for a measured dash pattern matching nothing.
--
-- definedAndUnused matters just as much: it is how you notice you compiled
-- the wrong legend revision.

CREATE TABLE IF NOT EXISTS knowledge_vocabulary_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  vocabulary_id UUID REFERENCES knowledge_vocabularies(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                      -- 'symbol' | 'abbrev' | 'line_style' | 'tag_prefix'
  term TEXT NOT NULL,
  normalized_term TEXT GENERATED ALWAYS AS
    (upper(regexp_replace(btrim(term), '\s+', ' ', 'g'))) STORED,
  occurrences INT NOT NULL DEFAULT 1,
  first_seen_document_id UUID REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  first_seen_page INT,
  crop_key TEXT,
  -- 'open' | 'defined' (promoted into an entry) | 'ignored' (a controller
  -- said this is not a real term — never re-suggested). Expect a noisy
  -- queue: models are poor at reporting their own ignorance and will both
  -- over- and under-report, so 'ignored' is meant to be used liberally.
  status TEXT NOT NULL DEFAULT 'open',
  dismissed_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (library_id, kind, normalized_term)
);
CREATE INDEX IF NOT EXISTS knowledge_vocabulary_gaps_open_idx
  ON knowledge_vocabulary_gaps (library_id, status, occurrences DESC);

-- ── 6. Staleness, computed rather than triggered ──────────────────────────
--
-- A vocabulary compiled from rev B of a legend and used against rev D
-- drawings is quietly wrong. A trigger on knowledge_documents would write-
-- amplify every sync; a view is always correct and costs nothing until read.
-- The UI surfaces it beside the Recompile button; the resolver refuses to
-- feed a stale vocabulary to the TRACER (which acts on it) while still
-- allowing prompt injection (which cites it, so a reader can see the age).

CREATE OR REPLACE VIEW knowledge_vocabulary_staleness AS
  SELECT v.id            AS vocabulary_id,
         v.org_id,
         v.library_id,
         v.status,
         bool_or(s.source_rev IS DISTINCT FROM d.source_rev) AS source_revised,
         bool_or(d.status = 'stale')                          AS source_stale,
         bool_or(d.reference_family = 'content')              AS role_cleared,
         max(d.created_at)                                    AS newest_source_at
    FROM knowledge_vocabularies v
    JOIN knowledge_vocabulary_sources s ON s.vocabulary_id = v.id
    JOIN knowledge_documents d          ON d.id = s.document_id
   GROUP BY v.id, v.org_id, v.library_id, v.status;

-- ── 7. Consumers record which vocabulary they acted under ─────────────────
--
-- A trace and a named symbol are DERIVED data. If they cannot say which
-- revision named them, a legend revision either invalidates everything
-- (pure waste — a stale trace is still a useful picture) or invalidates
-- nothing (stale component names on screen). Recording the revision is what
-- makes "traced under Legend Rev C (superseded)" possible.

ALTER TABLE knowledge_line_traces
  ADD COLUMN IF NOT EXISTS vocabulary_id UUID
    REFERENCES knowledge_vocabularies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vocabulary_revision INT,
  -- The stroke class the route travelled, in the legend's own words. Lets
  -- the viewer say "followed the 6\" process line" rather than just drawing a
  -- stroke — and, more importantly, say "this route changes from process
  -- line to instrument signal at 0.42, 0.61; that is probably not one line".
  ADD COLUMN IF NOT EXISTS style_meaning TEXT,
  -- The derived AnnotatedRoute: what the line passes through, in the
  -- legend's own words, produced by walking the chosen A* chain. DERIVED,
  -- never generated — a different truth class from anything the vision
  -- fallback produces, and the UI must say so. Served only when
  -- vocabulary_revision matches the library's active vocabulary; otherwise
  -- points are served and route is re-derived.
  ADD COLUMN IF NOT EXISTS route JSONB;

-- Symbol instances named at ingest point back at the legend cell that named
-- them. kind='symbol' rows need no migration — 20260925 dropped the CHECK
-- for exactly this — but a row asserting "control valve" must cite its
-- source, or a wrong vocabulary entry becomes invisible drift instead of a
-- wrong citation.
ALTER TABLE knowledge_page_entities
  ADD COLUMN IF NOT EXISTS vocabulary_entry_id UUID
    REFERENCES knowledge_vocabulary_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confidence REAL;

-- ── 8. RLS: service-role only, like the rest of the derived layer ─────────
ALTER TABLE knowledge_vocabularies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_vocabulary_sources    ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_vocabulary_bindings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_vocabulary_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_vocabulary_gaps       ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON knowledge_vocabularies        FROM public, anon, authenticated;
REVOKE ALL ON knowledge_vocabulary_sources  FROM public, anon, authenticated;
REVOKE ALL ON knowledge_vocabulary_bindings FROM public, anon, authenticated;
REVOKE ALL ON knowledge_vocabulary_entries  FROM public, anon, authenticated;
REVOKE ALL ON knowledge_vocabulary_gaps     FROM public, anon, authenticated;
REVOKE ALL ON knowledge_vocabulary_staleness FROM public, anon, authenticated;
