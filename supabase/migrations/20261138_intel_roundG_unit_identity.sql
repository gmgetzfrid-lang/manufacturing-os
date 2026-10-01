-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-13) — one unit identity (GAP-305), and how many
-- documents a reader's map leaves out (GM-6).
--
-- The org graph drew the crude unit twice: `cbunit:<code>` from the Site
-- Codebook (what the registry files equipment by — assets.unit_code) and
-- `unit:<uuid>` from the operational `units` table (what documents.unit_id
-- points at). Nothing joined them, and a document decoded from its drawing
-- number had nowhere to record the decode. Decision (DEC-67, provisional
-- number): keep BOTH — a configured operating unit and a decoded code mean
-- different things — and JOIN them as data; retire nothing.
--
-- What this file changes (every object below is NEW — no earlier migration
-- defines any of them, so nothing is re-created; lib/__tests__/
-- intelRoundGUnitIdentity.test.ts pins that):
--   1. units.codebook_code TEXT + UNIQUE (org_id, codebook_code) where set:
--      the mapping. A Site Codebook unit code resolves to AT MOST ONE
--      operational unit, and the mapping is a row, set on /admin/scope.
--      trg_units_codebook_code_guard (5. below) decides who sets it.
--   2. documents.unit_code TEXT (+ index): the drawing-number decode,
--      written by the unit-identity backfill (POST /api/admin/unit-identity,
--      service role, the codebook's own parser) — a number that does not
--      decode, or decodes to a unit the codebook does not hold, is REPORTED
--      and left NULL, never guessed.
--   3. trg_documents_unit_code_guard (BEFORE INSERT OR UPDATE OF unit_code,
--      document_number): the column is the decode's. A person's INSERT lands
--      it NULL; a person's UPDATE that sets it is refused (42501; clearing it
--      is allowed — the next decode re-derives it); a renumbered document's
--      old decode is dropped unless the same write sets a new one. The
--      service role (the decode itself, an org restore) passes. Not SECURITY
--      DEFINER (it reads nothing); search_path pinned anyway.
--   4. documents_total_for_org(p_org_id): the org's document COUNT for an
--      active member (0 for anyone else) — never a row, a title or an id — so
--      the graph can say "N documents are outside your access" instead of
--      presenting a viewer's orphans as a fact about the plant (GM-6).
--      SECURITY DEFINER (the count must be whole whatever the caller reads),
--      search_path pinned, EXECUTE revoked from PUBLIC and anon, granted to
--      authenticated only; a NULL auth.uid() matches no member and gets 0.
--   5. trg_units_codebook_code_guard (BEFORE INSERT OR UPDATE OF
--      codebook_code, archived OR DELETE ON units): the mapping decides which
--      operational unit IS a codebook unit on the graph, what a unit's scope
--      holds and what the decode writes into assets.unit_id — and the only
--      policy on units (units_member_all, 20260606) lets ANY active member
--      write the row. So every change to the mapping (a code set, cleared,
--      released by an archive, or deleted with its row) is refused 42501
--      unless the caller holds a role of the Operational scope page's
--      writer tier (ADMIN_SURFACES
--      "scope".writes — Admin, Manager, Supervisor, DocCtrl — read from the
--      role collection by caller_holds_any_role, 20261045; a test pins the
--      list to lib/adminSurfaces.ts). The service role passes. An archived
--      unit holds no code: archiving releases it, so the codebook unit can
--      be mapped to the unit that replaces it (the UNIQUE index would
--      otherwise hold it on a row the page no longer shows). Not SECURITY
--      DEFINER; search_path pinned.
--   6. trg_assets_unit_id_follows_filing (BEFORE INSERT OR UPDATE OF
--      unit_code ON assets): assets.unit_id is the mapping's projection of
--      the item's filing, and it is kept current here for every writer (the
--      registry page, the Bridge, an import, the decode) — the way 3. drops a
--      renumbered document's decode. A new item with no unit takes the one
--      its filing maps to; a refiled item whose unit WAS the old filing's
--      projection (or empty) takes the new filing's (none, when that maps to
--      none); a write that sets unit_id itself is taken as written; a unit
--      that disagreed with the old filing (set by hand or by an import) is
--      kept. An UPDATE that names unit_code without changing it fills an
--      EMPTY unit from the mapping as it stands at that moment — the
--      decode's fill is exactly that write, so a remap after the decode's
--      read is never written as it was. Not SECURITY DEFINER (it reads
--      units, which every active member reads); search_path pinned.
--   7. trg_units_codebook_code_follow (AFTER INSERT OR UPDATE OF
--      codebook_code, archived ON units): the projection follows the
--      mapping. When a unit's code is set, cleared, moved or released by an
--      archive, the equipment it was projected onto (unit_id = this unit,
--      filed under the old code) moves to the old code's holder (none — the
--      code is unique), and the equipment filed under the new code with no
--      unit takes this one (fill only). A deleted unit needs nothing here:
--      assets.unit_id is ON DELETE SET NULL (20260606). SECURITY DEFINER, as
--      a foreign key's own cascade bypasses RLS: the projection must move
--      with the mapping whoever moved it — a scope writer who also holds a
--      read-only role is refused by the assets UPDATE overlay (20261045),
--      which would leave the old unit on the equipment silently. It
--      re-checks 5.'s authority itself (it never runs for anyone 5. refuses,
--      whatever the trigger order), writes only assets.unit_id, only the
--      org's equipment under the code that moved, and the registry guard
--      (assets_guard_registry, 20261045) still sees the caller.
--      search_path pinned. EXECUTE is revoked from PUBLIC, anon and
--      authenticated (DRLS-16): a trigger function is never called by name,
--      and PostgreSQL checks no EXECUTE privilege when a trigger fires, so
--      the revoke changes nothing for the trigger and keeps the function off
--      the anon-executable SECURITY DEFINER sweep (20261129).
--
-- WIDENS one read: an active member may learn how many documents the org
-- holds, including ones they cannot open (a count only — the same class as
-- 20261120's entity_mentions_total_for_asset). Both guards narrow (members
-- can no longer hand-write a unit decode, and only the scope writer tier can
-- change the mapping). The projection (6., 7.) writes nothing a person
-- chooses: only assets.unit_id, only the filing seen through the mapping,
-- and a unit that disagrees with the filing is kept; 7. moves it for a
-- mapping change 5. admitted even when the assets UPDATE overlay would
-- refuse that caller a registry write of their own (a scope writer who also
-- holds Viewer or Auditor — counted in the inventory below, so the paste
-- says how many members gain it). The application half — POST /api/admin/unit-
-- identity reads every document with the service role — lists a document's
-- number in its report only to a caller who may read it (the controller
-- tier sees all; the rest of the scope writer tier sees open-visibility
-- numbers and a count of the others), and it FILLS an empty assets.unit_id
-- (through 6.) but never rewrites one already set.
--
-- DEC-30. The pre-apply inventory (aggregate counts only) is captured into a
-- TEMP TABLE BEFORE the transaction. The decode runs in TypeScript after the
-- apply, so the "documents whose decoded unit disagrees with documents.unit_id"
-- inventory is necessarily 0 on the first paste: re-paste this file after the
-- first backfill (it is idempotent) and the final rows report the real counts.
-- Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check text, ok
-- boolean, n text) — the editor shows only the last result set.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- A re-paste in the same session reads THIS paste's counts, never the first's.
DROP TABLE IF EXISTS pg_temp._intel_g38_before;
CREATE TEMP TABLE _intel_g38_before AS
SELECT 'documents carrying an operational unit (documents.unit_id) — what the decode is compared against' AS what, COUNT(*) AS n
  FROM documents WHERE unit_id IS NOT NULL
