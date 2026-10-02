-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-11) — every document↔equipment link says who
-- asserted it and which revision it was read from; the Bridge's ledger
-- remembers what people rejected and which indexed copies it read; two
-- unindexed JSONB lookups get their indexes.
--
-- What this file changes:
--   1. GAP-303 — provenance on document_assets, before the Bridge writes its
--      first row (99-fix-sequencing Phase 2: a source column retrofitted onto
--      rows already written is a backfill that cannot recover what it did
--      not record):
--        asserted_by       'machine' | 'human' (NOT NULL, default 'human' —
--                          every row before this file was typed by a person:
--                          documents.asset_tags, or a manual link)
--        asserted_by_user  the person, when a person asserted it
--        model             the AI model that transcribed the page the tag was
--                          read from (NULL: the PDF's own text layer)
--        source_revision   the controlled document's revision label it was
--                          read from (knowledge_documents.source_rev)
--        source_version_id the revision row (knowledge_documents.source_version_id)
--      A 'drawing' row is always 'machine' (CHECK, NOT VALID and validated
--      once the backfill below leaves nothing to violate — two worlds,
--      DEC-30). A PERSON's insert or update is stamped by the database
--      (document_assets_stamp_assertion, BEFORE INSERT OR UPDATE): 'human',
--      their uid, no model, no revision — a person can never write a row
--      that says a machine read it. The service role (the Bridge, the org
--      restore) writes provenance as given, so it survives export and
--      restore (the table is in lib/exportTables.ts and lib/dataRestore.ts);
--      a 'drawing' row it restores without asserted_by (an export taken
--      before this file) lands 'machine'. Not SECURITY DEFINER: it only
--      stamps NEW. search_path pinned.
--   2. GAP-309 — revision truth on the relation: vanished_at (the tag is no
--      longer read on the document's current indexed revision — a reviewable
--      delta, never a deletion: an extraction miss and a real removal look
--      the same) and superseded_at (the revision the row was read from is no
--      longer the document's current one). Both written by the Bridge only;
--      a person clears them through its review actions, each recorded in
--      audit_logs (a correction is a row, never an overwrite of the machine
--      row's provenance). presence_confirmed_on is the revision
--      (source_version_id) on which a person answered "It is still there":
--      the Bridge does not mark that row vanished again on that revision
--      (a later revision may). Written by the service role on the person's
--      recorded decision.
--   3. BR-9 / BR-5 / BR-14 — document_equipment_suggestions.dismissed (the
--      tags a person rejected, with who, when and on which revision — never
--      re-applied; re-proposed only when a later revision brings the tag
--      back after it had left the sheet) and .sources (which knowledge
--      documents the proposal was computed from, their revision and whether
--      they were complete). Written by the service role and controllers only
--      (20261128's policy, unchanged).
--   4. WIRE-8 — GIN (jsonb_path_ops) on transmittals.items, which the
--      inspector's "which transmittals carried this document" reads with
--      @> on every open; GIN (jsonb_path_ops) on tickets.metadata; and the
--      expression the impact scan actually filters on
--      (metadata->'source_document'->>'id', lib/impact.ts) as a b-tree.
--
-- WIDENS nothing; NARROWS nothing a person could do before (a person could
-- not write these columns: they did not exist). The app keeps working while
-- this is unpasted: the Bridge writes its rows without the provenance columns
-- (it retries without them on a missing column and says so), dismissals are
-- held in the proposal row's `applied` list as before, and readers treat a
-- missing column as "not recorded".
--
-- Requires 20260609 (document_assets), 20260928 (document_equipment_
-- suggestions), 20260717 (transmittals). Paste order: AFTER 20261170 (the
-- vocabulary this file's CHECK names; pasted alone it still applies — the
-- CHECK holds trivially while no row says 'drawing'). Deploy order: the app
-- may deploy before or after. Pre-apply inventory (DEC-30) is a TEMP TABLE
-- captured before the transaction, aggregate counts only; the only rows
-- rewritten are 'drawing' rows stamped 'machine' (counted below). Single
-- paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check text, ok boolean,
-- n text). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g71_before AS
SELECT 'document_assets rows (each becomes asserted_by human, except drawing rows)' AS what, COUNT(*) AS n FROM document_assets
UNION ALL
SELECT 'document_assets rows written by the Bridge (drawing — stamped asserted_by machine)', COUNT(*) FROM document_assets WHERE source = 'drawing'
UNION ALL
SELECT 'document_equipment_suggestions rows (dismissed and sources start empty; the next sweep fills sources)', COUNT(*) FROM document_equipment_suggestions
UNION ALL
SELECT 'transmittals (GIN on items)', COUNT(*) FROM transmittals
UNION ALL
SELECT 'tickets raised from a document (metadata.source_document — indexed by id)', COUNT(*) FROM tickets WHERE metadata ? 'source_document';

BEGIN;

-- ── 1. GAP-303: who asserted a link, and which revision it was read from ──
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS asserted_by TEXT NOT NULL DEFAULT 'human';
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS asserted_by_user UUID;
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS source_revision TEXT;
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS source_version_id UUID;
-- ── 2. GAP-309: revision truth ─────────────────────────────────────────────
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS vanished_at TIMESTAMPTZ;
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS presence_confirmed_on UUID;

ALTER TABLE document_assets DROP CONSTRAINT IF EXISTS document_assets_asserted_by_check;
ALTER TABLE document_assets ADD CONSTRAINT document_assets_asserted_by_check
  CHECK (asserted_by IN ('machine', 'human'));

-- A drawing row is a machine's reading (the backfill first, then the rule).
UPDATE document_assets SET asserted_by = 'machine' WHERE source = 'drawing' AND asserted_by <> 'machine';
ALTER TABLE document_assets DROP CONSTRAINT IF EXISTS document_assets_drawing_is_machine;
ALTER TABLE document_assets ADD CONSTRAINT document_assets_drawing_is_machine
  CHECK (source <> 'drawing' OR asserted_by = 'machine') NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document_assets WHERE source = 'drawing' AND asserted_by <> 'machine') THEN
    ALTER TABLE document_assets VALIDATE CONSTRAINT document_assets_drawing_is_machine;
  END IF;
END $$;

-- A person's write is a person's assertion — stamped by the database.
CREATE OR REPLACE FUNCTION document_assets_stamp_assertion()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- The service role (the Bridge, the org restore) records provenance as
  -- given; RLS already keeps a person off 'drawing' rows (20261170). A
  -- 'drawing' row restored from an export taken before this file carries no
  -- asserted_by: it is a machine's reading, so it lands as one.
  IF auth.uid() IS NULL THEN
    IF NEW.source = 'drawing' THEN NEW.asserted_by := 'machine'; END IF;
    RETURN NEW;
  END IF;
  NEW.asserted_by := 'human';
  NEW.asserted_by_user := auth.uid();
  NEW.model := NULL;
  NEW.source_revision := NULL;
  NEW.source_version_id := NULL;
  NEW.vanished_at := NULL;
  NEW.superseded_at := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_assets_stamp_assertion ON document_assets;
CREATE TRIGGER trg_document_assets_stamp_assertion
  BEFORE INSERT OR UPDATE ON document_assets
  FOR EACH ROW EXECUTE FUNCTION document_assets_stamp_assertion();

-- ── 3. BR-9 / BR-5 / BR-14: the ledger remembers ───────────────────────────
ALTER TABLE document_equipment_suggestions ADD COLUMN IF NOT EXISTS dismissed JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE document_equipment_suggestions ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── 4. WIRE-8: the two JSONB lookups, indexed ──────────────────────────────
CREATE INDEX IF NOT EXISTS transmittals_items_path_gin ON transmittals USING GIN (items jsonb_path_ops);
CREATE INDEX IF NOT EXISTS tickets_metadata_path_gin ON tickets USING GIN (metadata jsonb_path_ops);
CREATE INDEX IF NOT EXISTS tickets_source_document_id_idx ON tickets ((metadata -> 'source_document' ->> 'id'));

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'document_assets carries provenance: asserted_by (NOT NULL), asserted_by_user, model, source_revision, source_version_id (GAP-303)' AS "check",
       (SELECT COUNT(*) = 5 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'document_assets'
           AND column_name IN ('asserted_by', 'asserted_by_user', 'model', 'source_revision', 'source_version_id'))
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'document_assets'
                      AND column_name = 'asserted_by' AND is_nullable = 'NO') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'document_assets carries revision truth: vanished_at, superseded_at, presence_confirmed_on (GAP-309)',
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'document_assets'
           AND column_name IN ('vanished_at', 'superseded_at', 'presence_confirmed_on')),
       NULL
