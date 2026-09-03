-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Phase 6 severity sweep, Round C3: the signing ceremony
-- is minted by the server (SURF-14; document-control RG-9; drafting-flow EVID-3).
--
--   Until now e_signatures rows were inserted by the browser under
--   `e_signatures_self_insert` (signer_user_id = auth.uid() + active member):
--   anyone holding a live session — an unlocked workstation, a script — could
--   mint a signature byte-identical to a ceremonied one, and the re-auth the
--   ceremony performed was never observed server-side.
--
--   This migration:
--     1. adds reauth_method / reauth_at — set by the route, rendered by the panel;
--     2. DROPS the client INSERT policy — the only writer is now
--        /api/signatures/sign on the service-role key, which verifies the
--        re-authentication, derives the signer's identity from org_members and
--        the content hash from the version row;
--     3. installs a BEFORE INSERT guard that refuses any insert carrying a user
--        JWT, so the invariant survives a future policy being added by mistake.
--   Reading is unchanged (member SELECT); signatures stay immutable (no UPDATE
--   / DELETE policy). The roster guards (review sign-off, acknowledgment) keep
--   binding signature_id to auth.uid() on the roster UPDATE, which the browser
--   still performs — the route stamps signer_user_id from the bearer, so those
--   predicates hold exactly as before.
--
--   Ordering: apply AFTER the app that carries the route is deployed — between
--   the two, a browser-side signature attempt is refused (nothing is minted
--   wrongly; the ceremony simply fails closed until the route is live).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. the re-authentication record on the signature (RG-9 done-when 2) ─────
ALTER TABLE e_signatures ADD COLUMN IF NOT EXISTS reauth_method TEXT;
ALTER TABLE e_signatures ADD COLUMN IF NOT EXISTS reauth_at TIMESTAMPTZ;
COMMENT ON COLUMN e_signatures.reauth_method IS
  'How the signer proved it was them at the moment of signing: password (re-entered, verified server-side) or sso (provider sign-in inside the freshness window). Set by the signing route.';

-- ── 2. the client INSERT path is closed ─────────────────────────────────────
DROP POLICY IF EXISTS "e_signatures_self_insert" ON e_signatures;

-- ── 3. … and stays closed: a user-JWT insert is refused by trigger ──────────
CREATE OR REPLACE FUNCTION enforce_signature_ceremony()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Service-role writes (the signing route) carry no JWT.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'E-signatures are minted only by the signing ceremony, never by a direct insert.'
    USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS trg_signature_ceremony ON e_signatures;
CREATE TRIGGER trg_signature_ceremony
BEFORE INSERT ON e_signatures
FOR EACH ROW EXECUTE FUNCTION enforce_signature_ceremony();

COMMENT ON TABLE e_signatures IS
  'Immutable e-signatures. Minted only by /api/signatures/sign (service role) after server-side re-authentication; signer identity from org_members; content_hash from the version row. No client INSERT policy exists by design (SURF-14 / RG-9 / EVID-3).';

COMMIT;

-- ── Verification (read-only) — expect true × 5 ──────────────────────────────
SELECT 'e_signatures.reauth_method / reauth_at exist' AS check,
       (SELECT COUNT(*) = 2 FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = 'e_signatures' AND column_name IN ('reauth_method', 'reauth_at')) AS ok
UNION ALL
SELECT 'no INSERT / UPDATE / DELETE / ALL policy remains on e_signatures; the member SELECT stays',
       (SELECT COUNT(*) FILTER (WHERE cmd IN ('INSERT','UPDATE','DELETE','ALL')) = 0
          AND COUNT(*) FILTER (WHERE policyname = 'e_signatures_member_read' AND cmd = 'SELECT') = 1
          FROM pg_policies WHERE tablename = 'e_signatures')
UNION ALL
SELECT 'row-level security is enabled on e_signatures',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'e_signatures'::regclass)
UNION ALL
SELECT 'ceremony guard installed (refuses any user-JWT insert; service pass)',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_signature_ceremony' AND tgrelid = 'e_signatures'::regclass AND NOT tgisinternal)
       AND (SELECT prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
              AND prosrc LIKE '%minted only by the signing ceremony%'
              FROM pg_proc WHERE proname = 'enforce_signature_ceremony')
UNION ALL
SELECT 'the guard pins its search_path',
       (SELECT 'search_path=public' = ANY (proconfig) FROM pg_proc WHERE proname = 'enforce_signature_ceremony');

-- ── Inventory (read-only, aggregate) — run BEFORE the DDL ───────────────────
-- The client path closes for everyone at once; record what it carried.
SELECT 'e-signature rows (all orgs)' AS what, COUNT(*) AS n FROM e_signatures
UNION ALL
SELECT 'e-signature rows in the last 30 days', COUNT(*) FROM e_signatures WHERE signed_at > NOW() - INTERVAL '30 days'
UNION ALL
SELECT 'policies on e_signatures before apply (expect 2: member SELECT + self INSERT)', COUNT(*) FROM pg_policies WHERE tablename = 'e_signatures'
UNION ALL
SELECT 'INSERT policies on e_signatures before apply (expect 1)', COUNT(*) FROM pg_policies WHERE tablename = 'e_signatures' AND cmd = 'INSERT';