UNION ALL
SELECT 'documents with a document number (the decode''s input)', COUNT(*)
  FROM documents WHERE document_number IS NOT NULL AND btrim(document_number) <> ''
UNION ALL
SELECT 'operational units (units, not archived)', COUNT(*) FROM units WHERE NOT archived
UNION ALL
SELECT 'Site Codebook units', COUNT(*) FROM codebook_entries WHERE kind = 'unit'
UNION ALL
SELECT 'operational units whose code equals a Site Codebook unit code (a hint for the mapping — never applied automatically)', COUNT(*)
  FROM units u
 WHERE NOT u.archived
   AND EXISTS (SELECT 1 FROM codebook_entries c WHERE c.org_id = u.org_id AND c.kind = 'unit' AND c.code = u.code)
UNION ALL
SELECT 'assets with assets.unit_id set (the decode and the triggers below fill only an EMPTY unit_id; a set value is kept, except a projection — equipment pointing at the unit mapped to the code it is filed under — which follows a mapping change, 7.)', COUNT(*)
  FROM assets WHERE unit_id IS NOT NULL
UNION ALL
SELECT 'assets filed under a Site Codebook unit (assets.unit_code set)', COUNT(*)
  FROM assets WHERE unit_code IS NOT NULL
UNION ALL
SELECT 'documents whose visibility is not normal (what a non-controller''s map can leave out — GM-6)', COUNT(*)
  FROM documents WHERE visibility IS NOT NULL AND visibility <> 'normal'
