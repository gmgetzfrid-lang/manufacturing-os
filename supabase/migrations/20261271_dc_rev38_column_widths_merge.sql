-- ─────────────────────────────────────────────────────────────────────────────
-- 20261271_dc_rev38_column_widths_merge.sql
--
-- document-control F6-column-widths (REV-38 / REV-39), by the ruling of the integrator
-- under DEC-90: the shared column widths are merged PER COLUMN on the
-- server and ordered by a SERVER-OWNED version; the layout columns of a library
-- change only for a controller.
--
--   1. libraries.column_widths_rev (bigint NOT NULL DEFAULT 0) — the version
--      of libraries.column_widths. Owned by the server: a BEFORE INSERT OR
--      UPDATE trigger (trg_library_column_widths_rev ->
--      bump_library_column_widths_rev) sets it on INSERT to 0 and on UPDATE to
--      OLD + 1 when column_widths changes, else keeps OLD, whatever the write
--      sent. The library page orders every map it learns (the load, the
--      realtime row, the save answer) by it and ignores an older one.
--      libraries.updated_at cannot serve: no trigger maintains it, and of the
--      ten app writes of libraries only the admin edit sets it, from the
--      browser clock.
--   2. save_library_column_widths(p_library uuid, p_set jsonb, p_reset text[])
--      — SECURITY DEFINER (DRLS-16: search_path pinned; EXECUTE revoked from
--      PUBLIC, anon and service_role; granted to authenticated). For a signed-
--      in ACTIVE controller of the library workspace (is_org_controller: Admin
--      or DocCtrl by the role collection, status active) it applies, in ONE
--      statement, column_widths || p_set minus the p_reset keys, and returns
--      (column_widths, column_widths_rev) as committed. p_set must be an
--      object of column key (1 to 200 characters) to a number of pixels from
--      50 to 5000 (the page clamps a drag to the same bounds); at most 500
--      keys in all; at least one. Anything else is refused in plain words
--      (22023); a caller who is not an active controller of that workspace,
--      or a library that does not exist, gets the same refusal (42501) — no
--      existence oracle. The client sends only the columns it changed, so a
--      save never carries a stale copy of a column it did not touch (REV-39
--      limb 2: the whole-map window is closed).
--   3. The layout rail (REV-39 limb 1): trg_library_layout_columns ->
--      enforce_library_layout_columns(), BEFORE UPDATE on libraries. A write
--      by a signed-in person (auth.uid() set) that CHANGES column_widths,
--      custom_columns, column_label_overrides, uniqueness_keys or home_config
--      must come from is_org_controller(OLD.org_id); otherwise refused,
--      check_violation. Every legitimate writer of those columns is a
--      controller (traced in REV-39: the library page, each write offered
--      under isController; the admin library editor, controllers only; the
--      restore inserts with ON CONFLICT DO NOTHING, never an UPDATE; no SQL
--      function writes them). Writes with no auth.uid() pass (the service
--      role, cron, the SQL editor). A definer runs in the caller session, so
--      auth.uid() is still the caller: save_library_column_widths passes
--      because it already requires a controller; the other definers that
--      update libraries (the ACL prunes of 20261204, 20261228) change none of
--      these columns, and a write that leaves them as they were is not judged.
--
-- Both trigger functions are SECURITY INVOKER (they need no rights the
-- statement lacks: one sets NEW.column_widths_rev, the other reads
-- auth.uid() and is_org_controller, which every role may execute); EXECUTE on
-- them is revoked from PUBLIC anyway (a trigger function cannot be called
-- directly). No existing policy, function or trigger is touched: the final
-- SELECT compares the trigger and policy counts on libraries with those
-- captured before the transaction.
--
-- NARROWS (nobody gains): a non-controller member loses a direct PATCH of the
-- layout columns no app flow offers them. Existing values are COUNTED, never
-- changed (the inventory, aggregate counts only, captured BEFORE the
-- transaction into a TEMP TABLE — DEC-30).
--
-- BEFORE THE PASTE the app works as today: it reads column_widths_rev where it
-- exists (42703 / PGRST204 otherwise -> no version), calls the function where
-- it exists (PGRST202 / 42883 otherwise -> a re-read of column_widths and the
-- whole-map checked write it falls back to). AFTER IT: a controller saves
-- through the function; a non-controller writes nothing (the page never
-- offers it).
-- ORDER: independent of every other pending file (it reads is_org_controller,
-- live since 20260814, and the layout columns, live since 20260714); either
-- order with the F6 deploy. ⚠ APPLIED BY HAND (DEC-30). One script;
-- re-pasting is safe (ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP
-- TRIGGER IF EXISTS, idempotent REVOKE / GRANT).
--
-- ROLLBACK: DROP TRIGGER trg_library_layout_columns ON libraries;
--   DROP TRIGGER trg_library_column_widths_rev ON libraries;
--   DROP FUNCTION save_library_column_widths(uuid, jsonb, text[]);
--   DROP FUNCTION enforce_library_layout_columns();
--   DROP FUNCTION bump_library_column_widths_rev();
--   (the column may stay; the app reads it only when present)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Prerequisites (refuse to run, changing nothing, without the base) ───────
DO $$
BEGIN
  IF to_regclass('public.libraries') IS NULL
     OR to_regprocedure('public.is_org_controller(uuid)') IS NULL
     OR (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'libraries'
            AND column_name IN ('column_widths', 'custom_columns', 'column_label_overrides', 'uniqueness_keys', 'home_config')) <> 5 THEN
    RAISE EXCEPTION '20261271 needs libraries with column_widths, custom_columns, column_label_overrides, uniqueness_keys and home_config (20260714) and is_org_controller (20260814); nothing was changed.';
  END IF;