UNION ALL
SELECT 'asserted_by is machine or human; a drawing row is always machine (validated)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.document_assets'::regclass AND conname = 'document_assets_asserted_by_check'
                  AND pg_get_constraintdef(oid) LIKE '%machine%' AND pg_get_constraintdef(oid) LIKE '%human%')
       AND EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.document_assets'::regclass AND conname = 'document_assets_drawing_is_machine'
                      AND convalidated),
       NULL
UNION ALL
SELECT 'a person''s write is stamped human with their uid, no model, no revision (trigger bound; not SECURITY DEFINER; search_path pinned)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_assets_stamp_assertion'
                 AND tgrelid = 'public.document_assets'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN%'
               AND prosrc LIKE '%IF NEW.source = ''drawing'' THEN NEW.asserted_by := ''machine''; END IF;%'
               AND prosrc LIKE '%NEW.asserted_by := ''human'';%'
               AND prosrc LIKE '%NEW.asserted_by_user := auth.uid();%'
               AND prosrc LIKE '%NEW.model := NULL;%'
               AND NOT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'document_assets_stamp_assertion'),
       NULL
UNION ALL
SELECT 'document_equipment_suggestions.dismissed and .sources exist (BR-9 / BR-14)',
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'document_equipment_suggestions'
           AND column_name IN ('dismissed', 'sources') AND is_nullable = 'NO'),
       NULL
UNION ALL
SELECT 'WIRE-8: GIN (jsonb_path_ops) on transmittals.items and tickets.metadata; b-tree on tickets metadata->source_document->>id',
       EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'transmittals' AND indexname = 'transmittals_items_path_gin'
                 AND indexdef LIKE '%USING gin%' AND indexdef LIKE '%jsonb_path_ops%')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'tickets' AND indexname = 'tickets_metadata_path_gin'
                     AND indexdef LIKE '%USING gin%' AND indexdef LIKE '%jsonb_path_ops%')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'tickets' AND indexname = 'tickets_source_document_id_idx'
                     AND indexdef LIKE '%source_document%'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g71_before
UNION ALL
SELECT 'inventory (after): document_assets rows asserted by a machine', NULL,
       (SELECT COUNT(*) FROM document_assets WHERE asserted_by = 'machine')::text
UNION ALL
SELECT 'inventory (after): document_assets rows asserted by a person', NULL,
       (SELECT COUNT(*) FROM document_assets WHERE asserted_by = 'human')::text;
