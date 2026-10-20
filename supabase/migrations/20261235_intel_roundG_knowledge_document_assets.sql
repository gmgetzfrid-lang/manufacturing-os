-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-26) — GAP-307 acceptance 3: a knowledge upload gets
-- a document↔equipment relation of its own.
--
-- document_assets (20260609) relates equipment to a CONTROLLED document:
-- document_assets.document_id is NOT NULL and references documents(id). A
-- P&ID uploaded straight into a knowledge library has no controlled
-- document, so when a writer discovers its tags (the knowledge door,
-- lib/equipmentBridgeServer.ts discoverFromKnowledge, DEC-96 item 3) the
-- assets are created but no relation row can say which sheet carries them;
-- the coverage report kept the upload's sheets as a working list.
--
-- The shape (the integrator's default, and this package's decision —
-- recorded under DEC-96): a SECOND table, knowledge_document_assets, rather
-- than a nullable document_assets.document_id. Loosening that FK would make
-- every reverse reader of document_assets (the asset hub, the graph, the
-- impact scan, revision impact, the export) meet rows with no controlled
-- document, and the DACL-11 read rail (EXISTS on documents) would hide them
-- all; a second table keeps every existing reader's contract byte for byte.
--
--   knowledge_document_assets
--     org_id                 the workspace (FK orgs, CASCADE)
--     knowledge_document_id  the upload (FK knowledge_documents, CASCADE —
--                            the relation goes with the upload)
--     asset_id               the equipment (FK assets, CASCADE)
--     tag_text               the tag as the sheet printed it
--     source                 'drawing' (a machine reading off the sheet) —
--                            the only source today; the CHECK names it
--     sheet_label, pages     where on the upload it was read (GAP-301)
--     asserted_by            'machine' | 'human' — document_assets'
--                            provenance columns (20261171), mirrored:
--     asserted_by_user       a 'drawing' row is always a machine's
--     model                  (CHECK); the AI model that transcribed the
--     source_revision        page (NULL: the PDF's text layer); the
--     source_version_id      revision the upload carried, when it had one
--     created_at, updated_at
--   UNIQUE (knowledge_document_id, asset_id) — one row per pair.
--
-- WHO READS IT: an active member of the workspace, and only while they can
-- read the knowledge document itself — a RESTRICTIVE policy whose EXISTS
-- runs under the CALLER's row-level security on knowledge_documents, so the
-- knowledge document's own read decision is the relation's (the DACL-11
-- pattern of 20261170). WHO WRITES IT: the service role only (the Bridge's
-- knowledge door). There is no INSERT / UPDATE / DELETE policy for a
-- signed-in person, and those privileges are revoked from anon and
-- authenticated. A BEFORE INSERT OR UPDATE trigger
-- (knowledge_document_assets_same_org; not SECURITY DEFINER, search_path
-- pinned) refuses (23503) a row whose upload or asset is another
-- workspace's, for every writer.
--
-- WIDENING (narrow, DEC-30 inventory below): a new table. What it holds —
-- which equipment tags an upload carries, on which pages — is read today by
-- a member who can read the upload (its passages carry the same tags);
-- the entity index itself (knowledge_page_entities) stays service-role only.
-- Nothing anyone could do before changes; no existing policy, function,
-- trigger or row is touched, and nothing is re-created.
--
-- The app before and after this paste: before it, the knowledge door
-- creates the assets exactly as today and says the link needs this file
-- (a read or write naming the table answers 42P01 / PGRST205 → today's
-- path); the coverage report lists the upload's sheets from the extracted
-- tags, as today. After it, each discovery writes the relation, and the
-- coverage report reads the relation for the upload (via 'relation').
-- Uploads discovered BEFORE the paste are related the next time a writer
-- discovers from that upload; the paste writes no customer rows.
--
-- Requires 20260609 (assets), 20260911 (knowledge_documents). Paste order:
-- any time after those; independent of every pending file. Deploy order:
-- either. Single paste: inventory (TEMP, counts only) → BEGIN/DDL/COMMIT →
-- ONE SELECT (check text, ok boolean, n text). Idempotent; a re-paste is
-- clean.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS pg_temp._intel_g235_before;
CREATE TEMP TABLE _intel_g235_before AS
SELECT 'inventory: knowledge documents uploaded straight into a knowledge library (no controlled document) — each may now carry relation rows' AS what,
       COUNT(*) AS n
  FROM knowledge_documents WHERE source_document_id IS NULL
UNION ALL
SELECT 'inventory: assets discovered through the knowledge door before this paste (related the next time a writer discovers from their upload)',
       COUNT(*) FROM assets WHERE origin = 'drawing' AND discovered_from ->> 'door' = 'knowledge'
UNION ALL
SELECT 'inventory: active members (each reads the relation only for the knowledge documents they can read)',
       COUNT(*) FROM org_members WHERE status = 'active';

BEGIN;

CREATE TABLE IF NOT EXISTS knowledge_document_assets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  knowledge_document_id  UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  asset_id               UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_text               TEXT,
  source                 TEXT NOT NULL DEFAULT 'drawing',
  sheet_label            TEXT,
  pages                  INTEGER[],
  asserted_by            TEXT NOT NULL DEFAULT 'machine',
  asserted_by_user       UUID,
  model                  TEXT,
  source_revision        TEXT,
  source_version_id      UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_document_assets_pair_uniq UNIQUE (knowledge_document_id, asset_id),
  CONSTRAINT knowledge_document_assets_source_check CHECK (source IN ('drawing')),
  CONSTRAINT knowledge_document_assets_asserted_by_check CHECK (asserted_by IN ('machine', 'human')),
  CONSTRAINT knowledge_document_assets_drawing_is_machine CHECK (source <> 'drawing' OR asserted_by = 'machine')
);
CREATE INDEX IF NOT EXISTS knowledge_document_assets_asset_idx ON knowledge_document_assets (asset_id);
CREATE INDEX IF NOT EXISTS knowledge_document_assets_org_idx ON knowledge_document_assets (org_id, id);

