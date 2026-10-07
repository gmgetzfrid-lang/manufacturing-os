-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-11) — the document↔equipment relation gets a word
-- for "a drawing said so", and its rows follow their document's visibility.
--
-- document_assets (20260609) is the one relation every reverse reader uses —
-- the asset hub, the unit hub, the graph's tag edges, the impact scan, the
-- revision fan-out, the link proposer, the scope resolver, ⌘K. The Bridge
-- (lib/equipmentBridgeServer.ts) never wrote it: its only output was a list
-- of tag strings in documents.metadata[<mapped column>], which no reader
-- sees (BR-2 / WIRE-1 / GAP-304). Routing the Bridge through
-- documents.asset_tags instead would be undone by the trigger below, which
-- DELETEs and re-derives every 'jsonb_sync' row on each asset_tags edit and
-- reads only elem->>'tag' (99-fix-sequencing PAIR 1, GAP-302).
--
-- What this file changes:
--   1. GAP-302 — the source vocabulary admits 'drawing' (a machine read the
--      tag off a sheet; the Bridge writes it with the service role), and the
--      relation can carry WHERE on the document: sheet_label (the site's
--      sheet address, "2002-D-10001 SHT 4", from the sheet's own title block
--      — GAP-301) and pages (the page numbers it was read on). Both nullable.
--      The CHECK is re-added NOT VALID and validated only where no row
--      carries another source (two worlds, DEC-30; the old CHECK makes that
--      empty). The trigger's DELETE stays scoped to source = 'jsonb_sync',
--      so a 'drawing' or 'manual' row survives every asset_tags edit (probed
--      below; pinned by test).
--   2. The two sync triggers run as their owner (SECURITY DEFINER,
--      search_path pinned), re-created byte-for-byte from 20260609 otherwise.
--      Until now they ran as the person whose write fired them, under the
--      membership-only policy. With item 3 a person may no longer write
--      'jsonb_sync' rows, so a drafter's asset_tags edit (or a writer's new
--      asset) would be refused mid-statement. They write only what the row
--      that fired them says: the firing document's own tags, or the new
--      asset's links to documents already naming it — exactly today's rows.
--      EXECUTE is revoked from every client role (DRLS-16: a trigger
--      function is never called by name; a trigger fires with no EXECUTE
--      check).
--   3. AREA-2 — the relation's write authority. The single FOR ALL policy
--      (any active member — a Viewer could delete every link in the org from
--      the console, or plant one from the graph's Connect) is DROPPED and
--      replaced:
--        SELECT  any active member of the org (as before) …
--        INSERT  a 'manual' row only, by the registry writer tier (Admin,
--                DocCtrl, Manager, Supervisor — ADMIN_SURFACES "assets".writes,
--                by the role collection: caller_holds_any_role, 20261045),
--                for a document the caller can read and an asset, both in
--                the row's org;
--        UPDATE  the writer tier, never a 'drawing' row, and the row stays
--                'manual' and in-org (an upsert onto a synced row makes it
--                the person's);
--        DELETE  the writer tier, never a 'drawing' row.
--      'drawing' rows are written and removed by the service role only (the
--      Bridge, and its review actions on /api/equipment-bridge, which record
--      who decided). 'jsonb_sync' rows are the triggers' (item 2).
--   4. DACL-11 — a link is readable only with its document: a RESTRICTIVE
--      SELECT policy on document_assets and on project_documents, EXISTS on
--      documents under the CALLER's RLS (the documents read decision itself
--      — membership + node_visible — never a copy of it; the same shape as
--      entity_mentions_source_readable, 20261120, and
--      document_related_resources_read_endpoints, 20261126). A restricted
--      drawing's existence, UUID and tags no longer reach members who
--      cannot open it, and existence-only surfaces (the impact counts, the
--      graph's "links leaving the map") cannot count what the reader cannot
--      see. The service role (the Bridge, the restore, every server route)
--      reads as before.
--
-- NARROWS: members outside the registry writer tier lose writing manual
-- links (the graph's Connect, the shape wizard) and deleting any link; every
-- member loses reading links to documents they cannot read. WIDENS nothing a
-- person can do. The app keeps working while this is unpasted: the Bridge's
-- 'drawing' insert is refused by the old CHECK (23514) and it says the
-- relation was not recorded, keeping its column write — today's behaviour;
-- readers see no 'drawing' rows; ⌘K and the hub read sheet_label only when
-- the column exists. Pasted WITHOUT 20261171 the Bridge still writes no
-- 'drawing' row: a row is written only with its provenance (GAP-303 before
-- GAP-304, 99-fix-sequencing Phase 2), so until 20261171 lands it says the
-- relation needs that file and keeps its column write.
--
-- Two consequences outside this area (recorded under DACL-11 / AREA-2 and
-- handed to projects, which owns lib/projects.ts and lib/transitionIn.ts):
-- (1) the project_documents read rail means a link row whose document the
-- caller cannot read is no longer returned at all, so the projects
-- register's "N linked documents are hidden by your permissions" disclosure
-- (listProjectDocuments' hiddenByPermissions / hiddenDocIds) reads 0 from
-- now on — the hiding is total, the disclosure goes dark; (2) transition-in's
-- link of matched equipment (an upsert ON CONFLICT DO NOTHING) onto a pair a
-- 'drawing' row already holds writes nothing, silently — the controller's
-- assertion is lost if the drawing row is later dismissed; it should go
-- through /api/equipment-bridge action 'adopt' when the pair is a drawing row.
--
-- Requires 20260609 (the tables), 20260814 (is_org_controller) and 20261045
-- (caller_holds_any_role). Paste order: after 20261128 / 20261138 (no object
-- of theirs is touched — any order works, this is the stated one), and
-- BEFORE 20261171 (which adds provenance columns to the rows this file lets
-- the Bridge write). Deploy order: the app may deploy before or after.
-- Pre-apply inventory (DEC-30) is a TEMP TABLE captured before the
-- transaction, aggregate counts only; nothing existing is rewritten or
-- deleted. Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check
-- text, ok boolean, n text). Idempotent, re-pasted before or after
-- 20261171: the vocabulary CHECK is the only constraint it drops, so
-- 20261171's document_assets_drawing_is_machine survives a re-paste.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g70_before AS
SELECT 'document_assets rows' AS what, COUNT(*) AS n FROM document_assets
UNION ALL
SELECT 'document_assets rows synced from documents.asset_tags (jsonb_sync)', COUNT(*) FROM document_assets WHERE source = 'jsonb_sync'
UNION ALL
SELECT 'document_assets rows linked by hand (manual)', COUNT(*) FROM document_assets WHERE source = 'manual'
UNION ALL
SELECT 'document_assets rows with a source outside (jsonb_sync, manual, drawing) — expected 0; while > 0 the widened CHECK stays NOT VALID', COUNT(*)
  FROM document_assets WHERE source IS NULL OR source NOT IN ('jsonb_sync', 'manual', 'drawing')
UNION ALL
SELECT 'document_assets rows on a private / hidden document (DACL-11: readable from now on only by members who can read that document)', COUNT(*)
  FROM document_assets da JOIN documents d ON d.id = da.document_id
 WHERE d.visibility IN ('private', 'hidden') OR COALESCE(d.is_private, false)
UNION ALL
SELECT 'project_documents rows on a private / hidden document (DACL-11: the same)', COUNT(*)
  FROM project_documents pd JOIN documents d ON d.id = pd.document_id
 WHERE d.visibility IN ('private', 'hidden') OR COALESCE(d.is_private, false)
UNION ALL
SELECT 'assets discovered from drawings (origin = drawing)', COUNT(*) FROM assets WHERE origin = 'drawing'
UNION ALL
SELECT 'of them, with their source drawing recorded (discovered_from)', COUNT(*) FROM assets WHERE origin = 'drawing' AND discovered_from IS NOT NULL
UNION ALL
SELECT 'documents whose library maps a Bridge column holding tags, with no document_assets row at all (GAP-304 backfill population — the next sweep of the library records them)', COUNT(*)
  FROM documents d JOIN libraries l ON l.id = d.library_id
 WHERE l.equipment_bridge ->> 'targetColumnKey' IS NOT NULL
   AND COALESCE(d.metadata ->> (l.equipment_bridge ->> 'targetColumnKey'), '') NOT IN ('', '[]')
   AND NOT EXISTS (SELECT 1 FROM document_assets da WHERE da.document_id = d.id)
UNION ALL
SELECT 'active members outside the registry writer tier (lose writing manual links and deleting any link — AREA-2)', COUNT(*)
  FROM org_members m
 WHERE m.status = 'active'
   AND NOT (m.role IN ('Admin', 'DocCtrl', 'Manager', 'Supervisor')
            OR m.roles && ARRAY['Admin', 'DocCtrl', 'Manager', 'Supervisor']::text[]);

BEGIN;

-- ── 1. GAP-302: the vocabulary, and where on the document ──────────────────
-- The CHECK that constrains `source` to its vocabulary today (20260609
-- declared it inline, so Postgres named it document_assets_source_check) is
-- replaced. Only the vocabulary CHECK — the one naming 'jsonb_sync' — is
-- dropped: 20261171's document_assets_drawing_is_machine also mentions
-- `source` and survives a re-paste of this file after it.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.document_assets'::regclass AND contype = 'c'
              AND (conname = 'document_assets_source_check'
                   OR (pg_get_constraintdef(oid) LIKE '%source%'
                       AND pg_get_constraintdef(oid) LIKE '%jsonb_sync%')) LOOP
    EXECUTE format('ALTER TABLE document_assets DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE document_assets ADD CONSTRAINT document_assets_source_check
  CHECK (source IN ('jsonb_sync', 'manual', 'drawing')) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM document_assets
                  WHERE source IS NULL OR source NOT IN ('jsonb_sync', 'manual', 'drawing')) THEN
    ALTER TABLE document_assets VALIDATE CONSTRAINT document_assets_source_check;
  END IF;
END $$;

ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS sheet_label TEXT;
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS pages INTEGER[];

-- ── 2. The sync triggers run as their owner (byte-faithful to 20260609) ────
-- On every documents INSERT/UPDATE-of-asset_tags-or-org_id, rebuild
-- the jsonb_sync rows for that document. We delete and re-insert
-- (rather than diff) because a sheet rarely has more than a handful
-- of tags; the simpler logic is worth the extra writes.
CREATE OR REPLACE FUNCTION documents_resync_assets()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
-- DRLS-16: no one calls it by name (a trigger fires with no EXECUTE check).
REVOKE ALL ON FUNCTION documents_resync_assets() FROM PUBLIC, anon, authenticated;

-- When a new canonical asset is created, link it to any existing
-- documents whose asset_tags JSONB already references it. Without
-- this, an asset that gets registered AFTER the drawings already
-- tag it would have empty back-references.
CREATE OR REPLACE FUNCTION assets_backfill_documents()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
-- DRLS-16: no one calls it by name.
REVOKE ALL ON FUNCTION assets_backfill_documents() FROM PUBLIC, anon, authenticated;

-- ── 3. AREA-2: who writes the relation ─────────────────────────────────────
ALTER TABLE document_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "document_assets_member_all" ON document_assets;

DROP POLICY IF EXISTS document_assets_select ON document_assets;
CREATE POLICY document_assets_select ON document_assets
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_assets.org_id AND uid = auth.uid() AND status = 'active'));

DROP POLICY IF EXISTS document_assets_insert ON document_assets;
CREATE POLICY document_assets_insert ON document_assets
  FOR INSERT TO authenticated
  WITH CHECK (source = 'manual'
              AND caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[])
              AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_assets.document_id AND d.org_id = document_assets.org_id)
              AND EXISTS (SELECT 1 FROM assets a WHERE a.id = document_assets.asset_id AND a.org_id = document_assets.org_id));

