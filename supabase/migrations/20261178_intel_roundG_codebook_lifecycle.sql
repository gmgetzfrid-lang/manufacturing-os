-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-16 CODEBOOK LIFECYCLE) — a Site Codebook code is
-- renamed in place, and the rename rewrites what references it in ONE
-- transaction; the codebook carries a version, and every site code records
-- the version it was written under; a legend sheet is a knowledge document of
-- the same workspace (CB-5, CB-6, ASK-8 done-when 2).
--
-- What this file changes:
--   1. CB-6 — the codebook version.
--      * codebook_config.codebook_version (BIGINT, from 1): the org's
--        codebook version. It moves only forward. It goes up when the code
--        rule or the drawing-number map changes (iterable_rule,
--        drawing_number: codebook_config_version_guard) and when an entry is
--        added, removed, re-coded or re-prefixed (codebook_entries_version_
--        stamp). A label, a pinned library or a knowledge binding derives
--        nothing and is no new version.
--      * codebook_entries.codebook_version: the org version the entry last
--        changed in (1: unchanged since this file).
--      * assets.codebook_version: the codebook version in force when the
--        asset's site code was last written — by any writer (the registry
--        page, an import, the Bridge, the server re-decode, a rename):
--        assets_codebook_version_stamp. NULL: no code, or a code written
--        before this file. A person cannot set it; an org restore (the
--        service role) carries the one its backup recorded. A service-role
--        insert that carries none takes the version in force: the Bridge's
--        new codes, and a code restored from a backup taken before this
--        file — the stamp cannot tell those two apart, so such a code reads
--        as written at the restore (re-derivation, not the stamp, decides
--        whether it still derives).
--      The service role never creates a codebook_config row here (an org
--      restore inserts the backup's own row afterwards and must not find one
--      waiting); it bumps an existing row only, and at most ONCE per org per
--      transaction (the transaction-local app.codebook_version_bumped): a
--      restore statement of N entries is one new version, not N. A restore
--      into an org with no codebook_config row yet (lib/dataRestore.ts
--      restores codebook_entries BEFORE codebook_config) bumps nothing, and
--      the config lands at the backup's own version.
--   2. CB-5 — rename_codebook_code(p_org_id, p_kind, p_old_code, p_new_code,
--      p_dry_run, p_expected): renames a unit or equipment-type code IN
--      PLACE. SECURITY DEFINER (it writes rows the caller's RLS may hide, and
--      must write all of them or none), search_path pinned. It refuses a NULL
--      auth.uid() (anon and the service role: a rename is a person's act,
--      recorded under their name), anyone outside is_org_controller, and a
--      controller who also holds a read-only role (Viewer / Auditor): the
--      rename rewrites the equipment registry with definer rights, so it
--      meets the registry's own subtraction rule — 20261045's RESTRICTIVE
--      assets_write_roles_update, deny-if-any on Viewer / Auditor — exactly
--      as that member's direct write of an asset would.
--      EXECUTE is revoked from PUBLIC and anon and granted to authenticated
--      only (DRLS-16). One transaction, serialized per org. Its writes run
--      inside the transaction-local setting app.codebook_rename (org, kind,
--      old and new code), set right before a. and cleared right after e.:
--        a. the new code is inserted as a row of its own (same label, meta,
--           sort, origin and author) — the digit guard (20261128 §4) checks it;
--        b. assets: the filing (unit_code) and the unit or type part of the
--           site code (assets.code — the same <unit><type> head 20261128 §6
--           counts) are rewritten;
--        c. units.codebook_code (20261138's mapping) follows a renamed unit —
--           its two triggers move assets.unit_id with it, as for any remap;
--        d. process_flows unit ends naming the old code take the new one;
--        e. the old row is deleted — nothing references it now, so
--           trg_codebook_entries_guard_in_use counts zero and passes;
--        f. the new row takes the old row's id (the entry keeps its
--           identity), and a CODEBOOK_CODE_RENAMED audit row records the
--           counts.
--      A rename is ONE new codebook version: a.'s insert bumps it, and the
--      old row's delete in e. (the setting names it) does not bump it again,
--      so every site code b. rewrites records the version the rename made.
--      p_dry_run answers the same counts and writes nothing. p_expected
--      (the counts a person confirmed) makes the apply refuse (40001) if
--      what it would touch changed since the preview: preview = apply.
--      A rename that would collide (a rewritten site code another asset
--      carries, a head that already reads — or once renamed would read — as
--      another unit and type, a flow that would duplicate or loop — between
--      the two codes, or a legacy row already looping at the old one — the
--      new code's mapping held by another operational unit, whether or not
--      the old code is mapped) is refused whole; the dry run names it first.
--      drawing_type codes are referenced by nothing stored and are not
--      renamed here.
--   3. process_flows_guard re-created from its only (newest) definition,
--      20261155, plus ONE block and its variable (lineDiff-pinned): see below.
--   4. ASK-8 — a legend sheet is a knowledge document of the same workspace.
--      assert_legend_doc_ids(org, new, old) refuses an ADDED id that is not
--      uuid-shaped (22023) or names no knowledge document of the org (23503);
--      an id already stored is kept as it is, so removing others never trips
--      on it. It binds every person's codebook_config write (the codebook
--      save; a direct PostgREST write too) through codebook_config_version_
--      guard, and the library toggles save through
--      knowledge_library_save_ai_features, re-created from its newest
--      definition (20261121) plus ONE line (lineDiff-pinned); a person's
--      direct write of knowledge_libraries.ai_features meets the same rule
--      (knowledge_libraries_legend_guard — it only refuses, never changes a
--      row, so 20261121's embedBuild guard beside it is untouched). The
--      service role (the org restore, the embed drain's marker writes)
--      passes. Ids already stored are counted below and kept (the ask route
--      reads only ids of the org's own documents since I-03).
--
-- HOW THE RENAME PASSES THE TWO GUARDS, NEITHER WEAKENED.
--   * 20261128 §6 trg_codebook_entries_guard_in_use is not touched. It runs
--     on the old row's DELETE (e.) exactly as for any person: the rename has
--     already moved every reference it counts (b.–d.), so it counts zero.
--     If anything still references the old code at that moment (an asset
--     filed under it by a concurrent write), it refuses and the whole rename
--     rolls back.
--   * 20261155 process_flows_guard runs for this function as for any writer
--     — a SECURITY DEFINER function does not change auth.uid(), so the
--     guard sees the controller who called it. Its endpoint check runs first
--     and unchanged: the new code is already a codebook unit (a.), so the
--     new unit end validates. Its person rule "a flow's endpoints are fixed"
--     would refuse d.; the ONE added block admits exactly this update and
--     nothing else: the transaction-local setting app.codebook_rename names
--     the org, a unit rename, the old and the new code (set by
--     rename_codebook_code around its writes and cleared right after; no
--     other migration sets it — pinned by test; PostgREST lets a client set
--     only request.* settings), the caller is in the controller tier, and
--     NOTHING but a unit end's ref changes, from the old code to the new
--     one. Every other update — a different column, a different code, an
--     asset end, another org, a type rename, no setting — meets the rules
--     exactly as before. The flow still
--     ends at the same Site Codebook unit, now spelled with its new code.
--
-- WIDENS: the controller tier gains renaming a code in place (counted
-- below) — a controller who also holds Viewer or Auditor does not (the
-- registry is read-only for them; counted below too). Nothing else gains: the version columns are written by triggers,
-- and the legend rule narrows. Pre-apply inventory (DEC-30) is a TEMP TABLE
-- captured BEFORE the transaction, aggregate counts only. Nothing existing
-- is rewritten (the new columns start at their defaults; NULL on assets).
-- Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check text, ok
-- boolean, n text) — the editor shows only the last result set. Idempotent.
--
-- Requires 20261128 (the guards), 20261138 (units.codebook_code),
-- 20261155 (process_flows_guard), 20261121 (the toggles save) and 20260814
-- (is_org_controller). PASTE / DEPLOY ORDER: either. Until it is pasted the
-- app keeps today's paths: the rename answers "needs migration 20261178"
-- (PGRST202 / 42883) and the codebook page says so, with today's way (add
-- the new code, refile its equipment, remove the old one); the server
-- re-decode works without it (it writes through the caller's own session,
-- as the Identity review does) and reads no version (42703 → none shown);
-- legend ids are checked by the app before it writes.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
-- A re-paste in the same session reads THIS paste's counts, never the first's.
DROP TABLE IF EXISTS pg_temp._intel_g78_before;
CREATE TEMP TABLE _intel_g78_before AS
SELECT 'Site Codebook units' AS what, COUNT(*) AS n FROM codebook_entries WHERE kind = 'unit'
UNION ALL
SELECT 'Site Codebook equipment types', COUNT(*) FROM codebook_entries WHERE kind = 'equipment_type'
UNION ALL
SELECT 'workspaces with a codebook_config row (each starts at codebook version 1)', COUNT(*) FROM codebook_config
UNION ALL
SELECT 'assets carrying a site code (no version recorded until the code is next written: NULL means written before 20261178)', COUNT(*)
  FROM assets WHERE code IS NOT NULL AND btrim(code) <> ''
UNION ALL
SELECT 'assets filed under a unit code the Site Codebook does not hold (a rename ONTO that code adopts them)', COUNT(*)
  FROM assets a
 WHERE a.unit_code IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM codebook_entries c WHERE c.org_id = a.org_id AND c.kind = 'unit' AND c.code = a.unit_code)
