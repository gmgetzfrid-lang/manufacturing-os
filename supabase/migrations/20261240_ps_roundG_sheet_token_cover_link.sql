-- 20261240_ps_roundG_sheet_token_cover_link.sql
--
-- public-surfaces Round G — PS-P10 SHEET TOKEN PRINT LINK (public-surfaces
-- PHYS-19 done-when 3 and intelligence DACL-8 residual (c), assigned at the
-- PS-P9 merge; rulings under DEC-90).
--
-- WHY A COLUMN (and not print_id): print_sheet_tokens.print_id (20261237) is
-- the TOKEN print — the run the server mints with the tokens, the id every
-- sheet scan records (the scan log's printed_ref). A work-package pack also has
-- a cover print (work_package_prints, PKG-2: the cover QR's ?print=), which
-- the page records AFTER the sheets are stamped (PKG-6). Overloading print_id
-- with the cover's id would change what an existing column means for every
-- row already written and every scan already logged, and would leave the
-- asset hub's pack and the two "Print all" packs (no cover) with no print id
-- at all. So the link is its own nullable column, NULL for a pack without a
-- cover (DEC-90 ruling (1)).
--
-- WHAT:
--   1. print_sheet_tokens.cover_print_id — a nullable FK to
--      work_package_prints(id) ON DELETE SET NULL (a cover snapshot that is
--      gone leaves its sheets' tokens in place, unlinked), plus a partial index
--      for the recall's lookup by cover. Written by POST
--      /api/print-sheet-tokens `link` (service role) — awaited by the pack
--      path right after the cover's snapshot is recorded and BEFORE the
--      download, so a pack whose link cannot be written does not print —
--      once the server has checked the cover: same workspace, printed by the
--      caller, and its printed sheets are exactly the sheets this token print
--      is about to download, at the versions the tokens were minted for.
--      (Review fix: first built on the post-download settle, which is fired
--      and never awaited — a settle that never landed left the print unlinked
--      for good and its recall unreachable from the print history.)
--   2. print_sheet_tokens_void_reason_known re-created with one more value,
--      'recalled' — a controller's recall of a printed pack (the route's
--      `void` action, Admin / DocCtrl by the role collection, with an audit
--      row carrying the reason). 'not_printed' and 'print_aborted' are kept.
--      The scan of a recalled sheet reads print_voided — red, never green.
--   3. print_sheet_tokens_guard() re-created from its NEWEST definition
--      (20261237 — no later migration defines it; pinned by
--      lib/__tests__/psP10SheetTokenCoverLink.test.ts, which scans the folder
--      at test time) with every line kept and ONE limb added: a sheet's link
--      to its cover is written once, while the sheet is still unsettled
--      (before the download, or in the update that settles it), to a cover of
--      the same workspace; once written it never changes — except to NULL
--      when the cover row itself is gone (the FK's ON DELETE SET NULL); a
--      settled sheet is never linked after the fact.
--      Refused with 42501. Still SECURITY INVOKER (it runs as whoever updates
--      — the service role, or the FK action as the table owner); search_path
--      pinned; EXECUTE revoked from PUBLIC, anon and authenticated.
--
-- DRLS-16: this file creates NO SECURITY DEFINER function.
--
-- WIDENING? No. The table stays the service role's alone (RLS on, no
-- policy, nothing granted to anon / authenticated — re-probed below); the
-- CHECK admits one more void reason only the service-role route writes; the
-- guard gains a refusal. The before-apply inventory below is aggregate
-- counts only (never a customer row): whether this is a re-run, how many
-- tokens and token prints exist, and how many settled prints are live (what
-- a recall could reach — none of them carries a cover link yet).
--
-- PREREQUISITE: 20261237 (print_sheet_tokens). Pasted without it, the file
-- stops at step 0 and changes nothing.
--
-- PASTE / DEPLOY ORDER: either order with the PS-P10 deploy (DEC-30 — the app
-- works before and after the paste).
--   * Code deployed, file NOT pasted: a work-package pack's `link` sends its
--     cover's print id; the server meets 42703 / PGRST204 and answers
--     { available: false }, and the pack prints and settles exactly as today,
--     unlinked (nothing breaks, the print is never refused for it). A controller's recall answers "not available until
--     database update 20261240 is pasted" and changes nothing (no audit row,
--     no void). Every pack prints and scans as today.
--   * File pasted, code NOT deployed: nothing writes the column or the new
--     void reason; the guard's added limb only refuses a change no deployed
--     code makes.
--   * Every QR printed before — doc-only, ?v=, a cover's ?print=, every
--     existing sheet token — is answered exactly as today, before and after
--     the paste (DEC-90 ruling (4)); existing token rows keep a NULL link.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count).

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ps_p10_before;
CREATE TEMP TABLE _ps_p10_before (ord int, inventory text, n text);
DO $inv$
BEGIN
  INSERT INTO _ps_p10_before VALUES
    (1, 'inventory: print_sheet_tokens.cover_print_id already existed before this paste (1 = a re-run)',
     (SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'print_sheet_tokens' AND column_name = 'cover_print_id')::text);
  IF to_regclass('public.print_sheet_tokens') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO _ps_p10_before
      SELECT 2, 'inventory (informational): sheet tokens before this paste — their link stays NULL; each scans exactly as today', COUNT(*)::text FROM print_sheet_tokens
      UNION ALL
      SELECT 3, 'inventory (informational): token prints before this paste', COUNT(DISTINCT print_id)::text FROM print_sheet_tokens
      UNION ALL
      SELECT 4, 'inventory (informational): settled token prints with a live sheet before this paste (what a recall could reach by its print id)',
             COUNT(DISTINCT print_id)::text FROM print_sheet_tokens WHERE settled_at IS NOT NULL AND voided_at IS NULL
    $q$;
  ELSE
    INSERT INTO _ps_p10_before VALUES
      (2, 'inventory: print_sheet_tokens is MISSING — paste 20261237 first (this paste changes nothing)', '0');
  END IF;