DROP POLICY IF EXISTS document_assets_update ON document_assets;
CREATE POLICY document_assets_update ON document_assets
  FOR UPDATE TO authenticated
  USING (source <> 'drawing'
         AND caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[]))
  WITH CHECK (source = 'manual'
              AND caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[])
              AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_assets.document_id AND d.org_id = document_assets.org_id)
              AND EXISTS (SELECT 1 FROM assets a WHERE a.id = document_assets.asset_id AND a.org_id = document_assets.org_id));

DROP POLICY IF EXISTS document_assets_delete ON document_assets;
CREATE POLICY document_assets_delete ON document_assets
  FOR DELETE TO authenticated
  USING (source <> 'drawing'
         AND caller_holds_any_role(org_id, ARRAY['Admin','DocCtrl','Manager','Supervisor']::text[]));

-- ── 4. DACL-11: a link is readable only with its document ──────────────────
-- RESTRICTIVE: ANDed with every permissive policy. The EXISTS runs under the
-- CALLER's RLS on documents, so it is the documents read decision itself.
DROP POLICY IF EXISTS document_assets_document_readable ON document_assets;
CREATE POLICY document_assets_document_readable ON document_assets
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_assets.document_id));

DROP POLICY IF EXISTS project_documents_document_readable ON project_documents;
CREATE POLICY project_documents_document_readable ON project_documents
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = project_documents.document_id));

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'document_assets.source admits drawing (GAP-302) — validated unless an unexpected source was counted above' AS "check",
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.document_assets'::regclass AND conname = 'document_assets_source_check'
                  AND pg_get_constraintdef(oid) LIKE '%jsonb_sync%'
                  AND pg_get_constraintdef(oid) LIKE '%manual%'
                  AND pg_get_constraintdef(oid) LIKE '%drawing%')
       AND (SELECT COUNT(*) FROM pg_constraint
             WHERE conrelid = 'public.document_assets'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%source%'
               AND pg_get_constraintdef(oid) LIKE '%jsonb_sync%') = 1 AS ok,
       NULL::text AS n