UNION ALL
SELECT 'process flows with a unit end (a rename of that unit rewrites them)', COUNT(*)
  FROM process_flows WHERE from_kind = 'unit' OR to_kind = 'unit'
UNION ALL
SELECT 'operational units mapped to a Site Codebook unit (units.codebook_code; a rename carries the mapping)', COUNT(*)
  FROM units WHERE codebook_code IS NOT NULL
UNION ALL
SELECT 'codebook legend ids that name no knowledge document of the same workspace (kept; only ids added from now on are checked)', COUNT(*)
  FROM codebook_config c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.legend_doc_ids) = 'array' THEN c.legend_doc_ids ELSE '[]'::jsonb END) e(v)
 WHERE NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.org_id = c.org_id AND k.id::text = lower(e.v #>> '{}'))
UNION ALL
SELECT 'library legend ids (ai_features.legendDocIds) that name no knowledge document of the same workspace (kept; only ids added from now on are checked)', COUNT(*)
  FROM knowledge_libraries l
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.ai_features -> 'legendDocIds') = 'array' THEN l.ai_features -> 'legendDocIds' ELSE '[]'::jsonb END) e(v)
 WHERE NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.org_id = l.org_id AND k.id::text = lower(e.v #>> '{}'))
UNION ALL
SELECT 'active members in the controller tier (Admin / DocCtrl by role or roles) holding no read-only role — they GAIN renaming a code in place', COUNT(*)
  FROM org_members
 WHERE status = 'active'
   AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
   AND NOT (role IN ('Viewer', 'Auditor') OR COALESCE(roles && ARRAY['Viewer', 'Auditor']::text[], false))
UNION ALL
SELECT 'active members in the controller tier who also hold Viewer or Auditor — the rename refuses them (the registry is read-only for them under 20261045)', COUNT(*)
  FROM org_members
 WHERE status = 'active'
   AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
   AND (role IN ('Viewer', 'Auditor') OR roles && ARRAY['Viewer', 'Auditor']::text[]);

BEGIN;

-- ── 1. CB-6: the codebook version ───────────────────────────────────────────
ALTER TABLE codebook_config  ADD COLUMN IF NOT EXISTS codebook_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE codebook_entries ADD COLUMN IF NOT EXISTS codebook_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE assets           ADD COLUMN IF NOT EXISTS codebook_version BIGINT;
COMMENT ON COLUMN codebook_config.codebook_version IS 'CB-6 (20261178): the org''s Site Codebook version; moves only forward — up when the code rule, the drawing-number map or an entry''s code / kind / tag prefixes change.';
COMMENT ON COLUMN codebook_entries.codebook_version IS 'CB-6 (20261178): the org codebook version this entry last changed in (1: unchanged since versioning began).';
COMMENT ON COLUMN assets.codebook_version IS 'CB-6 (20261178): the codebook version in force when this asset''s site code was last written (NULL: no code, or written before 20261178).';

-- ── 4a. ASK-8: the legend rule (one function, every writer that uses it) ────
-- Invoker rights: it reads knowledge_documents as the caller may (a
-- controller writes both settings), and the org predicate is explicit.
CREATE OR REPLACE FUNCTION assert_legend_doc_ids(p_org_id uuid, p_new jsonb, p_old jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_old jsonb := CASE WHEN jsonb_typeof(p_old) = 'array' THEN p_old ELSE '[]'::jsonb END;
  v_el  jsonb;
  v_id  text;
BEGIN
  IF p_new IS NULL OR jsonb_typeof(p_new) = 'null' THEN RETURN true; END IF;
  IF jsonb_typeof(p_new) <> 'array' THEN
    RAISE EXCEPTION 'legend_doc_ids_invalid: legend sheets are a list of knowledge document ids'
      USING ERRCODE = '22023';
  END IF;
  FOR v_el IN SELECT value FROM jsonb_array_elements(p_new) LOOP
    -- An id already stored is kept as it is: removing others never trips on it.
    IF v_old @> jsonb_build_array(v_el) THEN CONTINUE; END IF;
    v_id := CASE WHEN jsonb_typeof(v_el) = 'string' THEN v_el #>> '{}' END;
    IF v_id IS NULL OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'legend_doc_ids_invalid: % is not a knowledge document id', COALESCE(v_el::text, 'null')
        USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id = v_id::uuid AND k.org_id = p_org_id) THEN
      RAISE EXCEPTION 'legend_doc_ids_invalid: % is not a knowledge document of this workspace', v_id
        USING ERRCODE = '23503';
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION assert_legend_doc_ids(uuid, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION assert_legend_doc_ids(uuid, jsonb, jsonb) TO authenticated, service_role;

-- ── 1 + 4b. codebook_config: the version only moves forward; legend ids ─────
-- A PostgREST upsert fires BEFORE INSERT on the proposed row before ON
-- CONFLICT turns it into an UPDATE, so the INSERT arm compares the legend
-- with the row already stored (if any): the codebook page's save is an
-- upsert, and detaching one sheet must not trip on another kept one.
CREATE OR REPLACE FUNCTION codebook_config_version_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_base jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.codebook_version IS NULL OR NEW.codebook_version < 1 THEN NEW.codebook_version := 1; END IF;
    IF auth.uid() IS NOT NULL THEN
      v_base := (SELECT c.legend_doc_ids FROM codebook_config c WHERE c.org_id = NEW.org_id);
      PERFORM assert_legend_doc_ids(NEW.org_id, NEW.legend_doc_ids, COALESCE(v_base, '[]'::jsonb));
    END IF;
    RETURN NEW;
  END IF;
  -- The version only moves forward; a person cannot lower it.
  IF NEW.codebook_version IS NULL OR NEW.codebook_version < OLD.codebook_version THEN
    NEW.codebook_version := OLD.codebook_version;
  END IF;
  -- What derives a site code or decodes a drawing number changed: a new version.
  IF (NEW.iterable_rule IS DISTINCT FROM OLD.iterable_rule OR NEW.drawing_number IS DISTINCT FROM OLD.drawing_number)
     AND NEW.codebook_version = OLD.codebook_version THEN
    NEW.codebook_version := OLD.codebook_version + 1;
  END IF;
  -- ASK-8: a person adds only this workspace's knowledge documents as legend sheets.
  IF auth.uid() IS NOT NULL AND NEW.legend_doc_ids IS DISTINCT FROM OLD.legend_doc_ids THEN
    PERFORM assert_legend_doc_ids(NEW.org_id, NEW.legend_doc_ids, OLD.legend_doc_ids);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION codebook_config_version_guard() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_codebook_config_version_guard ON codebook_config;
CREATE TRIGGER trg_codebook_config_version_guard
  BEFORE INSERT OR UPDATE ON codebook_config
  FOR EACH ROW EXECUTE FUNCTION codebook_config_version_guard();

-- ── 1. codebook_entries: a change that derives differently is a new version ─
-- Fires after 20261128's two guards (trigger names sort code_digits <
-- guard_in_use < version_stamp), so a refused change bumps nothing (the
-- statement fails whole). An INSERT that ON CONFLICT will turn into an
-- UPDATE, or skip (a restore's DO NOTHING), is decided in its UPDATE arm, or
-- not at all. A person may create the org's codebook_config row (behaviour-
-- neutral: every reader treats a default row as no row); the service role
-- bumps an existing row only, once per org per transaction: a restore
-- statement that adds N entries is ONE new version (each later row of the
-- same transaction records the version the first one made).
CREATE OR REPLACE FUNCTION codebook_entries_version_stamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_org     uuid;
  v_version bigint;
  v_rename  text;
  v_bumped  text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.code IS NOT DISTINCT FROM OLD.code
     AND NEW.kind IS NOT DISTINCT FROM OLD.kind
     AND (NEW.meta -> 'tagPrefixes') IS NOT DISTINCT FROM (OLD.meta -> 'tagPrefixes') THEN
    -- A label, a pinned library, a knowledge binding, an id: no new version.
    NEW.codebook_version := OLD.codebook_version;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
       SELECT 1 FROM codebook_entries e
        WHERE e.id = NEW.id OR (e.org_id = NEW.org_id AND e.kind = NEW.kind AND e.code = NEW.code)) THEN
    RETURN NEW;
  END IF;
  -- CB-5: a rename is ONE new version. Its new code's insert bumped it; the
  -- old code's delete inside the same rename (rename_codebook_code's
  -- transaction-local setting names it) does not bump it again.
  IF TG_OP = 'DELETE' THEN
    v_rename := NULLIF(current_setting('app.codebook_rename', true), '');
    IF v_rename IS NOT NULL
       AND (v_rename::jsonb ->> 'org') = OLD.org_id::text
       AND (v_rename::jsonb ->> 'kind') = OLD.kind
       AND (v_rename::jsonb ->> 'old') = OLD.code THEN
      RETURN OLD;
    END IF;
  END IF;
  v_org := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  -- An org being deleted (its cascade) has no codebook left to version.
  IF EXISTS (SELECT 1 FROM orgs WHERE id = v_org) THEN
    IF auth.uid() IS NOT NULL THEN
      INSERT INTO codebook_config AS c (org_id, codebook_version) VALUES (v_org, 2)
      ON CONFLICT (org_id) DO UPDATE SET codebook_version = c.codebook_version + 1
      RETURNING c.codebook_version INTO v_version;
    ELSE
      -- The service role (an org restore, a fix in the SQL editor): ONE new
      -- version per org per transaction, however many rows it writes.
      v_bumped := COALESCE(current_setting('app.codebook_version_bumped', true), '');
      IF position(v_org::text IN v_bumped) > 0 THEN
        SELECT c.codebook_version INTO v_version FROM codebook_config c WHERE c.org_id = v_org;
      ELSE
        UPDATE codebook_config c SET codebook_version = c.codebook_version + 1
         WHERE c.org_id = v_org
        RETURNING c.codebook_version INTO v_version;
        IF FOUND THEN
          PERFORM set_config('app.codebook_version_bumped', v_bumped || v_org::text || ',', true);
        END IF;
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.codebook_version := COALESCE(v_version, NEW.codebook_version, 1);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION codebook_entries_version_stamp() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_codebook_entries_version_stamp ON codebook_entries;
CREATE TRIGGER trg_codebook_entries_version_stamp
  BEFORE INSERT OR UPDATE OR DELETE ON codebook_entries
  FOR EACH ROW EXECUTE FUNCTION codebook_entries_version_stamp();