END
$$;

-- ── Pre-apply inventory (aggregate counts only; captured BEFORE the DDL) ────
DROP TABLE IF EXISTS dc_rev38_20261271_before;
CREATE TEMP TABLE dc_rev38_20261271_before AS
SELECT 1 AS ord, 'inventory (before apply): libraries in all' AS inventory,
       COUNT(*)::text AS n FROM libraries
UNION ALL
SELECT 2, 'inventory (before apply): libraries with a saved column width (a non-empty column_widths object); counted, not changed',
       COUNT(*)::text FROM libraries WHERE jsonb_typeof(column_widths) = 'object' AND column_widths <> '{}'::jsonb
UNION ALL
SELECT 3, 'inventory (before apply): libraries whose column_widths is NULL or not a JSON object; the merge reads such a value as no widths',
       COUNT(*)::text FROM libraries WHERE column_widths IS NULL OR jsonb_typeof(column_widths) <> 'object'
UNION ALL
SELECT 4, 'inventory (before apply): saved widths that are not a number from 50 to 5000 (kept as they are until a controller changes that column)',
       COUNT(*)::text FROM libraries l, jsonb_each(CASE WHEN jsonb_typeof(l.column_widths) = 'object' THEN l.column_widths ELSE '{}'::jsonb END) e
        WHERE CASE WHEN jsonb_typeof(e.value) = 'number' THEN (e.value #>> '{}')::numeric NOT BETWEEN 50 AND 5000 ELSE true END
UNION ALL
SELECT 5, 'inventory (before apply): libraries.column_widths_rev already present (1 on a re-paste, else 0)',
       COUNT(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'column_widths_rev'
UNION ALL
SELECT 6, 'inventory (before apply): triggers on libraries other than this file',
       COUNT(*)::text FROM pg_trigger
        WHERE tgrelid = 'public.libraries'::regclass AND NOT tgisinternal
          AND tgname NOT IN ('trg_library_column_widths_rev', 'trg_library_layout_columns')
UNION ALL
SELECT 7, 'inventory (before apply): policies on libraries',
       COUNT(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries';

BEGIN;

-- ── 1. the version: server-owned ────────────────────────────────────────────
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS column_widths_rev bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN libraries.column_widths_rev IS
  'The version of column_widths, owned by the server (trg_library_column_widths_rev): 0 on insert, plus one on every update that changes column_widths, unchanged otherwise whatever the write sends. The library page orders the maps it learns by it (document-control REV-38, 20261271).';

CREATE OR REPLACE FUNCTION bump_library_column_widths_rev()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.column_widths_rev := 0;
    RETURN NEW;
  END IF;
  IF NEW.column_widths IS DISTINCT FROM OLD.column_widths THEN
    NEW.column_widths_rev := OLD.column_widths_rev + 1;
  ELSE
    NEW.column_widths_rev := OLD.column_widths_rev;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION bump_library_column_widths_rev() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_library_column_widths_rev ON libraries;
CREATE TRIGGER trg_library_column_widths_rev
  BEFORE INSERT OR UPDATE ON libraries
  FOR EACH ROW EXECUTE FUNCTION bump_library_column_widths_rev();

-- ── 2. the per-column merge ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION save_library_column_widths(p_library uuid, p_set jsonb, p_reset text[])
RETURNS TABLE (column_widths jsonb, column_widths_rev bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_org uuid;
  v_set jsonb := COALESCE(p_set, '{}'::jsonb);
  v_reset text[] := COALESCE(p_reset, ARRAY[]::text[]);
  v_keys integer;
  v_key text;
  v_val jsonb;
  v_num numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to save the column widths of a library.' USING ERRCODE = '42501';
  END IF;
  IF p_library IS NULL THEN
    RAISE EXCEPTION 'Name the library whose column widths to save.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_set) <> 'object' THEN
    RAISE EXCEPTION 'Column widths must be sent as column names, each with a width.' USING ERRCODE = '22023';
  END IF;
  SELECT COUNT(*) INTO v_keys FROM jsonb_object_keys(v_set);
  v_keys := v_keys + cardinality(v_reset);
  IF v_keys = 0 THEN
    RAISE EXCEPTION 'Nothing to save: no column width was sent.' USING ERRCODE = '22023';
  END IF;
  IF v_keys > 500 THEN
    RAISE EXCEPTION 'Too many columns in one save (at most 500).' USING ERRCODE = '22023';
  END IF;
  FOR v_key, v_val IN SELECT e.key, e.value FROM jsonb_each(v_set) e LOOP
    IF length(btrim(v_key)) = 0 OR length(v_key) > 200 THEN
      RAISE EXCEPTION 'A column name must be 1 to 200 characters long.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_val) <> 'number' THEN
      RAISE EXCEPTION 'A column width must be a number of pixels.' USING ERRCODE = '22023';
    END IF;
    v_num := (v_val #>> '{}')::numeric;
    IF v_num < 50 OR v_num > 5000 THEN
      RAISE EXCEPTION 'A column width must be from 50 to 5000 pixels.' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM unnest(v_reset) r(k) WHERE r.k IS NULL OR length(btrim(r.k)) = 0 OR length(r.k) > 200) THEN
    RAISE EXCEPTION 'A column name must be 1 to 200 characters long.' USING ERRCODE = '22023';
  END IF;
  SELECT l.org_id INTO v_org FROM libraries l WHERE l.id = p_library;
  IF v_org IS NULL OR NOT is_org_controller(v_org) THEN
    RAISE EXCEPTION 'Only an Admin or a Document Controller of this workspace can save the column widths of this library.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    UPDATE libraries l
       SET column_widths = (CASE WHEN jsonb_typeof(l.column_widths) = 'object' THEN l.column_widths ELSE '{}'::jsonb END || v_set) - v_reset,
           updated_by = auth.uid()
     WHERE l.id = p_library
    RETURNING l.column_widths, l.column_widths_rev;
END;
$$;

COMMENT ON FUNCTION save_library_column_widths(uuid, jsonb, text[]) IS
  'document-control REV-38 / REV-39 (20261271): for a signed-in active controller of the library workspace, applies column_widths || p_set minus the p_reset keys in one statement and returns the committed column_widths and column_widths_rev. p_set: column key (1 to 200 characters) to a width from 50 to 5000 pixels; at most 500 keys in all. Anything else is refused in plain words. Called by lib/libraryColumnWidths.ts saveLibraryColumnWidths.';

REVOKE ALL ON FUNCTION save_library_column_widths(uuid, jsonb, text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION save_library_column_widths(uuid, jsonb, text[]) TO authenticated;

-- ── 3. the layout rail ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_library_layout_columns()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- The service role, cron and the SQL editor carry no uid and pass.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Only these five are judged; a write that leaves all of them as they were
  -- is decided exactly as before.
  IF NEW.column_widths IS DISTINCT FROM OLD.column_widths
     OR NEW.custom_columns IS DISTINCT FROM OLD.custom_columns
     OR NEW.column_label_overrides IS DISTINCT FROM OLD.column_label_overrides
     OR NEW.uniqueness_keys IS DISTINCT FROM OLD.uniqueness_keys
     OR NEW.home_config IS DISTINCT FROM OLD.home_config THEN
    IF NOT is_org_controller(OLD.org_id) THEN
      RAISE EXCEPTION 'Only an Admin or a Document Controller can change the columns, column labels, uniqueness rule, home layout or column widths of this library.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_library_layout_columns() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_library_layout_columns ON libraries;
CREATE TRIGGER trg_library_layout_columns
  BEFORE UPDATE ON libraries
  FOR EACH ROW EXECUTE FUNCTION enforce_library_layout_columns();

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- Probes: ok = true on every row of section 1. Inventory rows: n = the count.
SELECT "check", ok, n FROM (
SELECT 1 AS sec, 1 AS ord, 'libraries.column_widths_rev is bigint NOT NULL DEFAULT 0' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'column_widths_rev'
                  AND data_type = 'bigint' AND is_nullable = 'NO' AND column_default = '0') AS ok,
       NULL::text AS n
UNION ALL
SELECT 1, 2, 'trg_library_column_widths_rev: a BEFORE INSERT OR UPDATE row trigger on libraries, enabled, bumping the version only when column_widths changes',
       EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                WHERE tg.tgrelid = 'public.libraries'::regclass AND tg.tgname = 'trg_library_column_widths_rev'
                  AND NOT tg.tgisinternal AND tg.tgenabled = 'O' AND p.proname = 'bump_library_column_widths_rev'
                  AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 4) = 4 AND (tg.tgtype & 16) = 16
                  AND (tg.tgtype & (8 | 32)) = 0
                  AND p.prosrc LIKE '%IF NEW.column_widths IS DISTINCT FROM OLD.column_widths THEN%'
                  AND p.prosrc LIKE '%NEW.column_widths_rev := OLD.column_widths_rev + 1;%'
                  AND p.prosrc LIKE '%NEW.column_widths_rev := OLD.column_widths_rev;%'
                  AND p.prosrc LIKE '%NEW.column_widths_rev := 0;%'),
       NULL
UNION ALL
SELECT 1, 3, 'save_library_column_widths: one definition; returns column_widths and column_widths_rev; merges in one UPDATE (the stored map with p_set on top and the p_reset keys removed); held to is_org_controller of the library workspace; validates the input',
       (SELECT COUNT(*) = 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.proname = 'save_library_column_widths')
       AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                    WHERE ns.nspname = 'public' AND p.proname = 'save_library_column_widths'
                      AND p.oid = to_regprocedure('public.save_library_column_widths(uuid, jsonb, text[])')
                      AND pg_get_function_result(p.oid) = 'TABLE(column_widths jsonb, column_widths_rev bigint)'
                      AND p.prosrc LIKE '%IF auth.uid() IS NULL THEN%'
                      AND p.prosrc LIKE '%IF v_org IS NULL OR NOT is_org_controller(v_org) THEN%'
                      AND p.prosrc LIKE '%|| v_set) - v_reset,%'
                      AND p.prosrc LIKE '%RETURNING l.column_widths, l.column_widths_rev;%'
                      AND p.prosrc LIKE '%IF v_num < 50 OR v_num > 5000 THEN%'
                      AND p.prosrc LIKE '%IF v_keys > 500 THEN%'),
       NULL
UNION ALL
SELECT 1, 4, 'DRLS-16: save_library_column_widths is SECURITY DEFINER with search_path pinned; PUBLIC, anon and service_role cannot execute it; authenticated can',
       (SELECT p.prosecdef
               AND p.proconfig @> ARRAY['search_path=public']
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_library_column_widths(uuid, jsonb, text[])')),
       NULL
UNION ALL
SELECT 1, 5, 'trg_library_layout_columns: a BEFORE UPDATE row trigger on libraries, enabled; passes a write with no uid; judges the five layout columns by is_org_controller of the library workspace',
       EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                WHERE tg.tgrelid = 'public.libraries'::regclass AND tg.tgname = 'trg_library_layout_columns'
                  AND NOT tg.tgisinternal AND tg.tgenabled = 'O' AND p.proname = 'enforce_library_layout_columns'
                  AND (tg.tgtype & 1) = 1 AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 16) = 16
                  AND (tg.tgtype & (4 | 8 | 32)) = 0
                  AND NOT p.prosecdef
                  AND p.prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                  AND p.prosrc LIKE '%NEW.column_widths IS DISTINCT FROM OLD.column_widths%'
                  AND p.prosrc LIKE '%NEW.custom_columns IS DISTINCT FROM OLD.custom_columns%'
                  AND p.prosrc LIKE '%NEW.column_label_overrides IS DISTINCT FROM OLD.column_label_overrides%'
                  AND p.prosrc LIKE '%NEW.uniqueness_keys IS DISTINCT FROM OLD.uniqueness_keys%'
                  AND p.prosrc LIKE '%NEW.home_config IS DISTINCT FROM OLD.home_config%'
                  AND p.prosrc LIKE '%IF NOT is_org_controller(OLD.org_id) THEN%'),
       NULL
UNION ALL
SELECT 1, 6, 'every other trigger on libraries is still there, and no policy on libraries was added or dropped (counts equal those before the paste); libraries_org_access is kept',
       (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = 'public.libraries'::regclass AND NOT tgisinternal
          AND tgname NOT IN ('trg_library_column_widths_rev', 'trg_library_layout_columns'))::text
         = (SELECT n FROM dc_rev38_20261271_before WHERE ord = 6)
       AND (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries')::text
         = (SELECT n FROM dc_rev38_20261271_before WHERE ord = 7)
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries' AND policyname = 'libraries_org_access'),
       NULL
UNION ALL
SELECT 1, 7, 'is_org_controller still reads an ACTIVE member holding Admin or DocCtrl by role or roles',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_org_controller' AND pronargs = 1
                  AND prosrc LIKE '%auth.uid()%' AND prosrc LIKE '%status = %active%'
                  AND prosrc LIKE '%Admin%DocCtrl%'),
       NULL
UNION ALL
SELECT 2, ord, inventory, NULL, n FROM dc_rev38_20261271_before
UNION ALL
SELECT 3, 1, 'after: libraries with a saved column width (read beside BEFORE row 2; this paste changes no row)', NULL,
       (SELECT COUNT(*) FROM libraries WHERE jsonb_typeof(column_widths) = 'object' AND column_widths <> '{}'::jsonb)::text
) AS final_rows
ORDER BY sec, ord;