UNION ALL
SELECT 'document_assets.sheet_label and .pages exist and are nullable (GAP-302 / GAP-301)',
       (SELECT COUNT(*) = 2 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'document_assets'
           AND ((column_name = 'sheet_label' AND data_type = 'text')
                OR (column_name = 'pages' AND data_type = 'ARRAY'))
           AND is_nullable = 'YES'),
       NULL
UNION ALL
SELECT 'documents_resync_assets: the DELETE is still scoped to jsonb_sync rows (a drawing or manual row survives every asset_tags edit); owner rights, search_path pinned',
       (SELECT prosrc LIKE '%WHERE document_id = NEW.id AND source = ''jsonb_sync'';%'
               AND prosrc LIKE '%ON CONFLICT (document_id, asset_id) DO NOTHING%'
               AND prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'documents_resync_assets'),
       NULL
UNION ALL
SELECT 'assets_backfill_documents: owner rights, search_path pinned, still writes jsonb_sync links only',
       (SELECT prosrc LIKE '%''jsonb_sync''%'
               AND prosrc LIKE '%ON CONFLICT (document_id, asset_id) DO NOTHING%'
               AND prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'assets_backfill_documents'),
       NULL
UNION ALL
SELECT 'both sync functions: anon and authenticated cannot execute them by name (DRLS-16 rule; the triggers fire without an EXECUTE check)',
       NOT has_function_privilege('anon', 'documents_resync_assets()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'documents_resync_assets()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'assets_backfill_documents()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'assets_backfill_documents()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'both sync triggers are still bound (documents_resync_assets_trg, assets_backfill_documents_trg)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'documents_resync_assets_trg' AND tgrelid = 'public.documents'::regclass AND NOT tgisinternal)
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'assets_backfill_documents_trg' AND tgrelid = 'public.assets'::regclass AND NOT tgisinternal),
       NULL
