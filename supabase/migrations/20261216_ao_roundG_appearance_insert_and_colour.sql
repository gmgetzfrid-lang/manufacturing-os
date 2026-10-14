-- ─────────────────────────────────────────────────────────────────────────────
-- 20261216 — admin-and-org Round G, P15 APPEARANCE FOLLOW-UPS: the appearance
-- rail also judges a NEW library or folder (ORG-19) and the colour column
-- (ORG-21).
--
--   ORG-19  20261210's rail (enforce_node_appearance_columns, BEFORE UPDATE)
--           judges a CHANGE to a node's cover image, cover tint or page
--           background. A new row has no OLD, and the library INSERT rail
--           (enforce_library_insert_sensitive_columns, 20261062) lists only
--           ownership, ACL and policy columns, so any member could INSERT a
--           library already carrying an external cover URL that every
--           member's browser then loads (libraries_org_access admits the
--           INSERT on membership alone).
--   ORG-21  libraries.color / collections.color are drawn into inline CSS
--           (a gradient, a tile background). A value that closes the
--           gradient and adds url(...) makes every viewer's browser fetch an
--           external URL, and the column sat under the membership-wide
--           policy with no format rule.
--
--     · enforce_node_appearance_columns() is RE-CREATED from its newest
--       definition (20261210; the shape test line-diffs the two and allows
--       exactly the lines below). The trigger trg_node_appearance_columns is
--       re-attached to libraries AND collections as BEFORE INSERT OR UPDATE.
--     · A write with no auth.uid() still passes first: the restore's
--       service-role inserts, service jobs, cron.
--     · Colour (ORG-21): a person's write that SETS a colour on a new node,
--       or CHANGES one, must give a hex colour — #rgb or #rrggbb, the rule
--       lib/nodeColor.ts NODE_COLOR_SQL_PATTERN states and every render
--       site applies — or no colour (NULL). Otherwise check_violation. The
--       node editor offers twelve #rrggbb swatches and "Theme" (NULL); the
--       app offers no named colour token, so none is accepted. A stored
--       value that fails the format is never refused on a write that leaves
--       it as it was (a rename, a Customize save that keeps the colour), and
--       is never rewritten: it is counted below and rendered as no colour.
--       Colour is a format rule, not an authority rule: who may change it is
--       decided exactly as today (20261210's ruling).
--     · INSERT (ORG-19): a person's new row that sets cover_image_url,
--       cover_tint or a page background (page_config -> 'background', a JSON
--       null reading as none) needs is_org_controller(NEW.org_id) — the same
--       gate, by the same role collection (lib/storageKey.ts
--       NODE_CUSTOMIZE_ROLES: Admin / DocCtrl), and the same sentence the
--       UPDATE arm uses. A new row that sets none of them is decided exactly
--       as before. No app INSERT writes them (lib/libraryCollections.ts
--       createLibrary / createCollection, the admin wizard's insert, the
--       intake route's service-role folder), so no app flow changes.
--       Folders: the INSERT arm holds for a folder exactly as for a
--       library, and it holds the colour rule. IF 20261011's RESTRICTIVE
--       collections_insert_controllers is live, it already admits only a
--       controller to INSERT a folder, so the folder arm then refuses nobody
--       that policy admits — but whether 20261011 was ever pasted is not
--       known (MIGRATION-PASTE-ORDER row 10: unknown), so this file does not
--       rely on it: the inventory reports whether the policy is present
--       (1 / 0), and no probe requires it.
--     · The UPDATE arm is 20261210's, unchanged: only the cover image, its
--       tint and the page background are judged by authority, OLD vs NEW.
--     · No policy is re-created and no other function or trigger is
--       touched: libraries_org_access, collections_insert_controllers
--       (20261011, if live), collections_update_controllers (20261044), the
--       INSERT rail (20261062), enforce_library_sensitive_columns (20261077),
--       the review-control audit triggers (20261072) and the library-delete
--       audit (20261204, if pasted) stay as they are. The final SELECT
--       compares the trigger and policy counts with those captured before
--       the transaction.
--
-- NARROWS (nobody gains). Existing values are COUNTED, never changed:
-- pre-apply inventory (DEC-30), aggregate COUNTs only, captured into a TEMP
-- TABLE before the transaction. Never a customer row.
--
-- BEFORE THE PASTE the app works as today, and from the P15 deploy every
-- render site already draws a colour only when it is a hex colour. AFTER IT:
-- a controller's Customize save (a swatch or Theme) and every library or
-- folder creation the app makes pass unchanged; a member's direct POST of a
-- library carrying a cover / tint / background, or any direct write of a
-- colour that is not a hex colour, is refused (23514). No app path reads or
-- calls anything new (no 42703 / 42883 / 42P01 / PGRST2xx path).
-- ORDER: this file SUPERSEDES 20261210. Its function body is 20261210's,
-- line for line and in order, plus the colour arm and the INSERT arm (the
-- shape test pins it), and it re-attaches the trigger itself, so it is
-- self-contained: it needs only is_org_controller, live since 20260814.
-- Paste it after 20261210, or alone. The inventory row 'before:
-- trg_node_appearance_columns attached' reads 2 when 20261210 (or an earlier
-- paste of this file) came first, and 0 when neither did; at 0, 20261210 is
-- folded into this file and is NOT to be pasted afterwards.
-- ⚠ NEVER paste 20261210 once this file is live. That paste silently puts
-- back the UPDATE-only body and BEFORE UPDATE trigger (the INSERT door and
-- the colour rule are gone), and 20261210's own probes still read ok = true
-- because they expect BEFORE UPDATE only. If it happens, paste this file
-- again. Either order with the P15 deploy. ⚠ APPLIED BY HAND (DEC-30). One
-- script; re-running is safe.
--
-- ROLLBACK: paste 20261210 again (it re-creates the UPDATE-only body and
-- re-attaches the trigger as BEFORE UPDATE) — the deliberate form of the
-- paste the ORDER note forbids.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. pre-apply inventory (counts only) ────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS ao_p15_20261216_inventory (check_name text, n bigint);
TRUNCATE ao_p15_20261216_inventory;
INSERT INTO ao_p15_20261216_inventory
SELECT 'before: libraries with a colour set (counted, not changed)', COUNT(*)
  FROM libraries WHERE color IS NOT NULL
UNION ALL
SELECT 'before: of those, a colour that is not #rgb / #rrggbb — rendered as no colour from the P15 deploy (counted, not changed)', COUNT(*)
  FROM libraries WHERE color IS NOT NULL AND color !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'
UNION ALL
SELECT 'before: of those, a colour naming url( — an external fetch attempt (counted, not changed)', COUNT(*)
  FROM libraries WHERE color ILIKE '%url(%'
UNION ALL
SELECT 'before: folders with a colour set (counted, not changed)', COUNT(*)
  FROM collections WHERE color IS NOT NULL
UNION ALL
SELECT 'before: of those, a colour that is not #rgb / #rrggbb — rendered as no colour from the P15 deploy (counted, not changed)', COUNT(*)
  FROM collections WHERE color IS NOT NULL AND color !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'
UNION ALL
SELECT 'before: of those, a colour naming url( (counted, not changed)', COUNT(*)
  FROM collections WHERE color ILIKE '%url(%'
UNION ALL
SELECT 'before: libraries carrying a cover image, a cover tint or a page background (who set it, and whether at creation, is not recorded; counted, not changed)', COUNT(*)
  FROM libraries WHERE cover_image_url IS NOT NULL OR cover_tint IS NOT NULL
                    OR NULLIF(page_config -> 'background', 'null'::jsonb) IS NOT NULL
UNION ALL
SELECT 'before: triggers on libraries other than this file''s', COUNT(*)
  FROM pg_trigger WHERE tgrelid = 'public.libraries'::regclass AND NOT tgisinternal AND tgname <> 'trg_node_appearance_columns'
UNION ALL
SELECT 'before: triggers on collections other than this file''s', COUNT(*)
  FROM pg_trigger WHERE tgrelid = 'public.collections'::regclass AND NOT tgisinternal AND tgname <> 'trg_node_appearance_columns'
UNION ALL
SELECT 'before: policies on libraries and collections', COUNT(*)
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('libraries', 'collections')
UNION ALL
SELECT 'before: collections_insert_controllers present (20261011''s RESTRICTIVE controller-only folder INSERT policy; 1 = present, 0 = absent; whether 20261011 is live is unknown, so this is reported, not judged)', COUNT(*)
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'collections'
                     AND policyname = 'collections_insert_controllers' AND permissive = 'RESTRICTIVE'
UNION ALL
SELECT 'before: trg_node_appearance_columns attached (2 = 20261210 or an earlier paste of this file came first; 0 = neither, so 20261210 is now folded into this file: never paste 20261210 afterwards)', COUNT(*)
  FROM pg_trigger WHERE tgname = 'trg_node_appearance_columns' AND NOT tgisinternal
                    AND tgrelid IN ('public.libraries'::regclass, 'public.collections'::regclass);

BEGIN;

-- ── 1. ORG-19 + ORG-21: the appearance rail, re-created from 20261210 ───────
CREATE OR REPLACE FUNCTION enforce_node_appearance_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Restore, service jobs and cron carry no uid and pass.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- ORG-21: a colour is a hex colour (#rgb / #rrggbb, lib/nodeColor.ts) or
  -- none. Judged when a new row sets one or a write changes it, so a stored
  -- value that fails the format never blocks a write that keeps it.
  IF NEW.color IS NOT NULL AND NEW.color !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'
     AND (TG_OP = 'INSERT' OR NEW.color IS DISTINCT FROM OLD.color) THEN
    RAISE EXCEPTION 'A folder''s or library''s colour must be a hex colour such as #2563eb.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- ORG-19: a new row has no OLD. One that sets the cover image, its tint
  -- or a page background is judged by the same gate as a change, on the new
  -- row's workspace; one that sets none of them is decided as before.
  IF TG_OP = 'INSERT' THEN
    IF NEW.cover_image_url IS NOT NULL
       OR NEW.cover_tint IS NOT NULL
       OR NULLIF(NEW.page_config -> 'background', 'null'::jsonb) IS NOT NULL THEN
      IF NOT is_org_controller(NEW.org_id) THEN
        RAISE EXCEPTION 'Only an Admin or a Document Controller can change a folder''s or library''s cover image or background.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
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
  BEFORE INSERT OR UPDATE ON libraries
  FOR EACH ROW EXECUTE FUNCTION enforce_node_appearance_columns();

DROP TRIGGER IF EXISTS trg_node_appearance_columns ON collections;
CREATE TRIGGER trg_node_appearance_columns
  BEFORE INSERT OR UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION enforce_node_appearance_columns();

COMMIT;

-- ── Verification + inventory (ONE result set) ───────────────────────────────
-- expect ok = true on every probe; the inventory rows carry n.
SELECT 'enforce_node_appearance_columns: SECURITY DEFINER, search_path pinned, passes a write with no uid, judges the colour format (ORG-21), the INSERT door by is_org_controller(NEW.org_id) (ORG-19) and a change by is_org_controller(OLD.org_id) (ORG-17)' AS check,
       EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_node_appearance_columns' AND prosecdef
                  AND proconfig @> ARRAY['search_path=public']
                  AND prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                  AND prosrc LIKE '%NEW.color !~ ''^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$''%'
                  AND prosrc LIKE '%(TG_OP = ''INSERT'' OR NEW.color IS DISTINCT FROM OLD.color)%'
                  AND prosrc LIKE '%A folder''''s or library''''s colour must be a hex colour such as #2563eb.%'
                  AND prosrc LIKE '%IF NOT is_org_controller(NEW.org_id) THEN%'
                  AND prosrc LIKE '%NEW.cover_image_url IS DISTINCT FROM OLD.cover_image_url%'
                  AND prosrc LIKE '%NEW.cover_tint IS DISTINCT FROM OLD.cover_tint%'
                  AND prosrc LIKE '%NULLIF(NEW.page_config -> ''background'', ''null''::jsonb)%'
                  AND prosrc LIKE '%IF NOT is_org_controller(OLD.org_id) THEN%'
                  AND prosrc LIKE '%folder''''s or library''''s cover image or background.%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'trg_node_appearance_columns is a BEFORE INSERT OR UPDATE row trigger, enabled, on libraries and on collections',
       (SELECT COUNT(*) = 2 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
         WHERE tg.tgname = 'trg_node_appearance_columns' AND NOT tg.tgisinternal AND tg.tgenabled = 'O'
           AND tg.tgrelid IN ('public.libraries'::regclass, 'public.collections'::regclass)
           AND p.proname = 'enforce_node_appearance_columns'
           AND (tg.tgtype & 1) = 1      -- ROW
           AND (tg.tgtype & 2) = 2      -- BEFORE
           AND (tg.tgtype & 4) = 4      -- INSERT
           AND (tg.tgtype & 16) = 16    -- UPDATE
           AND (tg.tgtype & (8 | 32)) = 0),  -- not DELETE / TRUNCATE
       NULL
UNION ALL
SELECT 'enforce_node_appearance_columns: PUBLIC, anon and authenticated cannot execute it (a trigger function; DRLS-16)',
       NOT has_function_privilege('anon', 'enforce_node_appearance_columns()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'enforce_node_appearance_columns()', 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                        WHERE p.proname = 'enforce_node_appearance_columns' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
       NULL
UNION ALL
SELECT 'the colour rule admits every colour the node editor offers (its twelve swatches) and refuses the ORG-21 payload',
       (SELECT bool_and(c ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$')
          FROM unnest(ARRAY['#4f46e5', '#2563eb', '#0ea5e9', '#0d9488', '#059669', '#65a30d',
                            '#ea580c', '#dc2626', '#e11d48', '#db2777', '#7c3aed', '#475569']) AS c)
       AND NOT ('red, red), url(https://example.net/p.png) /*' ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'),
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
         = (SELECT n FROM ao_p15_20261216_inventory WHERE check_name = 'before: triggers on libraries other than this file''s')
       AND (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = 'public.collections'::regclass AND NOT tgisinternal AND tgname <> 'trg_node_appearance_columns')
         = (SELECT n FROM ao_p15_20261216_inventory WHERE check_name = 'before: triggers on collections other than this file''s'),
       NULL
UNION ALL
SELECT 'no policy on libraries or collections was added or dropped (counts equal those before the paste); libraries_org_access is kept',
       (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('libraries', 'collections'))
         = (SELECT n FROM ao_p15_20261216_inventory WHERE check_name = 'before: policies on libraries and collections')
       AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'libraries' AND policyname = 'libraries_org_access'),
       NULL
UNION ALL
SELECT 'the library INSERT rail (20261062) is still attached to libraries and was not re-created here',
       EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
                WHERE tg.tgrelid = 'public.libraries'::regclass AND tg.tgname = 'trg_library_insert_sensitive_columns'
                  AND p.proname = 'enforce_library_insert_sensitive_columns' AND tg.tgenabled = 'O'
                  AND p.prosrc LIKE '%recert_policy%' AND p.prosrc NOT LIKE '%cover_image_url%'),
       NULL
UNION ALL
SELECT check_name, NULL, n::text FROM ao_p15_20261216_inventory;
