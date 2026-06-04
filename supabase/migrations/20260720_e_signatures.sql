-- 20260720_e_signatures.sql
--
-- Formal, attributable e-signatures — the "sign-here ceremony with intent
-- capture" a PSM / ISO 9001 document-control product needs. Distinct from the
-- audit log (which records that an action happened): a signature records that a
-- specific person, at a specific time, DELIBERATELY affirmed a specific intent
-- ("Approved for Construction") against a specific artifact, having typed their
-- name to confirm. The content_hash binds the signature to the exact file/
-- version content that was signed, so a later change can't silently ride on an
-- old approval.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS e_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- What was signed (free-form resource pointer, mirrors audit_logs).
  resource_type TEXT NOT NULL,           -- 'document' | 'document_version' | 'ticket' | 'transmittal'
  resource_id   UUID NOT NULL,
  -- Optional binding to the exact version + its content hash.
  document_version_id UUID,
  content_hash TEXT,

  -- The ceremony.
  intent     TEXT NOT NULL,              -- 'Approved' | 'Reviewed' | 'Rejected' | 'Witnessed' | ...
  statement  TEXT NOT NULL,              -- the plain-language meaning the signer affirmed
  signer_user_id UUID NOT NULL,
  signer_name    TEXT NOT NULL,          -- the name the signer typed to confirm
  signer_role    TEXT,
  signer_email   TEXT,

  -- Best-effort provenance (set by the app when available).
  user_agent TEXT,

  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS e_signatures_resource_idx
  ON e_signatures(resource_type, resource_id, signed_at DESC);
CREATE INDEX IF NOT EXISTS e_signatures_org_idx
  ON e_signatures(org_id, signed_at DESC);

ALTER TABLE e_signatures ENABLE ROW LEVEL SECURITY;

-- Read: any active org member. Insert: the signer themselves (a signature must
-- be the authenticated user's own act). Signatures are immutable — no UPDATE/
-- DELETE policy is granted, so they can't be altered or removed after the fact.
DROP POLICY IF EXISTS "e_signatures_member_read" ON e_signatures;
CREATE POLICY "e_signatures_member_read" ON e_signatures
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = e_signatures.org_id AND uid = auth.uid() AND status = 'active'));

DROP POLICY IF EXISTS "e_signatures_self_insert" ON e_signatures;
CREATE POLICY "e_signatures_self_insert" ON e_signatures
  FOR INSERT
  WITH CHECK (
    signer_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM org_members WHERE org_id = e_signatures.org_id AND uid = auth.uid() AND status = 'active')
  );
