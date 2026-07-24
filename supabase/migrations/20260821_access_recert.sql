-- 20260821_access_recert.sql
--
-- Access recertification. On a cadence (e.g. every 6 months) the accountable
-- owner / Admin / DocCtrl must REVIEW who has access to a library and attest that
-- it's still appropriate — the periodic "does everyone on this list still need to
-- be on it?" control an ISO 27001 / SOC 2 audit expects. The attestation
-- snapshots the access list at that moment for the record.
--
-- Library-scoped (access is granted on the library ACL). Additive + idempotent.
-- Dated after 20260820.

-- Policy (JSONB): { enabled: bool, intervalMonths: int }
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS recert_policy JSONB;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS last_recertified_at TIMESTAMPTZ;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS last_recertified_by UUID;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS next_recertification_date DATE;
ALTER TABLE libraries ADD COLUMN IF NOT EXISTS recert_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS libraries_recert_idx
  ON libraries(org_id, next_recertification_date) WHERE next_recertification_date IS NOT NULL;

-- Each recertification (or policy change) — with a snapshot of who had access.
CREATE TABLE IF NOT EXISTS access_recertification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  library_id UUID REFERENCES libraries(id) ON DELETE CASCADE,
  action TEXT NOT NULL,               -- 'recertified' | 'policy_set'
  grants_snapshot JSONB,              -- the access list attested at this moment
  grant_count INTEGER,
  note TEXT,
  next_recertification_date DATE,
  performed_by UUID,
  performed_by_name TEXT,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS access_recert_events_lib_idx ON access_recertification_events(library_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS access_recert_events_org_idx ON access_recertification_events(org_id, performed_at DESC);

ALTER TABLE access_recertification_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "access_recert_events_member" ON access_recertification_events;
CREATE POLICY "access_recert_events_member" ON access_recertification_events
  FOR ALL
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = access_recertification_events.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = access_recertification_events.org_id AND uid = auth.uid() AND status = 'active'));
