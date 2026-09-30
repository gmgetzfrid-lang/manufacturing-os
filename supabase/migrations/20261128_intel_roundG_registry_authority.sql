-- ─────────────────────────────────────────────────────────────────────────────
-- intelligence Round G (I-10) — write authority on the equipment registry and
-- the codec's invariants at the database.
--
-- What is ALREADY live and is only verified here (probes below):
--   * 20261045 (R&P DEC-17) — RESTRICTIVE write overlays on assets /
--     asset_types / asset_photos / asset_files: INSERT and UPDATE by the
--     registry writer tier (Admin, DocCtrl, Manager, Supervisor — by the role
--     COLLECTION), the whiteboard-flip carve-out for working members confined
--     to its columns by assets_guard_registry. Reads unchanged (members).
--   * 20261046 (R&P ADD-4) — codebook_entries_write, codebook_config_write and
--     org_ai_instructions_write read caller_holds_any_role(org_id, Admin +
--     DocCtrl): the additive-role-aware controller bar, identical to
--     is_org_controller (CB-4 / IRLS-10 roles[] half).
--   * 20261020 (R&P DB-6) — is_org_controller pins search_path (IRLS-10).
--
-- What this file changes:
--   1. AREA-1 / IRLS-5 — DELETE on assets, asset_types and asset_photos is
--      the CONTROLLER tier (is_org_controller) — photos follow the asset. The
--      writer tier keeps create/edit and archives instead of deleting
--      (assets.archived); a deletion cascades into photos, aliases, mentions
--      and file links, so it is a controller act. asset_files (a document
--      link, not a registry record) keeps the writer tier.
--   2. IRLS-5 — every person-initiated asset DELETE writes an ASSET_DELETED
--      audit_logs row in the same transaction (AFTER DELETE trigger; the
--      service role's cascades — org purge, restore — are not a person's act).
--   3. CB-2 / IRLS-8 — document_equipment_suggestions (the Bridge's proposal
--      and applied ledger) is written by the service role (every app writer)
--      and controllers only; members keep SELECT.
--   4. CB-3 — codebook codes for units and equipment types are 1–6 digits:
--      the codec composes and inverts site codes digit by digit, so a letter
--      code is write-only. A BEFORE INSERT OR UPDATE OF code, kind trigger
--      refuses a NEW letter code (an insert, or an edit that changes the
--      code); a legacy letter-coded row stays fully usable otherwise — relabel,
--      pinned libraries, knowledge binding (a NOT VALID CHECK would bind every
--      UPDATE of such a row, meta-only ones included). The CHECK itself is
--      added, validated, only when no legacy row violates it (the inventory
--      says which world you are in; nothing is rewritten or deleted).
--   5. CB-10 — one site code is one asset: a UNIQUE partial index on
--      assets (org_id, code) for non-blank codes, created only when no org
--      carries a duplicate today (otherwise the plain index stays and the
--      inventory counts the duplicates to resolve first; nothing is rewritten).
--      App writers treat a DERIVED code as optional (lib/assets.ts
--      codeOptional: the importer, the bulk filer). HANDED TO I-11: the
--      Bridge's discovery insert and unit backfill (lib/equipmentBridgeServer.ts)
--      must retry without `code` on this index and write unit_code apart from
--      code — until then a colliding discovered tag is not created.
--   6. CB-5 — a unit or equipment type that registry equipment (its filing,
--      or the unit / type part of a stored site code) or a process flow still
--      references cannot be removed or re-coded by a person: a BEFORE DELETE
--      OR UPDATE OF code, kind trigger refuses with the counts (the service
--      role's cascades — org purge, restore — pass).
--
-- NARROWS (Manager / Supervisor lose DELETE on three registry tables; members
-- lose write on the Bridge ledger); nobody gains. Pre-apply inventory
-- (DEC-30) is captured into a TEMP TABLE before the transaction: aggregate
-- counts only. Single paste: inventory → BEGIN/DDL/COMMIT → ONE SELECT (check
-- text, ok boolean, n text) — the editor shows only the last result. Every
-- SECURITY DEFINER function pins SET search_path = public. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Pre-apply inventory (aggregate only; captured BEFORE the DDL) ───────────
CREATE TEMP TABLE IF NOT EXISTS _intel_g28_before AS
SELECT 'active members holding Manager or Supervisor but neither Admin nor DocCtrl (lose asset / type / photo DELETE)' AS what, COUNT(*) AS n
  FROM org_members
 WHERE status = 'active'
   AND (role IN ('Manager', 'Supervisor') OR roles && ARRAY['Manager', 'Supervisor']::text[])
   AND NOT (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
UNION ALL
SELECT 'active members who are not controllers (lose write on document_equipment_suggestions)', COUNT(*)
  FROM org_members
 WHERE status = 'active'
   AND NOT (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
UNION ALL
SELECT 'document_equipment_suggestions rows', COUNT(*) FROM document_equipment_suggestions
UNION ALL
SELECT 'codebook unit / equipment-type codes that are not 1-6 digits (CB-3: no CHECK while > 0 — the trigger binds new codes; each stays usable until replaced)', COUNT(*)
  FROM codebook_entries WHERE kind IN ('unit', 'equipment_type') AND code !~ '^[0-9]{1,6}$'
UNION ALL
SELECT 'assets sharing a non-blank site code with another asset of the same org (CB-10: no unique index while > 0)', COUNT(*)
  FROM assets a
 WHERE a.code IS NOT NULL AND btrim(a.code) <> ''
   AND EXISTS (SELECT 1 FROM assets b WHERE b.org_id = a.org_id AND b.code = a.code AND b.id <> a.id)
UNION ALL
SELECT 'archived assets (the writer tier''s soft delete)', COUNT(*) FROM assets WHERE archived;

BEGIN;

-- ── 1. AREA-1 / IRLS-5: DELETE is the controller tier (photos follow) ───────
-- The 20261045 overlays for INSERT / UPDATE are untouched; only the DELETE
-- overlay is re-created, from the same format, with the controller predicate.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assets','asset_types','asset_photos'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write_roles_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (%s)', t || '_write_roles_delete', t, 'is_org_controller(org_id)');
  END LOOP;
END $$;

-- ── 2. IRLS-5: a person's asset deletion is on the record ───────────────────
CREATE OR REPLACE FUNCTION assets_audit_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text;
  v_role  text;
BEGIN
  -- The service role's cascades (org purge, restore) are not a person's act
  -- and write their own trail; an org already gone has nowhere to record.
  IF auth.uid() IS NULL THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN RETURN OLD; END IF;
  -- The actor's FULL role collection is recorded (display only — the
  -- DELETE overlay already decided authority).
  SELECT email, array_to_string(COALESCE(roles, ARRAY[role]), ', ') INTO v_email, v_role FROM org_members
   WHERE org_id = OLD.org_id AND uid = auth.uid() AND status = 'active' LIMIT 1;
  INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
  VALUES ('ASSET_DELETED', 'asset', OLD.id::text, OLD.org_id, auth.uid(), v_email, v_role,
          jsonb_build_object('tag', OLD.tag, 'code', OLD.code, 'unit_code', OLD.unit_code,
                             'origin', OLD.origin, 'discovered_from', OLD.discovered_from,
                             'via', 'delete'));
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_assets_audit_delete ON assets;
CREATE TRIGGER trg_assets_audit_delete
  AFTER DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_audit_delete();

-- ── 3. CB-2 / IRLS-8: the Bridge ledger is service role + controllers ───────
-- Same policy name and shape as 20260928; only the predicate changes. Every
-- app writer (upsertSuggestions, the apply status update) is service-role.
DROP POLICY IF EXISTS doc_equip_sugg_write ON document_equipment_suggestions;
CREATE POLICY doc_equip_sugg_write ON document_equipment_suggestions FOR ALL
  USING (is_org_controller(org_id))
  WITH CHECK (is_org_controller(org_id));

-- ── 4. CB-3: unit and equipment-type codes are digits ───────────────────────
-- The rule binds a NEW code only — an insert, or an edit that changes the code
-- (or the kind). A meta-only UPDATE of a legacy letter-coded unit (pinning a
-- library, binding its knowledge library, a relabel) is not a new code.
CREATE OR REPLACE FUNCTION codebook_entries_code_digits_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.kind IN ('unit', 'equipment_type') AND NEW.code !~ '^[0-9]{1,6}$'
     AND (TG_OP = 'INSERT' OR NEW.code IS DISTINCT FROM OLD.code OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
    RAISE EXCEPTION 'codebook_entries_code_digits: % code "%" is not 1-6 digits', NEW.kind, NEW.code
      USING ERRCODE = '23514',
            HINT = 'Site codes are composed from digits (20 + 30 -> 2030.22); a letter code can never be decoded back.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_codebook_entries_code_digits ON codebook_entries;
CREATE TRIGGER trg_codebook_entries_code_digits
  BEFORE INSERT OR UPDATE OF code, kind ON codebook_entries
  FOR EACH ROW EXECUTE FUNCTION codebook_entries_code_digits_guard();

-- The CHECK exists only in the clean world, and only VALIDATED: with legacy
-- letter codes present it is absent (dropped if an earlier paste left it NOT
-- VALID), because a NOT VALID CHECK still binds every UPDATE of those rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM codebook_entries
              WHERE kind IN ('unit', 'equipment_type') AND code !~ '^[0-9]{1,6}$') THEN
    ALTER TABLE codebook_entries DROP CONSTRAINT IF EXISTS codebook_entries_code_digits;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'codebook_entries_code_digits'
                       AND conrelid = 'codebook_entries'::regclass) THEN
    ALTER TABLE codebook_entries ADD CONSTRAINT codebook_entries_code_digits
      CHECK (kind NOT IN ('unit', 'equipment_type') OR code ~ '^[0-9]{1,6}$');
  ELSE
    ALTER TABLE codebook_entries VALIDATE CONSTRAINT codebook_entries_code_digits;
  END IF;
