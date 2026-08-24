-- EGRESS-1 follow-up (2026-08-24 adversarial review): document_shares.created_by
-- is the share's AUTHORITY ANCHOR — /api/share/resolve and /api/share/file
-- serve bytes only while shareStillAuthorized(org, created_by, doc) holds, and
-- download_audits attributes every access to it. 20261022 constrained which
-- DOCUMENT a share may name, but left two ways to lie about the anchor:
--
--   1. INSERT never bound created_by to the caller. Any active member could
--      insert a share via PostgREST with created_by = an Admin's uid
--      (member-readable org_members makes uids enumerable); the share then
--      short-circuits on isController FOREVER — surviving the real author's
--      lockout or removal — and audits attribute to the impersonated Admin.
--   2. UPDATE carried no WITH CHECK, so Postgres reused USING (creator-or-
--      controller), which keeps passing after the row is REPOINTED at another
--      document — or another org — re-opening at the DB layer the exact hole
--      the INSERT rail closed.
--
-- Fix: bind created_by = auth.uid() at INSERT (same idiom as
-- transmittals_insert / process_flows_insert); make the anchor columns
-- immutable with a BEFORE UPDATE trigger (a share is revoked or extended,
-- never repointed — and unlike a WITH CHECK re-running node_visible(), the
-- trigger never blocks a creator revoking a share on a document they have
-- since lost read access to, which is exactly the share that most needs
-- revoking); and give UPDATE an explicit WITH CHECK so the row's actor gate
-- is stated rather than inherited.
--
-- App flow unaffected: createShareLink already inserts the session uid, and
-- revoke/extend touch revoked_at / revoked_by / expires_at / note only.
-- Service-role writes bypass the policies but NOT the trigger — no
-- service-role path repoints shares.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

DROP POLICY IF EXISTS document_shares_insert ON document_shares;
CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (
  document_shares.created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = document_shares.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_shares.document_id
      AND d.org_id = document_shares.org_id
      AND node_visible(d.visibility, d.acl_index, d.org_id)
  )
);

DROP POLICY IF EXISTS document_shares_update ON document_shares;
CREATE POLICY document_shares_update ON document_shares FOR UPDATE
USING (
  document_shares.created_by = auth.uid()
  OR is_org_controller(document_shares.org_id)
)
WITH CHECK (
  document_shares.created_by = auth.uid()
  OR is_org_controller(document_shares.org_id)
);

-- Not SECURITY DEFINER (it only reads OLD/NEW); search_path pinned anyway so
-- an EXCEPTION message can never resolve against caller-schema shadows.
CREATE OR REPLACE FUNCTION document_shares_anchor_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.org_id      IS DISTINCT FROM OLD.org_id
     OR NEW.created_by  IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'document_shares: document_id, org_id and created_by are immutable — revoke this share and create a new one';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_shares_anchor_guard ON document_shares;
CREATE TRIGGER document_shares_anchor_guard
BEFORE UPDATE ON document_shares
FOR EACH ROW EXECUTE FUNCTION document_shares_anchor_immutable();

COMMIT;

-- Verification (read-only; expect the three rows to say true / true / true):
SELECT 'insert binds created_by' AS check,
       (SELECT with_check LIKE '%created_by = auth.uid()%' FROM pg_policies
         WHERE tablename = 'document_shares' AND policyname = 'document_shares_insert') AS ok
UNION ALL
SELECT 'update has explicit WITH CHECK',
       (SELECT with_check IS NOT NULL FROM pg_policies
         WHERE tablename = 'document_shares' AND policyname = 'document_shares_update')
UNION ALL
SELECT 'anchor trigger installed',
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'document_shares_anchor_guard' AND NOT tgisinternal);