END
$inv$;

BEGIN;

-- ── 0. the floor: 20261237's table must be live ──────────────────────────
DO $floor$
BEGIN
  IF to_regclass('public.print_sheet_tokens') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261237_ps_roundG_print_sheet_tokens.sql first — this file adds a column to print_sheet_tokens and re-creates its guard. Nothing was changed.';
  END IF;
END
$floor$;

-- ── 1. the link from a pack's sheet tokens to its cover's print ──────────
ALTER TABLE print_sheet_tokens
  ADD COLUMN IF NOT EXISTS cover_print_id UUID REFERENCES work_package_prints(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS print_sheet_tokens_cover_print_idx
  ON print_sheet_tokens (cover_print_id) WHERE cover_print_id IS NOT NULL;
COMMENT ON COLUMN print_sheet_tokens.cover_print_id IS
  'PHYS-19 c3 (public-surfaces PS-P10): the work_package_prints id of the cover printed with this sheet — written once, before the download (never on a settled row), after the server checked it (same org, the same printer, the cover''s printed sheets are this print''s sheets at the minted versions). NULL for a pack without a cover and for every token written before 20261240.';

-- ── 2. a controller's recall is a void reason of its own ─────────────────
ALTER TABLE print_sheet_tokens DROP CONSTRAINT IF EXISTS print_sheet_tokens_void_reason_known;
ALTER TABLE print_sheet_tokens ADD CONSTRAINT print_sheet_tokens_void_reason_known
  CHECK (void_reason IS NULL OR void_reason IN ('not_printed', 'print_aborted', 'recalled'));

-- ── 3. what a sheet printed never changes (20261237's guard + the link) ──
CREATE OR REPLACE FUNCTION print_sheet_tokens_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.print_id IS DISTINCT FROM OLD.print_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.minted_by IS DISTINCT FROM OLD.minted_by
     OR NEW.minted_at IS DISTINCT FROM OLD.minted_at THEN
    RAISE EXCEPTION 'print_sheet_tokens: what a sheet printed never changes (token, print, org, document, version, minter)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.voided_at IS NOT NULL
     AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'print_sheet_tokens: a voided print stays voided'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
    RAISE EXCEPTION 'print_sheet_tokens: a settled print stays settled'
      USING ERRCODE = '42501';
  END IF;
  -- PS-P10 (PHYS-19 c3): the link to the cover's print is written once, while
  -- the sheet is unsettled, to a cover of the same workspace, and never
  -- changes after — except to NULL once that cover row is gone (ON DELETE SET
  -- NULL).
  IF NEW.cover_print_id IS DISTINCT FROM OLD.cover_print_id THEN
    IF OLD.cover_print_id IS NOT NULL THEN
      IF NEW.cover_print_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM work_package_prints w WHERE w.id = OLD.cover_print_id) THEN
        RAISE EXCEPTION 'print_sheet_tokens: a sheet''s link to its cover''s print never changes'
          USING ERRCODE = '42501';
      END IF;
    ELSIF OLD.settled_at IS NOT NULL
          OR NOT EXISTS (SELECT 1 FROM work_package_prints w WHERE w.id = NEW.cover_print_id AND w.org_id = NEW.org_id) THEN
      RAISE EXCEPTION 'print_sheet_tokens: a sheet is linked to its cover''s print only before it is settled, and only to a cover of its own workspace'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION print_sheet_tokens_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS print_sheet_tokens_guard ON print_sheet_tokens;
CREATE TRIGGER print_sheet_tokens_guard
  BEFORE UPDATE ON print_sheet_tokens
  FOR EACH ROW EXECUTE FUNCTION print_sheet_tokens_guard();

COMMIT;

-- ── Verification + inventory (the only result set the SQL editor shows) ──
SELECT r.check, r.ok, r.n FROM (
SELECT 1 AS ord, 'print_sheet_tokens.cover_print_id exists, uuid, nullable' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'print_sheet_tokens' AND column_name = 'cover_print_id'
                  AND data_type = 'uuid' AND is_nullable = 'YES') AS ok,
       NULL::text AS n
UNION ALL SELECT 2, 'cover_print_id references work_package_prints(id) ON DELETE SET NULL',
       EXISTS (SELECT 1 FROM pg_constraint c
                WHERE c.conrelid = to_regclass('public.print_sheet_tokens') AND c.contype = 'f'
                  AND c.confrelid = to_regclass('public.work_package_prints') AND c.confdeltype = 'n'
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                         WHERE attrelid = to_regclass('public.print_sheet_tokens') AND attname = 'cover_print_id')]::int2[]), NULL
UNION ALL SELECT 3, 'print_sheet_tokens indexed on (cover_print_id) where linked',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'print_sheet_tokens_cover_print_idx'), NULL
UNION ALL SELECT 4, 'a void reason is not_printed, print_aborted or recalled (and nothing else)',
       COALESCE((SELECT pg_get_constraintdef(c.oid) LIKE '%not_printed%'
                        AND pg_get_constraintdef(c.oid) LIKE '%print_aborted%'
                        AND pg_get_constraintdef(c.oid) LIKE '%recalled%'
                   FROM pg_constraint c
                  WHERE c.conrelid = to_regclass('public.print_sheet_tokens') AND c.conname = 'print_sheet_tokens_void_reason_known'), false), NULL