END $$;

-- ── 5. CB-10: one site code is one asset ────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM assets
                  WHERE code IS NOT NULL AND btrim(code) <> ''
                  GROUP BY org_id, code HAVING COUNT(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS assets_org_code_unique
      ON assets (org_id, code) WHERE code IS NOT NULL AND btrim(code) <> '';
  END IF;
END $$;

-- ── 6. CB-5: a code still in use cannot be removed (or re-coded) ────────────
-- References are the STORED ones: an asset filed under the unit, an asset
-- whose site code's head is <unit><type> for this entry, a process flow
-- ending at the unit. SECURITY DEFINER so the count is whole whatever the
-- caller may read. The service role's cascades (org purge, restore) pass,
-- and so does an org already gone.
CREATE OR REPLACE FUNCTION codebook_entries_guard_in_use()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_assets bigint := 0;
  v_flows  bigint := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code IS NOT DISTINCT FROM OLD.code AND NEW.kind IS NOT DISTINCT FROM OLD.kind THEN RETURN NEW; END IF;
  END IF;
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.kind = 'unit' THEN
    SELECT COUNT(*) INTO v_assets FROM assets a
     WHERE a.org_id = OLD.org_id
       AND (a.unit_code = OLD.code
            OR EXISTS (SELECT 1 FROM codebook_entries t
                        WHERE t.org_id = OLD.org_id AND t.kind = 'equipment_type'
                          AND split_part(a.code, '.', 1) = OLD.code || t.code));
    IF to_regclass('public.process_flows') IS NOT NULL THEN
      EXECUTE 'SELECT COUNT(*) FROM process_flows WHERE org_id = $1 AND ((from_kind = ''unit'' AND from_ref = $2) OR (to_kind = ''unit'' AND to_ref = $2))'
         INTO v_flows USING OLD.org_id, OLD.code;
    END IF;
  ELSIF OLD.kind = 'equipment_type' THEN
    SELECT COUNT(*) INTO v_assets FROM assets a
     WHERE a.org_id = OLD.org_id
       AND EXISTS (SELECT 1 FROM codebook_entries u
                    WHERE u.org_id = OLD.org_id AND u.kind = 'unit'
                      AND split_part(a.code, '.', 1) = u.code || OLD.code);
  END IF;
  IF v_assets > 0 OR v_flows > 0 THEN
    RAISE EXCEPTION 'codebook_entries_in_use: % % is still referenced by % asset(s) and % process flow(s)', OLD.kind, OLD.code, v_assets, v_flows
      USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_codebook_entries_guard_in_use ON codebook_entries;
CREATE TRIGGER trg_codebook_entries_guard_in_use
  BEFORE DELETE OR UPDATE OF code, kind ON codebook_entries
  FOR EACH ROW EXECUTE FUNCTION codebook_entries_guard_in_use();

COMMIT;

-- ── Verification (read-only) + inventory — ONE result set ───────────────────
SELECT 'DELETE overlays on assets / asset_types / asset_photos are RESTRICTIVE and controller-only' AS check,
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE tablename IN ('assets', 'asset_types', 'asset_photos')
           AND policyname = tablename || '_write_roles_delete'
           AND permissive = 'RESTRICTIVE' AND cmd = 'DELETE'
           AND qual LIKE '%is_org_controller(org_id)%'
           AND qual NOT LIKE '%Manager%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'asset_files keeps the writer-tier DELETE overlay (a document link, not a registry record)',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE tablename = 'asset_files' AND policyname = 'asset_files_write_roles_delete'
                  AND permissive = 'RESTRICTIVE' AND qual LIKE '%caller_holds_any_role(org_id%'
                  AND qual LIKE '%Supervisor%')
       OR to_regclass('public.asset_files') IS NULL,
       NULL
