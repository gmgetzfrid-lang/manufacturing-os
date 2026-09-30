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
--      code is write-only. CHECK NOT VALID binds every new/changed row now;
--      VALIDATE runs when no legacy row violates it (the inventory says which
--      world you are in; nothing is rewritten or deleted).
--   5. CB-10 — one site code is one asset: a UNIQUE partial index on
--      assets (org_id, code) for non-blank codes, created only when no org
--      carries a duplicate today (otherwise the plain index stays and the
--      inventory counts the duplicates to resolve first; nothing is rewritten).
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
SELECT 'codebook unit / equipment-type codes that are not 1-6 digits (CB-3: the CHECK stays NOT VALID while > 0)', COUNT(*)
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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codebook_entries_code_digits') THEN
    ALTER TABLE codebook_entries ADD CONSTRAINT codebook_entries_code_digits
      CHECK (kind NOT IN ('unit', 'equipment_type') OR code ~ '^[0-9]{1,6}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM codebook_entries
                  WHERE kind IN ('unit', 'equipment_type') AND code !~ '^[0-9]{1,6}$') THEN
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
SELECT 'codebook_entries_code_digits CHECK present (validated = see the after row)',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codebook_entries_code_digits'),
       NULL
UNION ALL
SELECT 'inventory (before): ' || what, NULL, n::text FROM _intel_g28_before
UNION ALL
SELECT 'inventory (after): codebook_entries_code_digits validated (true = every legacy code is digits)', NULL,
       (SELECT convalidated::text FROM pg_constraint WHERE conname = 'codebook_entries_code_digits')
UNION ALL
SELECT 'inventory (after): assets_org_code_unique created (true = one site code is one asset)', NULL,
       (to_regclass('public.assets_org_code_unique') IS NOT NULL)::text;