UNION ALL
SELECT 'active members who GAIN the widening of 7.: a scope writer role (Admin, Manager, Supervisor, DocCtrl) held together with Viewer or Auditor (role or roles) — the assets UPDATE overlay refuses them a registry write, yet a mapping change they make moves assets.unit_id', COUNT(*)
  FROM org_members
 WHERE status = 'active'
   AND (role = ANY(ARRAY['Admin','Manager','Supervisor','DocCtrl']::text[]) OR roles && ARRAY['Admin','Manager','Supervisor','DocCtrl']::text[])
   AND (role = ANY(ARRAY['Viewer','Auditor']::text[]) OR roles && ARRAY['Viewer','Auditor']::text[]);

BEGIN;

-- ── 1. The mapping: one codebook unit code → at most one operational unit ───
ALTER TABLE units ADD COLUMN IF NOT EXISTS codebook_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS units_org_codebook_code_uniq
  ON units (org_id, codebook_code) WHERE codebook_code IS NOT NULL;

-- ── 2. The decode's column ──────────────────────────────────────────────────
ALTER TABLE documents ADD COLUMN IF NOT EXISTS unit_code TEXT;
CREATE INDEX IF NOT EXISTS documents_org_unit_code_idx
  ON documents (org_id, unit_code) WHERE unit_code IS NOT NULL;

-- ── 3. Only the decode writes it ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION documents_unit_code_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- A renumbered document's old decode is no longer true: drop it unless
  -- the same write sets a new one.
  IF TG_OP = 'UPDATE' AND NEW.document_number IS DISTINCT FROM OLD.document_number
     AND NEW.unit_code IS NOT DISTINCT FROM OLD.unit_code THEN
    NEW.unit_code := NULL;
  END IF;
  -- The service role (the decode, an org restore) writes the column.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.unit_code := NULL;
  ELSIF NEW.unit_code IS DISTINCT FROM OLD.unit_code AND NEW.unit_code IS NOT NULL THEN
    RAISE EXCEPTION 'documents_unit_code_decode_only: documents.unit_code is written by the drawing-number decode (Operational scope - Unit identity), not by hand'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_unit_code_guard ON documents;
CREATE TRIGGER trg_documents_unit_code_guard
  BEFORE INSERT OR UPDATE OF unit_code, document_number ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_unit_code_guard();

-- ── 4. GM-6: how many documents the org holds (a count, members only) ───────
CREATE OR REPLACE FUNCTION documents_total_for_org(p_org_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM org_members
                  WHERE org_id = p_org_id AND uid = auth.uid() AND status = 'active')
    THEN (SELECT COUNT(*) FROM documents WHERE org_id = p_org_id)
    ELSE 0
  END;