-- ── 1. assets: the version a site code was written under ────────────────────
-- Every writer passes through it, so no app writer changes. The trigger's
-- name sorts after trg_assets_code_one_holder (20261128), which may drop a
-- service-role insert's code first: the stamp reads the code that lands.
CREATE OR REPLACE FUNCTION assets_codebook_version_stamp()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.code IS NOT DISTINCT FROM OLD.code THEN
    -- The stamp moves with the code only; a person cannot set it.
    IF auth.uid() IS NOT NULL THEN NEW.codebook_version := OLD.codebook_version; END IF;
    RETURN NEW;
  END IF;
  IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN
    NEW.codebook_version := NULL;
    RETURN NEW;
  END IF;
  -- An org restore (the service role) carries the version its backup recorded;
  -- one with no stamp (the Bridge; a pre-20261178 backup) takes the version in force.
  IF TG_OP = 'INSERT' AND auth.uid() IS NULL AND NEW.codebook_version IS NOT NULL THEN RETURN NEW; END IF;
  NEW.codebook_version := COALESCE((SELECT c.codebook_version FROM codebook_config c WHERE c.org_id = NEW.org_id), 1);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION assets_codebook_version_stamp() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_assets_codebook_version ON assets;
CREATE TRIGGER trg_assets_codebook_version
  BEFORE INSERT OR UPDATE OF code, codebook_version ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_codebook_version_stamp();