UNION ALL
SELECT 'document_assets: the FOR ALL membership policy is gone (AREA-2)',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_assets' AND policyname = 'document_assets_member_all'),
       NULL
UNION ALL
SELECT 'document_assets_insert: manual rows only, the registry writer tier, a readable in-org document and an in-org asset',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'document_assets' AND policyname = 'document_assets_insert' AND cmd = 'INSERT'
                  AND with_check LIKE '%''manual''%'
                  AND with_check LIKE '%caller_holds_any_role%'
                  AND with_check LIKE '%Supervisor%'
                  AND with_check LIKE '%FROM documents d%'
                  AND with_check LIKE '%FROM assets a%'),
       NULL
UNION ALL
SELECT 'document_assets_update / _delete: the writer tier, never a drawing row',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE tablename = 'document_assets' AND policyname IN ('document_assets_update', 'document_assets_delete')
           AND qual LIKE '%''drawing''%'
           AND qual LIKE '%caller_holds_any_role%')
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'document_assets' AND policyname = 'document_assets_update'
                      AND with_check LIKE '%''manual''%' AND with_check LIKE '%caller_holds_any_role%'),
       NULL
UNION ALL
SELECT 'document_assets: members still read (permissive SELECT on membership)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'document_assets' AND policyname = 'document_assets_select' AND cmd = 'SELECT'
                  AND permissive = 'PERMISSIVE' AND qual LIKE '%org_members%'),
       NULL
UNION ALL
SELECT 'DACL-11: document_assets and project_documents rows are readable only with their document (RESTRICTIVE SELECT, EXISTS on documents)',
       (SELECT COUNT(*) = 2 FROM pg_policies
         WHERE ((tablename = 'document_assets' AND policyname = 'document_assets_document_readable')
                OR (tablename = 'project_documents' AND policyname = 'project_documents_document_readable'))
           AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE'
           AND qual LIKE '%FROM documents d%'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g70_before
UNION ALL
SELECT 'inventory (after): document_assets rows written by the Bridge (drawing) — 0 until the app writes them', NULL,
       (SELECT COUNT(*) FROM document_assets WHERE source = 'drawing')::text;