$$;
REVOKE ALL ON FUNCTION documents_total_for_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION documents_total_for_org(uuid) TO authenticated;

-- ── 5. Who sets the mapping; an archived unit holds none ────────────────────
CREATE OR REPLACE FUNCTION units_codebook_code_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_changed boolean;
  v_org     uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_changed := OLD.codebook_code IS NOT NULL;
    v_org := OLD.org_id;
  ELSE
    -- An archived unit is no longer the codebook unit: archiving releases
    -- its code (so the code can be mapped to the unit that replaces it).
    IF NEW.archived THEN
      NEW.codebook_code := NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
      v_changed := NEW.codebook_code IS NOT NULL;
    ELSE
      v_changed := NEW.codebook_code IS DISTINCT FROM OLD.codebook_code;
    END IF;
    v_org := NEW.org_id;
  END IF;
  -- Every change to the mapping (a code set, cleared, released by an
  -- archive, or deleted with its row) is the Operational scope writer
  -- tier's. The service role passes.
  IF v_changed AND auth.uid() IS NOT NULL
     AND NOT caller_holds_any_role(v_org, ARRAY['Admin','Manager','Supervisor','DocCtrl']::text[]) THEN
    RAISE EXCEPTION 'units_codebook_code_scope_writers: only the Operational scope writer roles map a unit to the Site Codebook'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_units_codebook_code_guard ON units;
CREATE TRIGGER trg_units_codebook_code_guard
  BEFORE INSERT OR UPDATE OF codebook_code, archived OR DELETE ON units
  FOR EACH ROW EXECUTE FUNCTION units_codebook_code_guard();

-- ── 6. assets.unit_id follows the filing ────────────────────────────────────
CREATE OR REPLACE FUNCTION assets_unit_id_follows_filing()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A write that sets unit_id itself is taken as written.
    IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;
    IF OLD.unit_id IS NOT NULL THEN
      -- Not refiled: the unit stays.
      IF NEW.unit_code IS NOT DISTINCT FROM OLD.unit_code THEN RETURN NEW; END IF;
      -- Refiled, but the unit was not the old filing's projection (set by
      -- hand or by an import): kept.
      IF OLD.unit_id IS DISTINCT FROM (SELECT u.id FROM units u
            WHERE u.org_id = OLD.org_id AND u.codebook_code = OLD.unit_code AND NOT u.archived) THEN
        RETURN NEW;
      END IF;
    END IF;
  ELSIF NEW.unit_id IS NOT NULL THEN
    -- An insert that names its unit keeps it.
    RETURN NEW;
  END IF;
  -- The filing seen through the mapping as it stands now (NULL: none).
  NEW.unit_id := (SELECT u.id FROM units u
                   WHERE u.org_id = NEW.org_id AND u.codebook_code = NEW.unit_code AND NOT u.archived);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assets_unit_id_follows_filing ON assets;
CREATE TRIGGER trg_assets_unit_id_follows_filing
  BEFORE INSERT OR UPDATE OF unit_code ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_unit_id_follows_filing();

-- ── 7. The projection follows the mapping ───────────────────────────────────
CREATE OR REPLACE FUNCTION units_codebook_code_follow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.codebook_code IS NOT DISTINCT FROM OLD.codebook_code THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.codebook_code IS NULL THEN
    RETURN NULL;
  END IF;
  -- 5.'s authority, re-checked here: this function writes equipment rows
  -- with the definer's rights, so it decides for itself who it runs for.
  IF auth.uid() IS NOT NULL
     AND NOT caller_holds_any_role(NEW.org_id, ARRAY['Admin','Manager','Supervisor','DocCtrl']::text[]) THEN
    RAISE EXCEPTION 'units_codebook_code_scope_writers: only the Operational scope writer roles map a unit to the Site Codebook'
      USING ERRCODE = '42501';
  END IF;
  -- Released (moved, cleared, or by an archive): the equipment this unit was
  -- projected onto follows the old code to its holder now (none — a code
  -- maps to at most one unit — unless the same statement handed it on).
  IF TG_OP = 'UPDATE' AND OLD.codebook_code IS NOT NULL THEN
    UPDATE assets SET unit_id = (SELECT u.id FROM units u
                                  WHERE u.org_id = OLD.org_id AND u.codebook_code = OLD.codebook_code AND NOT u.archived)
     WHERE org_id = OLD.org_id AND unit_id = OLD.id AND unit_code = OLD.codebook_code;
  END IF;
  -- Taken: equipment filed under the new code with no unit takes this one
  -- (fill only — a unit already there is kept).
  IF NEW.codebook_code IS NOT NULL THEN
    UPDATE assets SET unit_id = NEW.id
     WHERE org_id = NEW.org_id AND unit_code = NEW.codebook_code AND unit_id IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_units_codebook_code_follow ON units;
