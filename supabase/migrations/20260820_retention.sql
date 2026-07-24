-- 20260820_retention.sql
--
-- Records management: retention, disposition, and legal hold.
--   * Retention policy — how long a controlled record must be kept, from a basis
--     date (created / issued / superseded / effective). Inherits doc > folder >
--     library, most-specific-wins, like the other control policies.
--   * Disposition — once past retention a record becomes ELIGIBLE for disposition
--     (review / archive / destroy). Disposition is always an explicit, logged act
--     by Admin/DocCtrl — records are never auto-destroyed.
--   * Legal hold — freezes a record so it CANNOT be deleted or disposed,
--     regardless of retention, for litigation/investigation. Enforced in the app
--     delete/dispose paths.
--
-- Additive + idempotent. Dated after 20260819.

-- Retention policy (JSONB): { enabled, years, basis, action }
--   basis  = 'created' | 'issued' | 'superseded' | 'effective'
--   action = 'review' | 'archive' | 'destroy'   (what to do at end of life)
ALTER TABLE libraries   ADD COLUMN IF NOT EXISTS retention_policy JSONB;
ALTER TABLE collections ADD COLUMN IF NOT EXISTS retention_policy JSONB;
ALTER TABLE documents   ADD COLUMN IF NOT EXISTS retention_policy JSONB;

-- Denormalized retention state on the document (cheap pill / scan / register).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retention_until DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS disposition_state TEXT
  CHECK (disposition_state IN ('active', 'eligible', 'disposed'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS disposed_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retention_notified_at TIMESTAMPTZ;

-- Legal hold — the enforced freeze flag + who/why.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold_matter TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold_reason TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold_by UUID;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS documents_retention_idx ON documents(org_id, disposition_state, retention_until);
CREATE INDEX IF NOT EXISTS documents_legal_hold_idx ON documents(org_id) WHERE legal_hold = true;

-- Audit trail for retention/disposition/legal-hold acts (distinct from the file
-- version history — this is the records-management record).
CREATE TABLE IF NOT EXISTS document_disposition_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  scope_type TEXT,                    -- 'library' | 'collection' | 'document' (policy/hold set at a level)
  scope_id UUID,
  action TEXT NOT NULL,               -- 'retention_set' | 'hold_placed' | 'hold_released' | 'disposed'
  matter TEXT,
  reason TEXT,
  detail JSONB,
  performed_by UUID,
  performed_by_name TEXT,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS doc_disposition_events_doc_idx ON document_disposition_events(document_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS doc_disposition_events_org_idx ON document_disposition_events(org_id, performed_at DESC);

ALTER TABLE document_disposition_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "doc_disposition_events_member" ON document_disposition_events;
CREATE POLICY "doc_disposition_events_member" ON document_disposition_events
  FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_disposition_events.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = document_disposition_events.org_id AND uid = auth.uid() AND status = 'active'));
