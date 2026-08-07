-- 20261010_library_profile_roles.sql
--
-- WHAT A LIBRARY IS FOR, and WHAT EACH DOCUMENT IS TO THE OTHERS.
--
-- Two facts the app currently has nowhere to put:
--
--   1. INTENDED USE. createKnowledgeLibrary() takes name + description and
--      nothing else, so every behavioral decision (vision-all-pages, deep
--      read, clarify, decoder, legend pins) is deferred to a settings modal
--      the owner has to know to open AFTER uploading. The one setting that
--      mattered for a drawing set was reachable only by someone who already
--      knew the failure mode. Ask at the moment the owner has the most
--      context — when they are deciding what this shelf IS.
--
--   2. REFERENCE ROLE. "This is the legend" is expressed today as two
--      independent arrays of ids — ai_features.legendDocIds (per library,
--      capped at 3) and codebook_config.legend_doc_ids (org-wide) — which
--      the ask route concatenates, truncates to 3, slices to 6000 characters
--      and pastes into the prompt. Four defects: it can only express ONE
--      kind of reference; the cap is arbitrary; a document cannot say what
--      it is (only a library can say what it thinks of the document, so the
--      same PDF mirrored twice is a legend in one place and invisible in the
--      other); and nothing downstream of the prompt can consult it, because
--      it is a list of ids with no declared meaning. Ingest, the vision
--      reader and the tracer cannot see ai_features at all.
--
-- THE SPLIT THIS MIGRATION ENCODES: use is ASKED, kind is DETECTED. At
-- creation the app knows nothing about content and the owner knows only
-- intent, so ask exactly what cannot be inferred and detect exactly what
-- can. `profile.asked` is three answers; `profile.kinds` is a detected
-- rollup the owner confirms after the first ingest batch.
--
-- THE RATCHET, which the schema is shaped to make true: every setting here
-- is a PRIOR that adds behavior or reorders results. Nothing in this
-- migration can remove a document from the index or from search — the only
-- things that ever do that are ACLs and explicit exclusion, both already
-- visible to the owner. A library mis-profiled as standards but full of
-- P&IDs is UNDER-extracted, never un-indexed, and correcting the profile
-- later ADDS the entity layer rather than repairing a hole.
--
-- NO CHECK CONSTRAINTS on role / family / kind. 20260925 paid for that
-- lesson in full: a database allowlist over an enum the ingest code owns
-- fails whole 500-row insert batches the day the code learns a new value.
-- These are code-owned vocabularies; they are validated in TypeScript.
--
-- Additive + idempotent. Apply after 20261009.

-- ── 1. Library profile ────────────────────────────────────────────────────
--
-- Deliberately its OWN column rather than a key inside ai_features.
-- ai_features is what its comment says it is — additive feature checkboxes,
-- read key-by-key and rewritten wholesale by saveLibraryAiFeatures(). The
-- profile is a different class of object: versioned, ledgered, and split
-- into derived-vs-overridden so "reset to derived" is deleting a key rather
-- than diagnosing history. Sharing one blob would mean every checkbox save
-- races the profile writer and every ledger diff reaches through unrelated
-- state.

ALTER TABLE knowledge_libraries
  ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN knowledge_libraries.profile IS
$$Library purpose + derived configuration. {} = unprofiled, and an unprofiled
library behaves EXACTLY as it did before this migration.

