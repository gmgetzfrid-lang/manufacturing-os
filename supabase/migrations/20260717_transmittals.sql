-- 20260717_transmittals.sql
--
-- Transmittals: the formal, numbered record of ISSUING a set of documents
-- (each at a specific revision) to a party for a stated purpose. This is the
-- canonical engineering / construction document-control artifact — the
-- contractual proof of "we sent you P-101 Rev C for construction on this
-- date." A transmittal carries a cover sheet (the document list + purpose +
-- recipient) and tracks receipt acknowledgement.
--
-- The document list lives in `items` (JSONB) rather than a child table:
-- a transmittal is a point-in-time SNAPSHOT — it must record the rev that was
-- sent even after the document revs forward, so denormalizing the
-- number/title/rev into the row is correct (and survives the doc being
-- deleted). Each item: { documentId, number, title, rev, versionId? }.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS transmittals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,

  -- Per-org human sequence. `seq` is the integer used to compute the next
  -- number; `number` is the formatted label (e.g. TR-0001) shown to users.
  seq INTEGER NOT NULL,
  number TEXT NOT NULL,

  subject TEXT,
  recipient_name TEXT,
  recipient_company TEXT,
  recipient_email TEXT,

  -- For Review / For Construction / For Approval / For Information / For Record
  purpose TEXT,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','issued','acknowledged','voided')),

  notes TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_by UUID,
  created_by_name TEXT,
  issued_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_name TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One number per org; lets the app retry-on-conflict if two people draft at once.
CREATE UNIQUE INDEX IF NOT EXISTS transmittals_org_number_idx ON transmittals(org_id, number);
CREATE INDEX IF NOT EXISTS transmittals_org_status_idx ON transmittals(org_id, status, created_at DESC);

-- ─── RLS — org members only (mirrors markup_requests / project_activity) ────
ALTER TABLE transmittals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "transmittals_member_all" ON transmittals;
CREATE POLICY "transmittals_member_all" ON transmittals
  FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id AND uid = auth.uid() AND status = 'active'));
