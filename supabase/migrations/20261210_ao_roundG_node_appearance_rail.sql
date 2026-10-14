-- ─────────────────────────────────────────────────────────────────────────────
-- 20261210 — admin-and-org Round G, P11 APPEARANCE RAILS: a library's or
-- folder's cover image and page background change only for the node
-- editor's authority (ORG-17).
--
--   ORG-17  A library's appearance pointers sat under the membership-wide
--           libraries_org_access (FOR ALL, membership only, schema.sql); the
--           sensitive-column guard (enforce_library_sensitive_columns, newest
--           20261077) lists ownership, ACL and policy columns, not the cover.
--           Any member (a Viewer, a Contractor) could PATCH a library's
--           cover_image_url to an external URL every member's browser then
--           loads, or repoint page_config.background. ORG-16 already holds
--           the image BYTES under branding/covers/ and branding/backgrounds/
--           to the node editor's gate; this holds the POINTERS to the same
--           gate.
--     · enforce_node_appearance_columns() — one BEFORE UPDATE trigger
--       function, attached to libraries AND collections (folders carry the
--       same columns, 20260709 / 20260711 / 20260714). A person's write
--       (auth.uid() set) that CHANGES cover_image_url, cover_tint or
--       page_config->'background' must come from a member holding Admin or
--       DocCtrl by the role collection — is_org_controller(OLD.org_id), the
--       set lib/storageKey.ts NODE_CUSTOMIZE_ROLES names and the two pages
--       that open CustomizeNodeModal gate on (hasAnyRole(["Admin",
--       "DocCtrl"])). Otherwise refused, check_violation, with the sentence
--       the upload route uses.
--         cover_tint is the cover image's duotone recolor (NodeCover); the
--         record's done-when names it with the cover. page_config's OTHER
--         keys (header) are not judged here. A JSON null background reads as
--         no background, so {"background": null} over a NULL page_config is
--         not a change.
--     · Every other column is decided exactly as today: the trigger compares
--       only those three values (OLD vs NEW, IS DISTINCT FROM), so a write
--       that leaves them as they were — a rename, a column width, an ACL, a
--       folder move, revoke_member's ACL prune — is not judged at all.
--     · Writes with no auth.uid() pass: the restore's service-role inserts
--       (INSERT is not judged anyway), service jobs, cron.
--     · No policy is re-created and no existing function or trigger is
--       touched: libraries_org_access, collections_update_controllers
--       (20261044), enforce_library_sensitive_columns (20261077),
--       collections_guard_access_change (20261044), the review-control audit
--       triggers (20261072), the INSERT rail (20261062) and P8's
--       library-delete audit trigger (20261204, if pasted) stay as they are.
--       The final SELECT compares the trigger and policy counts on both
--       tables with the counts captured before the transaction.
--     · Folders: collections_update_controllers already admits only a
--       controller, the folder's owner or a manage-grant holder to UPDATE a
--       folder at all. The owner / manage-grant holder who is not a
--       controller keeps every other folder write; only the cover and
--       background are now the controllers' (their app path to them was
--       already none: the editor is offered under isController only).
--
-- NARROWS (nobody gains). Existing values are COUNTED, never changed: the
-- inventory below says how many libraries / folders carry a cover, how many
-- of those covers are an external URL drawn directly, and how many carry a
-- page background. Who last set them is not recorded anywhere, so it is not
-- counted. Pre-apply inventory (DEC-30): aggregate COUNTs only, captured into
-- a TEMP TABLE before the transaction. Never a customer row.
--
-- BEFORE THE PASTE the app works as today. AFTER IT: an Admin's or DocCtrl's
-- Customize save (app/(protected)/documents/page.tsx saveLibraryAppearance,
-- lib/libraryCollections.ts updateCollectionAppearance) is the same write and
-- passes; a non-controller's direct PATCH of those columns is refused (23514)
-- — no app flow offers one. The restore page's pointer clear (ORG-18, an
-- Admin's write) passes before and after.
-- ORDER: independent of every other pending file (it reads is_org_controller,
-- live since 20260814); either order with the P11 deploy. ⚠ APPLIED BY HAND
-- (DEC-30). One script; re-running is safe.
--
-- ROLLBACK: DROP TRIGGER trg_node_appearance_columns ON libraries;
--   DROP TRIGGER trg_node_appearance_columns ON collections;
--   DROP FUNCTION enforce_node_appearance_columns();
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS ao_p11_20261210_inventory (check_name text, n bigint);
TRUNCATE ao_p11_20261210_inventory;
INSERT INTO ao_p11_20261210_inventory
SELECT 'before: libraries with a cover image pointer (counted, not changed)', COUNT(*)
  FROM libraries WHERE NULLIF(cover_image_url, '') IS NOT NULL