{
  "version": 2,

  -- ASKED at creation, three one-click radio rows, all with defaults, all
  -- editable forever in the same Library AI setup modal. Nothing else is
  -- asked: see the refusal rule below.
  "asked": {
    "use":       "find-a-fact" | "trace-and-audit" | "compile-a-package"
               | "compare-and-comply" | "teach-and-onboard",   -- default find-a-fact
    "audience":  "field" | "engineering" | "both",             -- default engineering
    "authority": "governing" | "reference" | "record"          -- default governing
  },

  -- DETECTED after the first ingest batch and rolled up; `confirmed` flips
  -- when the owner accepts the strip on the library page. Never asked at
  -- creation, because no documents exist then and a mixed 400-sheet set
  -- cannot be classified by hand anyway.
  "kinds": [
    { "kind": "pid", "docs": 38, "share": 0.86,
      "source": "detected" | "set-by-user", "confirmed": true }
  ],

  -- What the kind-defaults table in lib/libraryProfile.ts resolved to for
  -- this library, written down so it is inspectable and diffable rather
  -- than recomputed silently at read time.
  "derived": {
    "visionAllPages": true, "chunkShape": "sheet",
    "extractors": ["entities", "titleBlock", "opc", "symbols"],
    "retrievalBias": "entity", "answerTemplate": "trace-and-audit",
    "clarifyFacets": false
  },

  -- ONLY what a human actually changed. Every key present here is badged
  -- "you changed this" in the UI and carries a per-field reset that deletes
  -- the key. Absent key = inherit.
  "overrides": {},

  -- Derived from (kinds x asked.use): the reference roles a collection like
  -- this normally carries. Drives the dismissable References card.
  -- rolesDeclaredNone is a FIRST-CLASS answer: "this set has no legend" is
  -- useful, stops the nag, and is worth an answer stating it.
  "expectedRoles": ["symbol_key", "line_key", "sheet_index"],
  "rolesDeclaredNone": false,

  "detectorVersion": 1,
  "derivedAt": "2026-10-10T00:00:00Z",
  -- Set when the owner dismissed a drift strip; the mismatch stays visible
  -- in settings (greyed) but never nags again.
  "driftDismissedAt": null
}

