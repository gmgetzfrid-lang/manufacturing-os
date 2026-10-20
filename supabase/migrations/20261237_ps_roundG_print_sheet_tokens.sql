-- 20261237_ps_roundG_print_sheet_tokens.sql
--
-- public-surfaces Round G — PS-P9 PER-PRINT SHEET TOKEN (intelligence
-- DACL-8 criterion 2, assigned at the I-12 merge; rulings under DEC-90).
--
-- WHAT:
--   1. print_sheet_tokens — one row per sheet of a printed field pack: the
--      SHA-256 of a random bearer token the server mints at print time (the
--      token itself is printed in the sheet's verify QR and never stored),
--      the print run it belongs to (print_id, minted by the server), and
--      exactly what that sheet printed: the document and the version. The
--      public /api/verify resolves a scanned token to (document, version,
--      print) and answers current / stale / superseded for THAT print; a
--      token whose print was voided (the pack was never completed, or the
--      sheet did not make it into the PDF) reads stale, never green.
--      RLS ON with NO policies, and every table privilege revoked from anon
--      and authenticated: SERVICE ROLE ONLY — written by
--      /api/print-sheet-tokens (mint / settle) after it has checked the
--      caller's session and membership, read by /api/verify. Never
--      client-writable (the verify_scans / intake_attempts shape, 20261134 /
--      20261105).
--      Foreign keys: the org, the document and the version, each ON DELETE
--      CASCADE — a token whose document or version is gone answers
--      "Unknown code" (404, never green), exactly as a ?v= QR naming a
--      deleted version does today.
--   2. print_sheet_tokens_guard() + its BEFORE UPDATE trigger — what a sheet
--      printed is a historical fact: the token hash, the print, the org, the
--      document, the version, who minted it and when never change; a void
--      is one-way (never cleared or re-reasoned) and so is the settle. Refused
--      with 42501. SECURITY INVOKER (it reads nothing; it runs as whoever
--      updates — the service role); search_path pinned; EXECUTE revoked from
--      PUBLIC, anon and authenticated.
--
-- DRLS-16: this file creates NO SECURITY DEFINER function. The only function
-- is the INVOKER guard above (search_path pinned, EXECUTE revoked anyway).
--
-- WIDENING? No. A new table nobody but the service role can read or write,
-- and a trigger function nobody else may execute; nothing existing is
-- re-created or altered (no earlier migration defines print_sheet_tokens or
-- print_sheet_tokens_guard — pinned by lib/__tests__/psP9SheetTokens.test.ts,
-- which scans the folder at test time). The before-apply inventory below
-- (aggregate counts only, never a customer row) says whether this paste is a
-- first apply or a re-run; it is dropped and re-captured on every paste.
--
-- PASTE / DEPLOY ORDER: either order works (DEC-30 — the app works before
-- and after the paste).
--   * Code deployed, file NOT pasted: the print path asks
--     /api/print-sheet-tokens for tokens; the insert answers 42P01 /
--     PGRST205, the route says "unavailable", and every sheet is stamped
--     with today's QR (/verify/<document>?v=<version>) — nothing breaks, the
--     print is not refused. /api/verify answers a token it cannot resolve
--     as "Unknown code" (none can exist yet).
--   * File pasted, code NOT deployed: nothing reads or writes the table.
--   * Every QR printed before this package — a doc-only QR, a ?v= QR, a pack
--     cover's ?print= — is answered exactly as today, before and after the
--     paste (DEC-90 ruling (2)).
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent: paste the whole file once into the
-- Supabase SQL editor. The editor shows only the LAST result set — the one
-- final SELECT carries every probe (ok true/false, n NULL) and the inventory
-- counts (ok NULL, n the count).

-- ── Before-apply inventory (aggregate counts only) ───────────────────────
DROP TABLE IF EXISTS pg_temp._ps_p9_before;
CREATE TEMP TABLE _ps_p9_before AS
SELECT 1 AS ord, 'inventory: print_sheet_tokens already existed before this paste (1 = a re-run)' AS inventory,
       (CASE WHEN to_regclass('public.print_sheet_tokens') IS NULL THEN 0 ELSE 1 END)::text AS n
UNION ALL
SELECT 2, 'inventory: print_sheet_tokens_guard() already existed before this paste',
       COUNT(*)::text FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.proname = 'print_sheet_tokens_guard'
UNION ALL
SELECT 3, 'inventory: policies on print_sheet_tokens before this paste (must be 0 — service role only)',
       COUNT(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'print_sheet_tokens'
UNION ALL
SELECT 4, 'inventory (informational): pack prints recorded before this paste — their sheet QRs keep the document + version form and are answered exactly as today',
       COUNT(*)::text FROM work_package_prints;

BEGIN;

-- ── 1. the per-print sheet token ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS print_sheet_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT NOT NULL,          -- hex SHA-256 of the printed bearer token (the token is never stored)
  print_id    UUID NOT NULL,          -- the print run, minted by the server with the tokens
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id  UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  minted_by   UUID,                   -- the signed-in member who printed (auth uid)
  minted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at  TIMESTAMPTZ,            -- the print reported which sheets left in the PDF
  voided_at   TIMESTAMPTZ,            -- this sheet's paper never left: it reads stale
  void_reason TEXT,
  CONSTRAINT print_sheet_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT print_sheet_tokens_print_document_key UNIQUE (print_id, document_id),
  CONSTRAINT print_sheet_tokens_token_hash_hex CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT print_sheet_tokens_void_reason_known CHECK (void_reason IS NULL OR void_reason IN ('not_printed', 'print_aborted')),
  CONSTRAINT print_sheet_tokens_void_pair CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS print_sheet_tokens_print_idx ON print_sheet_tokens (print_id);
CREATE INDEX IF NOT EXISTS print_sheet_tokens_document_idx ON print_sheet_tokens (document_id);
ALTER TABLE print_sheet_tokens ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only. The default grants Supabase
-- gives new tables are withdrawn too, so RLS is not the only wall.
REVOKE ALL ON TABLE print_sheet_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE print_sheet_tokens TO service_role;
COMMENT ON TABLE print_sheet_tokens IS
  'DACL-8 c2 (public-surfaces PS-P9): one row per sheet of a printed field pack — the SHA-256 of the per-print bearer token in its verify QR, the print run, and the document + version that sheet printed. /api/verify answers a scanned token for that print (a voided print reads stale). Service role only; never client-writable.';

-- ── 2. what a sheet printed never changes ────────────────────────────────
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
SELECT 1 AS ord, 'print_sheet_tokens exists with RLS on and NO policies (service role only)' AS check,
       EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.print_sheet_tokens') AND relrowsecurity)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'print_sheet_tokens') AS ok,
       NULL::text AS n
UNION ALL SELECT 2, 'print_sheet_tokens: anon and authenticated hold no SELECT / INSERT / UPDATE / DELETE (never client-writable)',
       NOT has_table_privilege('anon', 'public.print_sheet_tokens', 'SELECT, INSERT, UPDATE, DELETE')
       AND NOT has_table_privilege('authenticated', 'public.print_sheet_tokens', 'SELECT, INSERT, UPDATE, DELETE'), NULL
UNION ALL SELECT 3, 'print_sheet_tokens: the service role may SELECT, INSERT and UPDATE',
       has_table_privilege('service_role', 'public.print_sheet_tokens', 'SELECT')
       AND has_table_privilege('service_role', 'public.print_sheet_tokens', 'INSERT')
       AND has_table_privilege('service_role', 'public.print_sheet_tokens', 'UPDATE'), NULL
UNION ALL SELECT 4, 'print_sheet_tokens carries id, token_hash, print_id, org_id, document_id, version_id, minted_by, minted_at, settled_at, voided_at, void_reason',
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'print_sheet_tokens'
           AND column_name IN ('id', 'token_hash', 'print_id', 'org_id', 'document_id', 'version_id', 'minted_by', 'minted_at', 'settled_at', 'voided_at', 'void_reason')) = 11, NULL
UNION ALL SELECT 5, 'print_sheet_tokens: the token hash is unique and hex SHA-256; one sheet per document per print; a void carries its reason',
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conrelid = to_regclass('public.print_sheet_tokens')
           AND conname IN ('print_sheet_tokens_token_hash_key', 'print_sheet_tokens_print_document_key', 'print_sheet_tokens_token_hash_hex',
                           'print_sheet_tokens_void_reason_known', 'print_sheet_tokens_void_pair')) = 5, NULL