UNION ALL
SELECT 'before: of those, a pointer that is an external http(s): / data: URL, drawn directly by every viewer (counted, not changed)', COUNT(*)
  FROM libraries WHERE cover_image_url ~* '^(https?:|data:)'
UNION ALL
SELECT 'before: libraries with a page background set (page_config.background, counted, not changed)', COUNT(*)
  FROM libraries WHERE NULLIF(page_config -> 'background', 'null'::jsonb) IS NOT NULL
UNION ALL
SELECT 'before: folders with a cover image pointer (counted, not changed)', COUNT(*)
  FROM collections WHERE NULLIF(cover_image_url, '') IS NOT NULL
UNION ALL
SELECT 'before: of those, a pointer that is an external http(s): / data: URL (counted, not changed)', COUNT(*)
  FROM collections WHERE cover_image_url ~* '^(https?:|data:)'
UNION ALL
SELECT 'before: folders with a page background set (counted, not changed)', COUNT(*)
  FROM collections WHERE NULLIF(page_config -> 'background', 'null'::jsonb) IS NOT NULL
UNION ALL
SELECT 'before: triggers on libraries other than this file''s', COUNT(*)
  FROM pg_trigger WHERE tgrelid = 'public.libraries'::regclass AND NOT tgisinternal AND tgname <> 'trg_node_appearance_columns'
UNION ALL
SELECT 'before: triggers on collections other than this file''s', COUNT(*)
  FROM pg_trigger WHERE tgrelid = 'public.collections'::regclass AND NOT tgisinternal AND tgname <> 'trg_node_appearance_columns'
UNION ALL
SELECT 'before: policies on libraries and collections', COUNT(*)
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('libraries', 'collections');

BEGIN;

-- ── 1. ORG-17: the appearance rail ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_node_appearance_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Restore, service jobs and cron carry no uid and pass.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Only the cover image, its tint and the page background are judged; a
  -- write that leaves all three as they were is decided exactly as before.
  IF NEW.cover_image_url IS DISTINCT FROM OLD.cover_image_url
     OR NEW.cover_tint IS DISTINCT FROM OLD.cover_tint
     OR NULLIF(NEW.page_config -> 'background', 'null'::jsonb)
          IS DISTINCT FROM NULLIF(OLD.page_config -> 'background', 'null'::jsonb) THEN
    -- The node editor's gate: Admin or DocCtrl by the role collection
    -- (lib/storageKey.ts NODE_CUSTOMIZE_ROLES; ORG-16 holds the bytes to it).
    IF NOT is_org_controller(OLD.org_id) THEN
      RAISE EXCEPTION 'Only an Admin or a Document Controller can change a folder''s or library''s cover image or background.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION enforce_node_appearance_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_node_appearance_columns ON libraries;
CREATE TRIGGER trg_node_appearance_columns
  BEFORE UPDATE ON libraries
  FOR EACH ROW EXECUTE FUNCTION enforce_node_appearance_columns();