RESOLUTION ORDER for any behavior knob, implemented once in
lib/libraryProfile.ts and read (never re-decided) by lib/knowledgeIngest.ts
and app/api/knowledge/ask/route.ts:

  knowledge_documents.doc_profile.overrides   (per document)
    -> knowledge_libraries.profile.overrides  (owner changed it here)
    -> knowledge_libraries.ai_features        (LEGACY explicit checkboxes —
                                               above derived on purpose, so
                                               no library changes behavior on
                                               migration day)
    -> knowledge_libraries.profile.derived    (from the kind defaults table)
    -> kind defaults                          (literal table, reviewable on
                                               one screen)
    -> global baseline                        (today's behavior)

WHAT IS DELIBERATELY NOT ASKED, and why — the refusal rule is "ask only what
the owner knows better than the app AND that changes behavior AND that cannot
be corrected later from evidence":
  scanned-vs-digital / text layer   -> detected PER PAGE (pageNeedsVision);
                                       it varies inside one PDF
  discipline / drawing type         -> detected from the title block and the
                                       Site Codebook drawing_type codes
  chunk size, overlap, embedding
    model, retrieval mode, threshold-> never. Consequences, not preferences
  "which document is the legend"    -> unanswerable at create; proposed from
                                       detection after upload
  tag / drawing-number scheme       -> already org-level in the Site Codebook
  metric vs imperial                -> both appear in one document; units are
                                       echoed as printed, always
  "enable semantic search"          -> a function of whether an embedding key
                                       exists, which the app knows
  who may see this                  -> the ACL and knowledge-source machinery
                                       owns it; re-asking creates two truths
  accuracy vs cost                  -> show the concrete price at the concrete
                                       decision instead
$$;

-- ── 2. Document reference role ────────────────────────────────────────────
--
-- Columns on knowledge_documents, not a side table. A document has exactly
-- one primary role, so a 1:1 join buys nothing; ingest, sync and the document
-- list already SELECT this table, so the fact travels for free; and the
-- established convention for per-document derived facts here is a column
-- (vision_pages, last_section, source_rev, pages_indexed).
--
-- FAMILY is what consumers branch on — three genuinely different consumption
-- paths, which is why it is stored separately from the specific role:
--
--   'decode'    mark -> meaning.   Consumed by the vision reader (names
--               glyphs at ingest), the tracer (line semantics), and
--               retrieval-time injection into the ask prompt.
--               roles: symbol_key, line_key, abbreviation_list,
--                      notation_convention, title_block_standard
--
--   'name'      string -> structure. Compiled into CODECS, never injected as
--               prose. identifier_scheme routes through the existing Site
--               Codebook diffImport/applyImport review — there is no second
--               identifier store.
--               roles: identifier_scheme, classification_map
--
--   'enumerate' authoritative rows. Compiled into queryable rows and answered
--               DETERMINISTICALLY, the way equipmentTable already is.
--               roles: sheet_index, enumeration_schedule, boundary_table,
--                      governing_authority
--
--   'content'   the default. Byte-for-byte today's behavior.
--
-- A ROLE NEVER REMOVES A DOCUMENT FROM RETRIEVAL. A legend is schema AND
-- content: "what does the dashed line mean" must still be answerable with a
-- citation to the legend page. Roles add a consumption path; they never take
-- one away. There is deliberately no 'excluded' or 'superseded' role —
-- supersession is knowledge_documents.status and the effective-date
-- machinery (20260819), and conflating them would let a role silently
-- delete a document from search.

ALTER TABLE knowledge_documents
  -- 'content' | 'decode' | 'name' | 'enumerate'. Open TEXT (see 20260925).
  ADD COLUMN IF NOT EXISTS reference_family TEXT NOT NULL DEFAULT 'content',
  -- The specific role within the family, or NULL for "family only / auto".
  ADD COLUMN IF NOT EXISTS reference_role TEXT,
  -- Real legend sheets are compound: one page is routinely symbol_key AND
  -- line_key AND abbreviation_list AND notation_convention. Forcing a single
  -- choice is how a taxonomy gets rejected by the people using it.
  ADD COLUMN IF NOT EXISTS reference_roles_secondary TEXT[] NOT NULL DEFAULT '{}',
  -- How far this reference governs: 'org' | 'library' | 'set' | 'document'.
  -- A vendor manual's own symbol conventions are 'document' scope and beat
  -- the site legend INSIDE that manual. A symbol sheet governing only one
  -- package is 'set' with role_scope_ref = a drawing-number prefix.
  ADD COLUMN IF NOT EXISTS role_scope TEXT NOT NULL DEFAULT 'library',
  ADD COLUMN IF NOT EXISTS role_scope_ref TEXT,
  -- Manual tiebreak, rung 3 of the precedence ladder. Resolving a conflict
  -- in the UI writes a bump here, so resolution is a durable act rather than
  -- a per-question decision.
  ADD COLUMN IF NOT EXISTS role_authority INT NOT NULL DEFAULT 0,
  -- 'user' | 'suggested' | 'migrated' | 'inherited'. 'inherited' is what the
  -- knowledge-source sync writes when it carries a role forward onto the new
  -- knowledge_documents row for a revised controlled document — without that
  -- carry-forward, every re-mirror silently demotes a legend to content.
  ADD COLUMN IF NOT EXISTS role_source TEXT,
  ADD COLUMN IF NOT EXISTS role_set_by UUID,
  ADD COLUMN IF NOT EXISTS role_set_at TIMESTAMPTZ,
  -- Per-document detection evidence + override. This is the drift loop's
  -- storage and it costs nothing: ingestion already computes every number in
  -- it. Written at the end of each ingest batch.
  --   { "kind": "pid", "kindSource": "detected"|"set-by-user",
  --     "confidence": 0.91,
  --     "signals": { "charsPerPage": 180, "tagsPerPage": 46, "refsPerPage": 6,
  --                  "titleBlock": true, "stepDensity": 0, "clauseDensity": 0,
  --                  "tableDensity": 0.1, "formFieldDensity": 0,
  --                  "textlessRatio": 0.95 },
  --     "overrides": { "visionAllPages": true } }
  ADD COLUMN IF NOT EXISTS doc_profile JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Every consumer asks the same question: "what are the reference documents
-- for this library / this org, and in what order do they win".
CREATE INDEX IF NOT EXISTS knowledge_documents_role_idx
  ON knowledge_documents (library_id, reference_family, role_authority DESC)
  WHERE reference_family <> 'content';

CREATE INDEX IF NOT EXISTS knowledge_documents_role_org_idx
  ON knowledge_documents (org_id, reference_role)
  WHERE reference_role IS NOT NULL;

-- Role carry-forward on re-mirror needs to find the previous revision's row.
CREATE INDEX IF NOT EXISTS knowledge_documents_source_doc_idx
  ON knowledge_documents (org_id, source_document_id)
  WHERE source_document_id IS NOT NULL;

-- ── 3. Backfill: both legend pin-lists become declared roles ──────────────
--
-- Every id in ai_features.legendDocIds becomes a library-scope symbol_key;
-- every id in codebook_config.legend_doc_ids becomes an org-scope one. Both
-- read paths keep working for one release (lib/knowledge.ts keeps
-- legendDocIds as a deprecated read-only field, the ask route keeps reading
-- it), then both columns are dropped in a later migration. Nothing here
-- changes an answer on the day it is applied.
--
-- Guarded: pre-20260918 / pre-20260928 workspaces have no such columns.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'knowledge_libraries' AND column_name = 'ai_features'
  ) THEN
    UPDATE knowledge_documents d
       SET reference_family = 'decode',
           reference_role   = 'symbol_key',
           role_scope       = 'library',
           role_source      = 'migrated',
           role_set_at      = now()
      FROM knowledge_libraries l
     WHERE l.id = d.library_id
       AND d.reference_family = 'content'
       AND jsonb_typeof(l.ai_features -> 'legendDocIds') = 'array'
       AND d.id::text IN (
         SELECT jsonb_array_elements_text(l.ai_features -> 'legendDocIds')
       );
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'codebook_config'
  ) THEN
    UPDATE knowledge_documents d
       SET reference_family = 'decode',
           reference_role   = 'symbol_key',
           role_scope       = 'org',
           role_source      = 'migrated',
           role_set_at      = now()
      FROM codebook_config c
     WHERE c.org_id = d.org_id
       AND d.reference_family = 'content'
       AND jsonb_typeof(c.legend_doc_ids) = 'array'
       AND d.id::text IN (
         SELECT jsonb_array_elements_text(c.legend_doc_ids)
       );
  END IF;