CREATE TRIGGER trg_units_codebook_code_follow
  AFTER INSERT OR UPDATE OF codebook_code, archived ON units
  FOR EACH ROW EXECUTE FUNCTION units_codebook_code_follow();
-- DRLS-16: no one calls it by name (a trigger fires with no EXECUTE check).
REVOKE ALL ON FUNCTION units_codebook_code_follow() FROM PUBLIC, anon, authenticated;

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'units.codebook_code exists (the codebook ↔ operational-unit mapping)' AS "check",
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'units' AND column_name = 'codebook_code') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'a Site Codebook unit code maps to at most one operational unit per org (UNIQUE partial index)',
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND tablename = 'units' AND indexname = 'units_org_codebook_code_uniq'
                  AND indexdef LIKE 'CREATE UNIQUE INDEX%'
                  AND indexdef LIKE '%(org_id, codebook_code)%'
                  AND indexdef LIKE '%WHERE (codebook_code IS NOT NULL)%'),
       NULL
UNION ALL
SELECT 'documents.unit_code exists (the drawing-number decode)',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'unit_code'),
       NULL
UNION ALL
SELECT 'documents.unit_code is the decode''s: a person''s insert lands NULL, a person''s write is refused, a renumber drops the old decode, the service role passes (trigger, search_path pinned)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_documents_unit_code_guard'
                AND tgrelid = 'documents'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%IF TG_OP = ''INSERT'' THEN%NEW.unit_code := NULL;%'
                   AND prosrc LIKE '%NEW.document_number IS DISTINCT FROM OLD.document_number%'
                   AND prosrc LIKE '%USING ERRCODE = ''42501''%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'documents_unit_code_guard'),
       NULL
UNION ALL
SELECT 'documents_total_for_org: SECURITY DEFINER, search_path pinned, a member-only count (0 for anyone else)',
       (SELECT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%uid = auth.uid() AND status = ''active''%'
               AND prosrc LIKE '%ELSE 0%'
          FROM pg_proc WHERE proname = 'documents_total_for_org'),
       NULL