DROP TRIGGER IF EXISTS trg_node_appearance_columns ON collections;
CREATE TRIGGER trg_node_appearance_columns
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION enforce_node_appearance_columns();

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'enforce_node_appearance_columns: SECURITY DEFINER, search_path pinned, passes a write with no uid, judges cover_image_url / cover_tint / page_config.background only, by is_org_controller (ORG-17)' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_node_appearance_columns' AND prosecdef
                  AND proconfig @> ARRAY['search_path=public']
                  AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                  AND prosrc LIKE '%NEW.cover_image_url IS DISTINCT FROM OLD.cover_image_url%'
                  AND prosrc LIKE '%NEW.cover_tint IS DISTINCT FROM OLD.cover_tint%'
                  AND prosrc LIKE '%NULLIF(NEW.page_config -> ''background'', ''null''::jsonb)%'
                  AND prosrc LIKE '%IF NOT is_org_controller(OLD.org_id) THEN%'
                  AND prosrc LIKE '%folder''''s or library''''s cover image or background.%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'trg_node_appearance_columns is a BEFORE UPDATE row trigger, enabled, on libraries and on collections',
       (SELECT COUNT(*) = 2 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
         WHERE tg.tgname = 'trg_node_appearance_columns' AND NOT tg.tgisinternal AND tg.tgenabled = 'O'
           AND tg.tgrelid IN ('public.libraries'::regclass, 'public.collections'::regclass)
           AND p.proname = 'enforce_node_appearance_columns'
           AND (tg.tgtype & 1) = 1      -- ROW
           AND (tg.tgtype & 2) = 2      -- BEFORE
           AND (tg.tgtype & 16) = 16    -- UPDATE
           AND (tg.tgtype & (4 | 8 | 32)) = 0),  -- not INSERT / DELETE / TRUNCATE
       NULL
UNION ALL
SELECT 'enforce_node_appearance_columns: PUBLIC, anon and authenticated cannot execute it (a trigger function; DRLS-16)',
       NOT has_function_privilege('anon', 'enforce_node_appearance_columns()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_node_appearance_columns()', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                        WHERE p.proname = 'enforce_node_appearance_columns' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'is_org_controller still reads Admin / DocCtrl by role or roles for an active member — the node editor''s gate (NODE_CUSTOMIZE_ROLES)',
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_org_controller' AND pronargs = 1
                  AND prosrc LIKE '%status = ''active''%'
                  AND prosrc LIKE '%role IN (''Admin'', ''DocCtrl'') OR roles && ARRAY[''Admin'', ''DocCtrl'']%'),
       NULL
UNION ALL
SELECT 'every other trigger on libraries and collections is still there (counts equal those before the paste)',
       (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = 'public.libraries'::regclass AND NOT tgisinternal AND tgname <> 'trg_node_appearance_columns')
         = (SELECT n FROM ao_p11_20261210_inventory WHERE check_name = 'before: triggers on libraries other than this file''s')
       AND (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = 'public.collections'::regclass AND NOT tgisinternal AND tgname <> 'trg_node_appearance_columns')
         = (SELECT n FROM ao_p11_20261210_inventory WHERE check_name = 'before: triggers on collections other than this file''s'),
       NULL
UNION ALL
SELECT 'no policy on libraries or collections was added or dropped; libraries_org_access and collections_update_controllers are kept',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('libraries', 'collections'))
         = (SELECT n FROM ao_p11_20261210_inventory WHERE check_name = 'before: policies on libraries and collections')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries' AND policyname = 'libraries_org_access')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'collections'
                      AND policyname = 'collections_update_controllers' AND permissive = 'RESTRICTIVE'),
       NULL
UNION ALL
SELECT 'the library sensitive-column guard (20261077) is still attached to libraries and was not re-created here',
       EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                WHERE tg.tgrelid = 'public.libraries'::regclass AND tg.tgname = 'trg_library_sensitive_columns'
                  AND p.proname = 'enforce_library_sensitive_columns' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%recert_policy%' AND p.prosrc NOT LIKE '%cover_image_url%'),
       NULL
UNION ALL
SELECT check_name, NULL, n::text FROM ao_p11_20261210_inventory;