UNION ALL SELECT 5, 'print_sheet_tokens_guard: SECURITY INVOKER, search_path pinned, 20261237''s limbs kept and the cover-link limb added — linked only before the settle (42501)',
       COALESCE((SELECT NOT p.prosecdef
                        AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                        AND p.prosrc LIKE '%NEW.version_id IS DISTINCT FROM OLD.version_id%'
                        AND p.prosrc LIKE '%a voided print stays voided%'
                        AND p.prosrc LIKE '%a settled print stays settled%'
                        AND p.prosrc LIKE '%link to its cover''''s print never changes%'
                        AND p.prosrc LIKE '%w.org_id = NEW.org_id%'
                        AND p.prosrc LIKE '%ELSIF OLD.settled_at IS NOT NULL%'
                        AND p.prosrc LIKE '%only before it is settled%'
                        AND p.prosrc LIKE '%ERRCODE = ''42501''%'
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'print_sheet_tokens_guard'), false), NULL
UNION ALL SELECT 6, 'print_sheet_tokens_guard: anon and authenticated may not execute it',
       NOT has_function_privilege('anon', 'public.print_sheet_tokens_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.print_sheet_tokens_guard()', 'EXECUTE'), NULL
UNION ALL SELECT 7, 'print_sheet_tokens_guard is bound BEFORE UPDATE FOR EACH ROW on print_sheet_tokens',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = to_regclass('public.print_sheet_tokens') AND t.tgname = 'print_sheet_tokens_guard'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND t.tgfoid = to_regprocedure('public.print_sheet_tokens_guard()')
                  AND (t.tgtype & 2) = 2 AND (t.tgtype & 1) = 1 AND (t.tgtype & 16) = 16), NULL
UNION ALL SELECT 8, 'print_sheet_tokens is still the service role''s alone (RLS on, no policy, nothing for anon / authenticated)',
       EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.print_sheet_tokens') AND relrowsecurity)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'print_sheet_tokens')
       AND NOT has_table_privilege('anon', 'public.print_sheet_tokens', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_table_privilege('authenticated', 'public.print_sheet_tokens', 'SELECT, INSERT, UPDATE, DELETE'), NULL
UNION ALL SELECT 100 + ord, inventory, NULL, n FROM _ps_p10_before
) r ORDER BY r.ord;