UNION ALL
SELECT 'INSERT / UPDATE overlays from 20261045 still present on the three registry tables (writer tier)',
       (SELECT COUNT(*) = 6 FROM pg_policies
         WHERE tablename IN ('assets', 'asset_types', 'asset_photos')
           AND policyname IN (tablename || '_write_roles_insert', tablename || '_write_roles_update')
           AND permissive = 'RESTRICTIVE'),
       NULL
UNION ALL
SELECT 'assets registry-column guard from 20261045 still installed (BEFORE UPDATE)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'assets_guard_registry'
                AND tgrelid = 'assets'::regclass AND NOT tgisinternal),
       NULL
UNION ALL
SELECT 'asset deletion audited: AFTER DELETE trigger + ASSET_DELETED row, person-initiated only',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assets_audit_delete'
                AND tgrelid = 'assets'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%''ASSET_DELETED''%'
                   AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN OLD; END IF;%'
              FROM pg_proc WHERE proname = 'assets_audit_delete'),
       NULL
UNION ALL
SELECT 'document_equipment_suggestions: the only write policy is controller-only; SELECT unchanged',
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE tablename = 'document_equipment_suggestions' AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE'))
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'document_equipment_suggestions' AND policyname = 'doc_equip_sugg_write'
                      AND qual LIKE '%is_org_controller(org_id)%' AND with_check LIKE '%is_org_controller(org_id)%')
       AND EXISTS (SELECT 1 FROM pg_policies
                    WHERE tablename = 'document_equipment_suggestions' AND policyname = 'doc_equip_sugg_select'),
       NULL