-- Both ends belong to the row's workspace — for every writer, the service
-- role included (the FKs alone do not say whose).
CREATE OR REPLACE FUNCTION knowledge_document_assets_same_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id = NEW.knowledge_document_id AND k.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'knowledge_document_assets: the knowledge document is not in this workspace'
      USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = NEW.asset_id AND a.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'knowledge_document_assets: the asset is not in this workspace'
      USING ERRCODE = '23503';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION knowledge_document_assets_same_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_knowledge_document_assets_same_org ON knowledge_document_assets;
CREATE TRIGGER trg_knowledge_document_assets_same_org
  BEFORE INSERT OR UPDATE ON knowledge_document_assets
  FOR EACH ROW EXECUTE FUNCTION knowledge_document_assets_same_org();

-- Who reads it; nobody signed in writes it.
ALTER TABLE knowledge_document_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON knowledge_document_assets FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON knowledge_document_assets FROM authenticated;
GRANT SELECT ON knowledge_document_assets TO authenticated;
GRANT ALL ON knowledge_document_assets TO service_role;

DROP POLICY IF EXISTS knowledge_document_assets_select ON knowledge_document_assets;
CREATE POLICY knowledge_document_assets_select ON knowledge_document_assets
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = knowledge_document_assets.org_id AND m.uid = auth.uid() AND m.status = 'active'));

-- RESTRICTIVE: ANDed with the permissive policy. The EXISTS runs under the
-- CALLER's RLS on knowledge_documents, so it is that table's read decision.
DROP POLICY IF EXISTS knowledge_document_assets_document_readable ON knowledge_document_assets;
CREATE POLICY knowledge_document_assets_document_readable ON knowledge_document_assets
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id = knowledge_document_assets.knowledge_document_id));

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'knowledge_document_assets exists with document_assets'' provenance columns (asserted_by, asserted_by_user, model, source_revision, source_version_id) and sheet_label / pages' AS "check",
       (SELECT COUNT(*) = 15 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'knowledge_document_assets'
           AND column_name IN ('id', 'org_id', 'knowledge_document_id', 'asset_id', 'tag_text', 'source', 'sheet_label', 'pages',
                               'asserted_by', 'asserted_by_user', 'model', 'source_revision', 'source_version_id', 'created_at', 'updated_at')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'its foreign keys: the knowledge document, the asset and the workspace, each ON DELETE CASCADE',
       (SELECT COUNT(*) = 3 FROM pg_constraint
         WHERE conrelid = 'public.knowledge_document_assets'::regclass AND contype = 'f' AND confdeltype = 'c'
           AND confrelid IN ('public.knowledge_documents'::regclass, 'public.assets'::regclass, 'public.orgs'::regclass)),
       NULL
UNION ALL
SELECT 'one row per (knowledge document, asset); a drawing row is always a machine''s',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.knowledge_document_assets'::regclass AND conname = 'knowledge_document_assets_pair_uniq' AND contype = 'u')
       AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.knowledge_document_assets'::regclass AND conname = 'knowledge_document_assets_drawing_is_machine' AND convalidated),
       NULL
UNION ALL
SELECT 'row-level security is on; members read it only while they can read the knowledge document (RESTRICTIVE EXISTS on knowledge_documents)',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.knowledge_document_assets'::regclass)
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_document_assets' AND policyname = 'knowledge_document_assets_select'
                    AND permissive = 'PERMISSIVE' AND cmd = 'SELECT' AND qual LIKE '%org_members%')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_document_assets' AND policyname = 'knowledge_document_assets_document_readable'
                    AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT' AND qual LIKE '%knowledge_documents%'),
       NULL
UNION ALL
SELECT 'no signed-in writer: no INSERT / UPDATE / DELETE / ALL policy, and anon / authenticated hold no write privilege',
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_document_assets' AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
       AND NOT has_table_privilege('authenticated', 'public.knowledge_document_assets', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.knowledge_document_assets', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.knowledge_document_assets', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.knowledge_document_assets', 'SELECT')
       AND has_table_privilege('authenticated', 'public.knowledge_document_assets', 'SELECT'),
       NULL
UNION ALL
SELECT 'knowledge_document_assets_same_org: bound BEFORE INSERT OR UPDATE, owner''s rights (not SECURITY DEFINER), search_path pinned, not executable by name',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_knowledge_document_assets_same_org'
                AND tgrelid = 'public.knowledge_document_assets'::regclass AND NOT tgisinternal)
       AND (SELECT NOT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'knowledge_document_assets_same_org')
       AND NOT has_function_privilege('authenticated', 'knowledge_document_assets_same_org()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'knowledge_document_assets_same_org()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'after: knowledge_document_assets rows (0 on the first paste — the paste writes no customer rows)', NULL, COUNT(*)::text
  FROM knowledge_document_assets
UNION ALL
SELECT what, NULL, n::text FROM _intel_g235_before;