-- ── 3. process_flows_guard: 20261155's body plus the rename block ──────────
-- Re-created from its newest definition (20261155 — its only one), byte for
-- byte, plus `v_rename text;` and the CB-5 block before the person's UPDATE
-- rules (lib/__tests__/intelRoundGCodebookLifecycleMigration.test.ts cuts
-- them out and compares). CREATE OR REPLACE keeps trg_process_flows_guard
-- bound and the function's privileges as they were.
CREATE OR REPLACE FUNCTION process_flows_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_controller boolean;
  v_email      text;
  v_kind       text;
  v_ref        text;
  v_found      boolean;
  v_rename     text;
BEGIN
  -- 3. Endpoints exist — every writer, the service role included.
  IF TG_OP = 'INSERT'
     OR NEW.from_kind IS DISTINCT FROM OLD.from_kind OR NEW.from_ref IS DISTINCT FROM OLD.from_ref
     OR NEW.to_kind IS DISTINCT FROM OLD.to_kind OR NEW.to_ref IS DISTINCT FROM OLD.to_ref THEN
    IF NEW.from_kind = NEW.to_kind AND NEW.from_ref = NEW.to_ref THEN
      RAISE EXCEPTION 'process_flows_endpoint: a flow cannot start and end at the same %', NEW.from_kind
        USING ERRCODE = '23514';
    END IF;
    FOR v_kind, v_ref IN VALUES (NEW.from_kind, NEW.from_ref), (NEW.to_kind, NEW.to_ref) LOOP
      IF v_kind = 'asset' THEN
        v_found := false;
        IF v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          v_found := EXISTS (SELECT 1 FROM assets a WHERE a.id = v_ref::uuid AND a.org_id = NEW.org_id);
        END IF;
        IF NOT v_found THEN
          RAISE EXCEPTION 'process_flows_endpoint: equipment % is not in this workspace''s registry — a flow ends at registry equipment or a Site Codebook unit', v_ref
            USING ERRCODE = '23503';
        END IF;
      ELSE
        IF NOT EXISTS (SELECT 1 FROM codebook_entries c WHERE c.org_id = NEW.org_id AND c.kind = 'unit' AND c.code = v_ref) THEN
          RAISE EXCEPTION 'process_flows_endpoint: unit % is not a Site Codebook unit — a flow ends at registry equipment or a Site Codebook unit', v_ref
            USING ERRCODE = '23503';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF NEW.source_document_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)
     AND NOT EXISTS (SELECT 1 FROM knowledge_documents k WHERE k.id = NEW.source_document_id AND k.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'process_flows_source: the source document is not a knowledge document of this workspace'
      USING ERRCODE = '23503';
  END IF;

  -- The reader (the service role) and the org restore are not a person: the
  -- endpoint and source checks above bind them; the person rules below do not.
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  v_email := (SELECT m.email FROM org_members m
               WHERE m.org_id = NEW.org_id AND m.uid = v_uid AND m.status = 'active' LIMIT 1);

  IF TG_OP = 'INSERT' THEN
    -- 1. Provenance is the reader's.
    IF NEW.origin IS DISTINCT FROM 'manual' THEN
      RAISE EXCEPTION 'process_flows_origin: a flow read by the AI is written by the reader, never by a person'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.source_document_id IS NOT NULL OR NEW.source_page IS NOT NULL
       OR NEW.source_version_id IS NOT NULL OR NEW.evidence IS NOT NULL THEN
      RAISE EXCEPTION 'process_flows_provenance: where a flow was read is recorded by the reader, never by a person'
        USING ERRCODE = '42501';
    END IF;
    -- 1. A member's flow is a proposal; the controller tier's is confirmed.
    v_controller := is_org_controller(NEW.org_id);
    IF NOT v_controller THEN NEW.status := 'proposed'; END IF;
    -- 2. Stamped by the database.
    NEW.created_by := v_uid;
    NEW.created_by_name := v_email;
    NEW.created_at := now();
    IF NEW.status = 'proposed' THEN
      NEW.decided_by := NULL; NEW.decided_by_name := NULL; NEW.decided_at := NULL;
    ELSE
      NEW.decided_by := v_uid; NEW.decided_by_name := v_email; NEW.decided_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- CB-5 (20261178): the Site Codebook's own rename moves a unit end from
  -- the old code to the new code of the SAME unit. It passes here only
  -- inside rename_codebook_code's transaction (the one place this setting
  -- is set: transaction-local, cleared right after its writes; pinned by
  -- test), only for a unit rename and the controller tier, and only when
  -- nothing but a unit end's ref moves, from the renamed code to its new
  -- one. The endpoint check above has already run on the new code; every
  -- other UPDATE meets the rules below.
  v_rename := NULLIF(current_setting('app.codebook_rename', true), '');
  IF v_rename IS NOT NULL
     AND (v_rename::jsonb ->> 'org') = NEW.org_id::text
     AND (v_rename::jsonb ->> 'kind') = 'unit'
     AND is_org_controller(NEW.org_id)
     AND (to_jsonb(NEW) - 'from_ref' - 'to_ref') = (to_jsonb(OLD) - 'from_ref' - 'to_ref')
     AND (NEW.from_ref IS NOT DISTINCT FROM OLD.from_ref
          OR (NEW.from_kind = 'unit' AND OLD.from_ref = (v_rename::jsonb ->> 'old') AND NEW.from_ref = (v_rename::jsonb ->> 'new')))
     AND (NEW.to_ref IS NOT DISTINCT FROM OLD.to_ref
          OR (NEW.to_kind = 'unit' AND OLD.to_ref = (v_rename::jsonb ->> 'old') AND NEW.to_ref = (v_rename::jsonb ->> 'new'))) THEN
    RETURN NEW;
  END IF;

  -- UPDATE by a person. What a flow is, and where it was read, are fixed.
  -- One exception: the source may be CLEARED. Deleting the knowledge
  -- document a flow was read from runs the foreign key's ON DELETE SET NULL
  -- (20261017) as an UPDATE under the deleting person's session — refusing
  -- it would make every cited knowledge document, controlled document
  -- (20261122's cascade) and library undeletable. Setting or retargeting a
  -- source is still refused.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.from_kind IS DISTINCT FROM OLD.from_kind OR NEW.from_ref IS DISTINCT FROM OLD.from_ref
     OR NEW.to_kind IS DISTINCT FROM OLD.to_kind OR NEW.to_ref IS DISTINCT FROM OLD.to_ref
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR (NEW.source_document_id IS NOT NULL AND NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)
     OR NEW.source_page IS DISTINCT FROM OLD.source_page
     OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'process_flows_fixed: a flow''s endpoints, origin, source and author are fixed — remove it and draw it again'
      USING ERRCODE = '42501';
  END IF;
  -- 2. Deciding is the controller tier's, stamped by the database.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT is_org_controller(NEW.org_id) THEN
      RAISE EXCEPTION 'process_flows_decide: only a document controller confirms, dismisses or reopens a flow'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'proposed' THEN
      NEW.decided_by := NULL; NEW.decided_by_name := NULL; NEW.decided_at := NULL;
    ELSE
      NEW.decided_by := v_uid; NEW.decided_by_name := v_email; NEW.decided_at := now();
    END IF;
  ELSE
    NEW.decided_by := OLD.decided_by; NEW.decided_by_name := OLD.decided_by_name; NEW.decided_at := OLD.decided_at;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2. CB-5: rename a unit or equipment-type code in place ─────────────────
CREATE OR REPLACE FUNCTION rename_codebook_code(
  p_org_id   uuid,
  p_kind     text,
  p_old_code text,
  p_new_code text,
  p_dry_run  boolean DEFAULT false,
  p_expected jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_old           codebook_entries%ROWTYPE;
  v_new_id        uuid;
  v_old_code      text := btrim(COALESCE(p_old_code, ''));
  v_new_code      text := btrim(COALESCE(p_new_code, ''));
  v_filed         bigint := 0;
  v_coded         bigint := 0;
  v_flows         bigint := 0;
  v_units         bigint := 0;
  v_adopted       bigint := 0;
  v_adopted_flows bigint := 0;
  v_ambiguous     bigint := 0;
  v_ambiguous_new bigint := 0;
  v_taken         bigint := 0;
  v_flow_clash    bigint := 0;
  v_flow_loop     bigint := 0;
  v_unit_clash    bigint := 0;
  v_blockers      text[] := ARRAY[]::text[];
  v_counts        jsonb;
  v_email         text;
  v_role          text;
BEGIN
  -- DRLS-16: never a NULL uid. anon and the service role are refused — a
  -- rename is a person's act, recorded under their name.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'rename_codebook_code: sign in to rename a Site Codebook code'
      USING ERRCODE = '42501';
  END IF;
  IF p_org_id IS NULL OR NOT is_org_controller(p_org_id) THEN
    RAISE EXCEPTION 'rename_codebook_code: only Admin or Document Control can rename a Site Codebook code'
      USING ERRCODE = '42501';
  END IF;
  -- The rename rewrites the equipment registry with definer rights, so it
  -- meets the registry's own subtraction rule: 20261045's RESTRICTIVE
  -- assets_write_roles_update refuses a member holding Viewer or Auditor
  -- (deny-if-any), controller or not. What they cannot write directly they
  -- cannot rewrite through the rename.
  IF caller_holds_any_role(p_org_id, ARRAY['Viewer','Auditor']::text[]) THEN
    RAISE EXCEPTION 'rename_codebook_code: you also hold a read-only role (Viewer / Auditor), so the equipment registry is read-only for you and a rename, which rewrites it, is refused — remove that role first'
      USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('unit', 'equipment_type') THEN
    RAISE EXCEPTION 'rename_codebook_code: only a unit or an equipment-type code is renamed in place (a drawing-type code is referenced by nothing stored)'
      USING ERRCODE = '22023';
  END IF;
  IF v_new_code !~ '^[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'codebook_entries_code_digits: % code "%" is not 1-6 digits', p_kind, v_new_code
      USING ERRCODE = '23514';
  END IF;
  IF v_new_code = v_old_code THEN
    RAISE EXCEPTION 'rename_codebook_code: the new code is the same as the old one'
      USING ERRCODE = '22023';
  END IF;

  -- One rename at a time per org; the entry is locked for the transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('rename_codebook_code:' || p_org_id::text, 0));
  SELECT * INTO v_old FROM codebook_entries
   WHERE org_id = p_org_id AND kind = p_kind AND code = v_old_code
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rename_codebook_code: % % is not in the Site Codebook', p_kind, v_old_code
      USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM codebook_entries WHERE org_id = p_org_id AND kind = p_kind AND code = v_new_code) THEN
    RAISE EXCEPTION 'rename_codebook_code: % % already exists — a code is renamed onto a free code only', p_kind, v_new_code
      USING ERRCODE = '23505';
  END IF;

  -- What the rename touches (the dry run stops after this).
  IF p_kind = 'unit' THEN
    SELECT COUNT(*) INTO v_filed FROM assets a WHERE a.org_id = p_org_id AND a.unit_code = v_old_code;
    SELECT COUNT(*) INTO v_coded FROM assets a
     WHERE a.org_id = p_org_id AND a.code IS NOT NULL
       AND EXISTS (SELECT 1 FROM codebook_entries t
                    WHERE t.org_id = p_org_id AND t.kind = 'equipment_type'
                      AND split_part(a.code, '.', 1) = v_old_code || t.code);
    SELECT COUNT(*) INTO v_ambiguous FROM assets a
     WHERE a.org_id = p_org_id AND a.code IS NOT NULL
       AND EXISTS (SELECT 1 FROM codebook_entries t
                    WHERE t.org_id = p_org_id AND t.kind = 'equipment_type'
                      AND split_part(a.code, '.', 1) = v_old_code || t.code)
       AND EXISTS (SELECT 1 FROM codebook_entries u2 JOIN codebook_entries t2
                     ON t2.org_id = u2.org_id AND t2.kind = 'equipment_type'
                    WHERE u2.org_id = p_org_id AND u2.kind = 'unit' AND u2.code <> v_old_code
                      AND split_part(a.code, '.', 1) = u2.code || t2.code);
    -- A rewritten head that would ALSO read as another unit and type.
    SELECT COUNT(*) INTO v_ambiguous_new FROM assets a
     WHERE a.org_id = p_org_id AND a.code IS NOT NULL
       AND EXISTS (SELECT 1 FROM codebook_entries t
                    WHERE t.org_id = p_org_id AND t.kind = 'equipment_type'
                      AND split_part(a.code, '.', 1) = v_old_code || t.code)
       AND EXISTS (SELECT 1 FROM codebook_entries u2 JOIN codebook_entries t2
                     ON t2.org_id = u2.org_id AND t2.kind = 'equipment_type'
                    WHERE u2.org_id = p_org_id AND u2.kind = 'unit' AND u2.code <> v_old_code
                      AND v_new_code || substr(split_part(a.code, '.', 1), length(v_old_code) + 1) = u2.code || t2.code);
    SELECT COUNT(*) INTO v_taken FROM assets a
     WHERE a.org_id = p_org_id AND a.code IS NOT NULL
       AND EXISTS (SELECT 1 FROM codebook_entries t
                    WHERE t.org_id = p_org_id AND t.kind = 'equipment_type'
                      AND split_part(a.code, '.', 1) = v_old_code || t.code)
       AND EXISTS (SELECT 1 FROM assets b
                    WHERE b.org_id = a.org_id AND b.id <> a.id
                      AND b.code = v_new_code || substr(a.code, length(v_old_code) + 1));
    SELECT COUNT(*) INTO v_flows FROM process_flows f
     WHERE f.org_id = p_org_id
       AND ((f.from_kind = 'unit' AND f.from_ref = v_old_code) OR (f.to_kind = 'unit' AND f.to_ref = v_old_code));
    -- A flow that would start and end at the new code: one between the two
    -- codes, or a legacy row (before 20261155's endpoint check) looping at the old one.
    SELECT COUNT(*) INTO v_flow_loop FROM process_flows f
     WHERE f.org_id = p_org_id AND f.from_kind = 'unit' AND f.to_kind = 'unit'
       AND ((f.from_ref = v_old_code AND f.to_ref = v_new_code) OR (f.from_ref = v_new_code AND f.to_ref = v_old_code)
            OR (f.from_ref = v_old_code AND f.to_ref = v_old_code));
    SELECT COUNT(*) INTO v_flow_clash FROM process_flows f
     WHERE f.org_id = p_org_id
       AND ((f.from_kind = 'unit' AND f.from_ref = v_old_code) OR (f.to_kind = 'unit' AND f.to_ref = v_old_code))
       AND EXISTS (SELECT 1 FROM process_flows g
                    WHERE g.org_id = f.org_id AND g.id <> f.id
                      AND g.from_kind = f.from_kind AND g.to_kind = f.to_kind
                      AND g.from_ref = CASE WHEN f.from_kind = 'unit' AND f.from_ref = v_old_code THEN v_new_code ELSE f.from_ref END
                      AND g.to_ref = CASE WHEN f.to_kind = 'unit' AND f.to_ref = v_old_code THEN v_new_code ELSE f.to_ref END);
    SELECT COUNT(*) INTO v_units FROM units u WHERE u.org_id = p_org_id AND u.codebook_code = v_old_code;
    -- The new code's mapping held by another operational unit: 20261138's
    -- projection would move everything filed under the old code into it,
    -- whether or not the old code is mapped itself.
    SELECT COUNT(*) INTO v_unit_clash FROM units u WHERE u.org_id = p_org_id AND u.codebook_code = v_new_code;
    SELECT COUNT(*) INTO v_adopted FROM assets a WHERE a.org_id = p_org_id AND a.unit_code = v_new_code;
    SELECT COUNT(*) INTO v_adopted_flows FROM process_flows f
     WHERE f.org_id = p_org_id
       AND ((f.from_kind = 'unit' AND f.from_ref = v_new_code) OR (f.to_kind = 'unit' AND f.to_ref = v_new_code));
  ELSE
    SELECT COUNT(*) INTO v_coded FROM assets a
     WHERE a.org_id = p_org_id AND a.code IS NOT NULL
       AND EXISTS (SELECT 1 FROM codebook_entries u
                    WHERE u.org_id = p_org_id AND u.kind = 'unit'
                      AND split_part(a.code, '.', 1) = u.code || v_old_code);
    SELECT COUNT(*) INTO v_ambiguous FROM assets a
     WHERE a.org_id = p_org_id AND a.code IS NOT NULL
       AND EXISTS (SELECT 1 FROM codebook_entries u
                    WHERE u.org_id = p_org_id AND u.kind = 'unit'
                      AND split_part(a.code, '.', 1) = u.code || v_old_code)
       AND EXISTS (SELECT 1 FROM codebook_entries u2 JOIN codebook_entries t2
                     ON t2.org_id = u2.org_id AND t2.kind = 'equipment_type'
                    WHERE u2.org_id = p_org_id AND u2.kind = 'unit' AND t2.code <> v_old_code
                      AND split_part(a.code, '.', 1) = u2.code || t2.code);
    -- A rewritten head that would ALSO read as another unit and type.
    SELECT COUNT(*) INTO v_ambiguous_new FROM assets a JOIN codebook_entries u
       ON u.org_id = a.org_id AND u.kind = 'unit' AND split_part(a.code, '.', 1) = u.code || v_old_code
     WHERE a.org_id = p_org_id
       AND EXISTS (SELECT 1 FROM codebook_entries u2 JOIN codebook_entries t2
                     ON t2.org_id = u2.org_id AND t2.kind = 'equipment_type'
                    WHERE u2.org_id = p_org_id AND u2.kind = 'unit' AND t2.code <> v_old_code
                      AND u.code || v_new_code = u2.code || t2.code);
    SELECT COUNT(*) INTO v_taken FROM assets a JOIN codebook_entries u
       ON u.org_id = a.org_id AND u.kind = 'unit' AND split_part(a.code, '.', 1) = u.code || v_old_code
     WHERE a.org_id = p_org_id
       AND EXISTS (SELECT 1 FROM assets b
                    WHERE b.org_id = a.org_id AND b.id <> a.id
                      AND b.code = u.code || v_new_code || substr(a.code, length(u.code) + length(v_old_code) + 1));
  END IF;

  IF v_ambiguous > 0 THEN
    v_blockers := v_blockers || format('%s site code(s) read both as %s %s and as another unit and type — resolve those codes first (Operating areas → Identity review)', v_ambiguous, p_kind, v_old_code);
  END IF;
  IF v_ambiguous_new > 0 THEN
    v_blockers := v_blockers || format('%s site code(s) would read, once renamed, both as %s %s and as another unit and type — the codebook could no longer decode them; choose another code', v_ambiguous_new, p_kind, v_new_code);
  END IF;
  IF v_taken > 0 THEN
    v_blockers := v_blockers || format('%s renamed site code(s) are already carried by another asset — one site code is one asset; resolve them first', v_taken);
  END IF;
  IF v_flow_loop > 0 THEN
    v_blockers := v_blockers || format('%s process flow(s) would start and end at the same unit once %s becomes %s — remove them first', v_flow_loop, v_old_code, v_new_code);
  END IF;
  IF v_flow_clash > 0 THEN
    v_blockers := v_blockers || format('%s process flow(s) would duplicate a flow already ending at %s — remove the duplicate first', v_flow_clash, v_new_code);
  END IF;
  IF v_unit_clash > 0 THEN
    v_blockers := v_blockers || format('%s is already mapped to another operational unit, and everything filed under %s would move into it — clear that mapping first (Operational scope)', v_new_code, v_old_code);
  END IF;

  v_counts := jsonb_build_object(
    'kind', p_kind, 'from', v_old_code, 'to', v_new_code, 'label', v_old.label,
    'assetsFiled', v_filed, 'assetsCoded', v_coded, 'flows', v_flows, 'unitMappings', v_units,
    'adopted', v_adopted, 'adoptedFlows', v_adopted_flows,
    'blockers', to_jsonb(v_blockers));
  IF p_dry_run THEN RETURN v_counts; END IF;

  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION 'rename_codebook_code: %', v_blockers[1]
      USING ERRCODE = '23514';
  END IF;
  -- Preview = apply: the counts a person confirmed are the counts written.
  IF p_expected IS NOT NULL
     AND (v_counts - 'kind' - 'from' - 'to' - 'label' - 'blockers')
         IS DISTINCT FROM (p_expected - 'kind' - 'from' - 'to' - 'label' - 'blockers') THEN
    RAISE EXCEPTION 'rename_codebook_code: what this rename touches changed since the preview — preview it again'
      USING ERRCODE = '40001';
  END IF;

  -- The rename's writes run inside this transaction-local setting: it lets
  -- process_flows_guard's CB-5 block admit d. (a unit rename only), and the
  -- version stamp count the rename as ONE new version (e. bumps nothing).
  PERFORM set_config('app.codebook_rename',
                     jsonb_build_object('org', p_org_id::text, 'kind', p_kind, 'old', v_old_code, 'new', v_new_code)::text, true);

  -- a. The new code, as a row of its own (the digit guard checks it).
  INSERT INTO codebook_entries (org_id, kind, code, label, meta, sort, origin, created_by, created_at, updated_at)
  VALUES (v_old.org_id, v_old.kind, v_new_code, v_old.label, v_old.meta, v_old.sort, v_old.origin, v_old.created_by, v_old.created_at, now())
  RETURNING id INTO v_new_id;

  IF p_kind = 'unit' THEN
    -- b. The filing, and the unit part of the site code.
    UPDATE assets a
       SET unit_code = CASE WHEN a.unit_code = v_old_code THEN v_new_code ELSE a.unit_code END,
           code = CASE WHEN a.code IS NOT NULL
                        AND EXISTS (SELECT 1 FROM codebook_entries t
                                     WHERE t.org_id = p_org_id AND t.kind = 'equipment_type'
                                       AND split_part(a.code, '.', 1) = v_old_code || t.code)
                       THEN v_new_code || substr(a.code, length(v_old_code) + 1)
                       ELSE a.code END,
           updated_by = v_uid, updated_at = now()
     WHERE a.org_id = p_org_id
       AND (a.unit_code = v_old_code
            OR (a.code IS NOT NULL
                AND EXISTS (SELECT 1 FROM codebook_entries t
                             WHERE t.org_id = p_org_id AND t.kind = 'equipment_type'
                               AND split_part(a.code, '.', 1) = v_old_code || t.code)));
    -- c. The operational unit mapped to it (20261138's triggers move unit_id).
    UPDATE units SET codebook_code = v_new_code WHERE org_id = p_org_id AND codebook_code = v_old_code;
    -- d. Unit ends: admitted by process_flows_guard's CB-5 block only while
    --    the setting names this org, a unit rename and these two codes.
    UPDATE process_flows
       SET from_ref = CASE WHEN from_kind = 'unit' AND from_ref = v_old_code THEN v_new_code ELSE from_ref END,
           to_ref   = CASE WHEN to_kind = 'unit' AND to_ref = v_old_code THEN v_new_code ELSE to_ref END
     WHERE org_id = p_org_id
       AND ((from_kind = 'unit' AND from_ref = v_old_code) OR (to_kind = 'unit' AND to_ref = v_old_code));
  ELSE
    -- b. The type part of the site code.
    UPDATE assets a
       SET code = u.code || v_new_code || substr(a.code, length(u.code) + length(v_old_code) + 1),
           updated_by = v_uid, updated_at = now()
      FROM codebook_entries u
     WHERE a.org_id = p_org_id AND a.code IS NOT NULL
       AND u.org_id = p_org_id AND u.kind = 'unit'
       AND split_part(a.code, '.', 1) = u.code || v_old_code;
  END IF;

  -- e. Nothing references the old code now: 20261128's guard counts zero.
  DELETE FROM codebook_entries WHERE id = v_old.id;
  PERFORM set_config('app.codebook_rename', '', true);
  -- f. The entry keeps its identity.
  UPDATE codebook_entries SET id = v_old.id WHERE id = v_new_id;

  SELECT m.email, array_to_string(COALESCE(m.roles, ARRAY[m.role]), ', ') INTO v_email, v_role
    FROM org_members m WHERE m.org_id = p_org_id AND m.uid = v_uid AND m.status = 'active' LIMIT 1;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
  VALUES ('CODEBOOK_CODE_RENAMED', 'codebook_entry', v_old.id::text, p_org_id, v_uid, v_email, v_role,
          v_counts - 'blockers');
  RETURN v_counts;
END;
$$;
REVOKE ALL ON FUNCTION rename_codebook_code(uuid, text, text, text, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rename_codebook_code(uuid, text, text, text, boolean, jsonb) TO authenticated;

-- ── 4c. ASK-8: the library toggles save checks legend ids it adds ──────────
-- Re-created from its newest definition (20261121) plus ONE line: the CASE
-- keeps the check on the library being saved only. Invoker rights, as
-- before: the caller's RLS still decides whether the row is written.
CREATE OR REPLACE FUNCTION knowledge_library_save_ai_features(p_library_id UUID, p_features JSONB)
RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = public
AS $$
  WITH u AS (
    UPDATE knowledge_libraries l
       SET ai_features = (COALESCE(p_features, '{}'::jsonb) - 'embedBuild')
                         || CASE WHEN l.ai_features ? 'embedBuild'
                                 THEN jsonb_build_object('embedBuild', l.ai_features -> 'embedBuild')
                                 ELSE '{}'::jsonb END
     WHERE l.id = p_library_id
       AND CASE WHEN l.id = p_library_id THEN assert_legend_doc_ids(l.org_id, p_features -> 'legendDocIds', l.ai_features -> 'legendDocIds') ELSE false END
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION knowledge_library_save_ai_features(UUID, JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION knowledge_library_save_ai_features(UUID, JSONB) TO authenticated;

-- ── 4d. ASK-8: a person's direct write of a library's legend ids, too ──────
-- knowledge_libraries_write lets a controller UPDATE the row through
-- PostgREST without the save function. Refuses only; changes nothing.
CREATE OR REPLACE FUNCTION knowledge_libraries_legend_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM assert_legend_doc_ids(NEW.org_id, NEW.ai_features -> 'legendDocIds', '[]'::jsonb);
  ELSIF (NEW.ai_features -> 'legendDocIds') IS DISTINCT FROM (OLD.ai_features -> 'legendDocIds') THEN
    PERFORM assert_legend_doc_ids(NEW.org_id, NEW.ai_features -> 'legendDocIds', OLD.ai_features -> 'legendDocIds');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION knowledge_libraries_legend_guard() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_knowledge_libraries_legend_guard ON knowledge_libraries;
CREATE TRIGGER trg_knowledge_libraries_legend_guard
  BEFORE INSERT OR UPDATE OF ai_features ON knowledge_libraries
  FOR EACH ROW EXECUTE FUNCTION knowledge_libraries_legend_guard();

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'codebook_config / codebook_entries / assets carry codebook_version (CB-6)' AS "check",
       (SELECT COUNT(*) = 3 FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'codebook_version'
           AND table_name IN ('codebook_config', 'codebook_entries', 'assets')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'trg_codebook_config_version_guard: the version moves only forward, a code-rule or drawing-number change is a new version, a person adds only this workspace''s knowledge documents as legend sheets; search_path pinned',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_codebook_config_version_guard'
                AND tgrelid = 'codebook_config'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%NEW.codebook_version := OLD.codebook_version + 1;%'
                   AND prosrc LIKE '%IF NEW.codebook_version IS NULL OR NEW.codebook_version < OLD.codebook_version THEN%'
                   AND prosrc LIKE '%PERFORM assert_legend_doc_ids(NEW.org_id, NEW.legend_doc_ids, OLD.legend_doc_ids);%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'codebook_config_version_guard'),
       NULL
UNION ALL
SELECT 'trg_codebook_entries_version_stamp: an entry added, removed, re-coded or re-prefixed is a new version (fires after 20261128''s guards), a rename is one; the service role never creates a config row and bumps at most once per org per transaction',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_codebook_entries_version_stamp'
                AND tgrelid = 'codebook_entries'::regclass AND NOT tgisinternal)
       AND 'trg_codebook_entries_version_stamp' COLLATE "C" > 'trg_codebook_entries_guard_in_use'
       AND (SELECT prosrc LIKE '%(NEW.meta -> ''tagPrefixes'') IS NOT DISTINCT FROM (OLD.meta -> ''tagPrefixes'')%'
                   AND prosrc LIKE '%ON CONFLICT (org_id) DO UPDATE SET codebook_version = c.codebook_version + 1%'
                   AND prosrc LIKE '%IF auth.uid() IS NOT NULL THEN%'
                   AND prosrc LIKE '%AND (v_rename::jsonb ->> ''old'') = OLD.code THEN%'
                   AND prosrc LIKE '%PERFORM set_config(''app.codebook_version_bumped'', v_bumped || v_org::text || '','', true);%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'codebook_entries_version_stamp'),
       NULL
UNION ALL
SELECT 'trg_assets_codebook_version: every writer''s site code records the version it was written under; a person cannot set it; it fires after trg_assets_code_one_holder',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assets_codebook_version'
                AND tgrelid = 'assets'::regclass AND NOT tgisinternal)
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assets_code_one_holder'
                    AND tgrelid = 'assets'::regclass AND NOT tgisinternal)
       AND 'trg_assets_codebook_version' COLLATE "C" > 'trg_assets_code_one_holder'
       AND (SELECT prosrc LIKE '%IF auth.uid() IS NOT NULL THEN NEW.codebook_version := OLD.codebook_version; END IF;%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'assets_codebook_version_stamp'),
       NULL
UNION ALL
SELECT 'rename_codebook_code: SECURITY DEFINER, search_path pinned, refuses a NULL uid, anyone outside is_org_controller and a controller holding Viewer / Auditor (20261045''s deny-if-any on the registry), one transaction, sets app.codebook_rename only around its own writes, refuses a code that would read two ways',
       (SELECT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%IF v_uid IS NULL THEN%'
               AND prosrc LIKE '%NOT is_org_controller(p_org_id)%'
               AND prosrc LIKE '%IF caller_holds_any_role(p_org_id, ARRAY[''Viewer'',''Auditor'']::text[]) THEN%'
               AND prosrc LIKE '%PERFORM set_config(''app.codebook_rename'', '''', true);%'
               AND prosrc LIKE '%DELETE FROM codebook_entries WHERE id = v_old.id;%'
               AND prosrc LIKE '%would read, once renamed, both as%'
               AND prosrc LIKE '%IF v_unit_clash > 0 THEN%'
               AND prosrc LIKE '%OR (f.from_ref = v_old_code AND f.to_ref = v_old_code));%'
          FROM pg_proc WHERE proname = 'rename_codebook_code'),
       NULL
UNION ALL
SELECT 'rename_codebook_code: EXECUTE for authenticated only — not anon, not PUBLIC (DRLS-16)',
       has_function_privilege('authenticated', 'rename_codebook_code(uuid, text, text, text, boolean, jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'rename_codebook_code(uuid, text, text, text, boolean, jsonb)', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                        WHERE p.proname = 'rename_codebook_code' AND a.grantee = 0),
       NULL
UNION ALL
SELECT 'process_flows_guard: 20261155''s rules intact (endpoints for every writer, fixed columns, decisions stamped), not SECURITY DEFINER, search_path pinned, plus the CB-5 rename block',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_process_flows_guard'
                AND tgrelid = 'process_flows'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%process_flows_endpoint%'
                   AND prosrc LIKE '%c.kind = ''unit'' AND c.code = v_ref%'
                   AND prosrc LIKE '%process_flows_fixed%'
                   AND prosrc LIKE '%process_flows_decide%'
                   AND prosrc LIKE '%IF NOT v_controller THEN NEW.status := ''proposed''; END IF;%'
                   AND prosrc LIKE '%OR (NEW.source_document_id IS NOT NULL AND NEW.source_document_id IS DISTINCT FROM OLD.source_document_id)%'
                   AND prosrc LIKE '%IF v_uid IS NULL THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%v_rename := NULLIF(current_setting(''app.codebook_rename'', true), '''');%'
                   AND prosrc LIKE '%AND (v_rename::jsonb ->> ''kind'') = ''unit''%'
                   AND prosrc LIKE '%AND (to_jsonb(NEW) - ''from_ref'' - ''to_ref'') = (to_jsonb(OLD) - ''from_ref'' - ''to_ref'')%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'process_flows_guard'),
       NULL
UNION ALL
SELECT '20261128 §6 trg_codebook_entries_guard_in_use still installed and unchanged (the rename passes it; it is not re-created here)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_codebook_entries_guard_in_use'
                AND tgrelid = 'codebook_entries'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%codebook_entries_in_use:%'
                   AND prosrc LIKE '%IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN%'
              FROM pg_proc WHERE proname = 'codebook_entries_guard_in_use'),
       NULL
UNION ALL
SELECT 'assert_legend_doc_ids: invoker rights, search_path pinned, an added id must be uuid-shaped and a knowledge document of the org; not executable by anon',
       (SELECT NOT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%k.id = v_id::uuid AND k.org_id = p_org_id%'
               AND prosrc LIKE '%IF v_old @> jsonb_build_array(v_el) THEN CONTINUE; END IF;%'
          FROM pg_proc WHERE proname = 'assert_legend_doc_ids')
       AND NOT has_function_privilege('anon', 'assert_legend_doc_ids(uuid, jsonb, jsonb)', 'EXECUTE')
       AND has_function_privilege('authenticated', 'assert_legend_doc_ids(uuid, jsonb, jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'knowledge_library_save_ai_features: replaces the toggles, keeps embedBuild, checks legend ids it adds; invoker, search_path pinned, authenticated only',
       (SELECT NOT prosecdef
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
               AND prosrc LIKE '%AND CASE WHEN l.id = p_library_id THEN assert_legend_doc_ids(l.org_id, p_features -> ''legendDocIds'', l.ai_features -> ''legendDocIds'') ELSE false END%'
               AND prosrc LIKE '%THEN jsonb_build_object(''embedBuild'', l.ai_features -> ''embedBuild'')%'
          FROM pg_proc WHERE proname = 'knowledge_library_save_ai_features')
       AND has_function_privilege('authenticated', 'knowledge_library_save_ai_features(uuid, jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'knowledge_library_save_ai_features(uuid, jsonb)', 'EXECUTE'),
       NULL
UNION ALL
SELECT 'trg_knowledge_libraries_legend_guard: a person''s direct write of a library''s legend ids meets the same rule; the service role passes; 20261121''s embedBuild guard still installed',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_knowledge_libraries_legend_guard'
                AND tgrelid = 'knowledge_libraries'::regclass AND NOT tgisinternal)
       AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_knowledge_libraries_embed_build_guard'
                    AND tgrelid = 'knowledge_libraries'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                   AND prosrc LIKE '%PERFORM assert_legend_doc_ids(NEW.org_id, NEW.ai_features -> ''legendDocIds'', OLD.ai_features -> ''legendDocIds'');%'
                   AND NOT prosecdef
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'knowledge_libraries_legend_guard'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g78_before
UNION ALL
SELECT 'inventory (after): workspaces at codebook version 1 (no versioned change yet)', NULL,
       (SELECT COUNT(*) FROM codebook_config WHERE codebook_version = 1)::text
UNION ALL
SELECT 'inventory (after): assets whose site code records a codebook version (0 on the first paste)', NULL,
       (SELECT COUNT(*) FROM assets WHERE codebook_version IS NOT NULL)::text;