UNION ALL
SELECT 'codebook / org playbook writes are the additive controller bar (20261046: caller_holds_any_role, Admin + DocCtrl only)',
       (SELECT COUNT(*) = 3 FROM pg_policies
         WHERE policyname IN ('codebook_entries_write', 'codebook_config_write', 'org_ai_instructions_write')
           AND qual LIKE '%caller_holds_any_role(org_id%' AND qual LIKE '%Admin%' AND qual LIKE '%DocCtrl%'
           AND qual NOT LIKE '%Manager%'
           AND with_check LIKE '%caller_holds_any_role(org_id%'),
       NULL
UNION ALL
SELECT 'is_org_controller reads the role collection and pins search_path (20260814 + 20261020)',
       (SELECT prosrc LIKE '%roles && ARRAY[''Admin'', ''DocCtrl'']%'
               AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'is_org_controller'),
       NULL
UNION ALL
SELECT 'search_path pinned on assets_audit_delete',
       (SELECT array_to_string(proconfig, ',') LIKE '%search_path=public%'
          FROM pg_proc WHERE proname = 'assets_audit_delete'),
       NULL
UNION ALL
SELECT 'CB-3: a new letter unit / type code is refused on INSERT or a code change (trigger); meta-only updates pass',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_codebook_entries_code_digits'
                AND tgrelid = 'codebook_entries'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%TG_OP = ''INSERT'' OR NEW.code IS DISTINCT FROM OLD.code%'
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'codebook_entries_code_digits_guard'),
       NULL
UNION ALL
SELECT 'CB-3: codebook_entries_code_digits CHECK is either absent (legacy letter codes remain) or VALIDATED — never NOT VALID',
       NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codebook_entries_code_digits' AND NOT convalidated),
       NULL
UNION ALL
SELECT 'CB-5: a unit / type still referenced by equipment or a process flow cannot be removed or re-coded (trigger, search_path pinned)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_codebook_entries_guard_in_use'
                AND tgrelid = 'codebook_entries'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%codebook_entries_in_use:%'
                   AND prosrc LIKE '%IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN%'
                   AND array_to_string(proconfig, ',') LIKE '%search_path=public%'
              FROM pg_proc WHERE proname = 'codebook_entries_guard_in_use'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g28_before
UNION ALL
SELECT 'inventory (after): codebook_entries_code_digits CHECK validated (true = every code is digits; absent = legacy letter codes remain, the trigger binds new ones)', NULL,
       COALESCE((SELECT convalidated::text FROM pg_constraint WHERE conname = 'codebook_entries_code_digits'), 'absent')
UNION ALL
SELECT 'inventory (after): assets_org_code_unique created (true = one site code is one asset)', NULL,
       (to_regclass('public.assets_org_code_unique') IS NOT NULL)::text;