UNION ALL SELECT 6, 'print_sheet_tokens: org, document and version foreign keys, each ON DELETE CASCADE',
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conrelid = to_regclass('public.print_sheet_tokens') AND contype = 'f' AND confdeltype = 'c'
           AND confrelid IN (to_regclass('public.orgs'), to_regclass('public.documents'), to_regclass('public.document_versions'))) = 3, NULL
UNION ALL SELECT 7, 'print_sheet_tokens indexed on (print_id) and (document_id)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'print_sheet_tokens_print_idx')
       AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'print_sheet_tokens_document_idx'), NULL
UNION ALL SELECT 8, 'print_sheet_tokens_guard: SECURITY INVOKER (no definer in this file — DRLS-16), search_path pinned, refuses a changed print fact with 42501',
       COALESCE((SELECT NOT p.prosecdef
                        AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                        AND p.prosrc LIKE '%NEW.version_id IS DISTINCT FROM OLD.version_id%'
                        AND p.prosrc LIKE '%a voided print stays voided%'
                        AND p.prosrc LIKE '%ERRCODE = ''42501''%'
                   FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                  WHERE ns.nspname = 'public' AND p.proname = 'print_sheet_tokens_guard'), false), NULL
UNION ALL SELECT 9, 'print_sheet_tokens_guard: anon and authenticated may not execute it',
       NOT has_function_privilege('anon', 'public.print_sheet_tokens_guard()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.print_sheet_tokens_guard()', 'EXECUTE'), NULL
UNION ALL SELECT 10, 'print_sheet_tokens_guard is bound BEFORE UPDATE FOR EACH ROW on print_sheet_tokens',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = to_regclass('public.print_sheet_tokens') AND t.tgname = 'print_sheet_tokens_guard'
                  AND NOT t.tgisinternal AND t.tgenabled <> 'D'
                  AND t.tgfoid = to_regprocedure('public.print_sheet_tokens_guard()')
                  AND (t.tgtype & 2) = 2 AND (t.tgtype & 1) = 1 AND (t.tgtype & 16) = 16), NULL
UNION ALL SELECT 100 + ord, inventory, NULL, n FROM _ps_p9_before
) r ORDER BY r.ord;