UNION ALL
SELECT 'documents_total_for_org: anon cannot execute it; authenticated can (DRLS-16 rule)',
       NOT has_function_privilege('anon', 'documents_total_for_org(uuid)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'documents_total_for_org(uuid)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'units.codebook_code is the scope writer tier''s: a change by anyone else (set, cleared, released by an archive, deleted with its row) is refused (42501), an archived unit holds no code, the service role passes (trigger, not SECURITY DEFINER, search_path pinned)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_units_codebook_code_guard'
                AND tgrelid = 'units'::regclass AND NOT tgisinternal
                AND (tgtype & 8) <> 0)
       AND (SELECT prosrc LIKE '%IF NEW.archived THEN%NEW.codebook_code := NULL;%'
                   AND prosrc LIKE '%v_changed := OLD.codebook_code IS NOT NULL;%'
                   AND prosrc LIKE '%IF v_changed AND auth.uid() IS NOT NULL%'
                   AND prosrc LIKE '%caller_holds_any_role(v_org, ARRAY[''Admin'',''Manager'',''Supervisor'',''DocCtrl'']::text[])%'
                   AND prosrc LIKE '%USING ERRCODE = ''42501''%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'units_codebook_code_guard'),
       NULL
UNION ALL
SELECT 'assets.unit_id follows the filing: a new item takes the unit its filing maps to, a refile moves a projected unit and keeps one set by hand, a write that sets unit_id is taken as written (BEFORE trigger, not SECURITY DEFINER, search_path pinned)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assets_unit_id_follows_filing'
                AND tgrelid = 'assets'::regclass AND NOT tgisinternal
                AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0)
       AND (SELECT prosrc LIKE '%IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%IF NEW.unit_code IS NOT DISTINCT FROM OLD.unit_code THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%IF OLD.unit_id IS DISTINCT FROM (SELECT u.id FROM units u%'
                   AND prosrc LIKE '%NEW.unit_id := (SELECT u.id FROM units u%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'assets_unit_id_follows_filing'),
       NULL
UNION ALL
SELECT 'the projection follows the mapping: a code moved, cleared or released takes its projected unit off the equipment, the new code fills its equipment with none (AFTER row trigger, SECURITY DEFINER, search_path pinned, the scope writer tier re-checked)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_units_codebook_code_follow'
                AND tgrelid = 'units'::regclass AND NOT tgisinternal
                AND (tgtype & 1) <> 0 AND (tgtype & 2) = 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0)
       AND (SELECT prosrc LIKE '%WHERE org_id = OLD.org_id AND unit_id = OLD.id AND unit_code = OLD.codebook_code;%'
                   AND prosrc LIKE '%WHERE org_id = NEW.org_id AND unit_code = NEW.codebook_code AND unit_id IS NULL;%'
                   AND prosrc LIKE '%caller_holds_any_role(NEW.org_id, ARRAY[''Admin'',''Manager'',''Supervisor'',''DocCtrl'']::text[])%'
                   AND prosrc LIKE '%USING ERRCODE = ''42501''%'
                   AND prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'units_codebook_code_follow'),
       NULL
UNION ALL
SELECT 'units_codebook_code_follow (SECURITY DEFINER): anon and authenticated cannot execute it by name (DRLS-16 rule; the trigger fires without an EXECUTE check)',
       NOT has_function_privilege('anon', 'units_codebook_code_follow()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'units_codebook_code_follow()', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g38_before
UNION ALL
SELECT 'inventory (after): operational units mapped to a Site Codebook unit', NULL,
       (SELECT COUNT(*) FROM units WHERE codebook_code IS NOT NULL)::text
UNION ALL
SELECT 'inventory (after): assets whose unit_id differs from the operational unit their filing maps to (kept — set by hand or by an import; a projected unit follows its filing and the mapping)', NULL,
       (SELECT COUNT(*) FROM assets a JOIN units u ON u.org_id = a.org_id AND u.codebook_code = a.unit_code
         WHERE a.unit_id IS NOT NULL AND a.unit_id <> u.id)::text
UNION ALL
SELECT 'inventory (after): documents carrying a decoded unit (0 until the first backfill)', NULL,
       (SELECT COUNT(*) FROM documents WHERE unit_code IS NOT NULL)::text
UNION ALL
SELECT 'inventory (after, DEC-30): documents whose decoded unit maps to a DIFFERENT operational unit than documents.unit_id (both are drawn; nothing is rewritten)', NULL,
       (SELECT COUNT(*) FROM documents d JOIN units u ON u.id = d.unit_id
         WHERE d.unit_code IS NOT NULL AND u.codebook_code IS NOT NULL AND u.codebook_code <> d.unit_code)::text
UNION ALL
SELECT 'inventory (after, DEC-30): documents with a decoded unit whose documents.unit_id points at an operational unit that is not mapped', NULL,
       (SELECT COUNT(*) FROM documents d JOIN units u ON u.id = d.unit_id
         WHERE d.unit_code IS NOT NULL AND u.codebook_code IS NULL)::text;
