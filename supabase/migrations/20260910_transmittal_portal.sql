-- 20260910_transmittal_portal.sql
--
-- TRANSMITTAL PORTAL + hardening (transmittals audit remediation):
--
--   1. Portal columns: an unguessable token turns each ISSUED transmittal
--      into an isolated external link (same pattern as project intake) —
--      the contractor opens /transmittal/<token> with no account, sees the
--      official sheet, downloads the as-sent files, and acknowledges
--      receipt THEMSELVES (their-side, timestamped proof — previously an
--      org member typed the recipient's name on their behalf).
--   2. acknowledged_via distinguishes a portal acknowledgment ('portal')
--      from an internally recorded one ('manual'); acknowledged_meta keeps
--      what the server saw (IP/user agent) for the receipt's weight.
--   3. RLS hardening: the old any-member FOR ALL policy let a Viewer
--      issue, void, or acknowledge contractual records. Now: members read,
--      members create their OWN drafts, and only the creator or a
--      controller (Admin/DocCtrl) may update/delete.
--
-- Additive + idempotent. Apply after 20260908.

ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS portal_token TEXT;
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS acknowledged_via TEXT
  CHECK (acknowledged_via IS NULL OR acknowledged_via IN ('portal','manual'));
ALTER TABLE transmittals ADD COLUMN IF NOT EXISTS acknowledged_meta JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS transmittals_portal_token_idx
  ON transmittals (portal_token) WHERE portal_token IS NOT NULL;

-- ── RLS split ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "transmittals_member_all" ON transmittals;
DROP POLICY IF EXISTS transmittals_member_all ON transmittals;

DROP POLICY IF EXISTS transmittals_select ON transmittals;
CREATE POLICY transmittals_select ON transmittals FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id
          AND uid = auth.uid() AND status = 'active')
);

DROP POLICY IF EXISTS transmittals_insert ON transmittals;
CREATE POLICY transmittals_insert ON transmittals FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND EXISTS (SELECT 1 FROM org_members WHERE org_id = transmittals.org_id
              AND uid = auth.uid() AND status = 'active')
);

DROP POLICY IF EXISTS transmittals_update ON transmittals;
CREATE POLICY transmittals_update ON transmittals FOR UPDATE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
) WITH CHECK (
  is_org_controller(org_id) OR created_by = auth.uid()
);

DROP POLICY IF EXISTS transmittals_delete ON transmittals;
CREATE POLICY transmittals_delete ON transmittals FOR DELETE USING (
  is_org_controller(org_id) OR created_by = auth.uid()
);