END $$;

-- ── 4. The change ledger ──────────────────────────────────────────────────
--
-- "Editable later" is only true if the owner can find the setting, see what
-- changing it does, undo a change without knowing which one it was, and see
-- the cost before committing. This table is READ BY THE UI — it powers the
-- "you changed this" badges and the per-field reset — so it cannot silently
-- rot into a write-only audit log without a visible symptom.
--
-- The create-time answers are the FIRST ledger entry, not privileged fields.
-- There is no write-once state anywhere in this model.
--
-- It is NOT audit_logs: this records what RE-RAN and what it COST, which the
-- generic audit trail has no place for, and it is queried per library on
-- every settings open.

CREATE TABLE IF NOT EXISTS knowledge_profile_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID NOT NULL REFERENCES knowledge_libraries(id) ON DELETE CASCADE,
  -- NULL = a library-level change; set = a per-document override.
  document_id UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  -- Dotted path into the object that changed: 'asked.use', 'overrides.chunkShape',
  -- 'reference_role', 'kinds'.
  field TEXT NOT NULL,
  before_value JSONB,
  after_value JSONB,
  -- 'create' | 'edit' | 'reset-to-derived' | 'accept-detection' |
  -- 'dismiss-drift' | 'apply-suggestion'
  action TEXT NOT NULL DEFAULT 'edit',
  -- What the change actually cost, recorded AFTER the work ran so the next
  -- cost preview can quote real numbers instead of an estimate:
  --   { "reran": "none" | "rescan-chunks" | "rechunk-reembed" | "revision",
  --     "documents": 3, "pages": 412, "seconds": 340, "usd": 0.41 }
  -- "none" is the common case and must stay cheap to record: use / audience /
  -- authority / answer shape / retrieval weights re-run NOTHING and take
  -- effect on the next question.
  effect JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID,
  changed_by_name TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_profile_history_lib_idx
  ON knowledge_profile_history (library_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_profile_history_field_idx
  ON knowledge_profile_history (library_id, field, changed_at DESC);

ALTER TABLE knowledge_profile_history ENABLE ROW LEVEL SECURITY;

-- Members read it (it powers the badges every member sees on the settings
-- screen). Writes happen server-side through the service role on save, the
-- same posture as knowledge_questions.
DROP POLICY IF EXISTS knowledge_profile_history_select ON knowledge_profile_history;
CREATE POLICY knowledge_profile_history_select ON knowledge_profile_history FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = knowledge_profile_history.org_id
          AND uid = auth.uid() AND status = 'active')
);
