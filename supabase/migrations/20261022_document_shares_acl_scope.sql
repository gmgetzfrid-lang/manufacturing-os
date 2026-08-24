-- EGRESS-1: constrain document_shares so a share cannot name a document the
-- creator cannot read, or a document in another org.
--
-- The original policy (20260623) was a single FOR ALL gated on nothing but
-- active membership of the ROW's org_id. document_id was constrained only by
-- its foreign key — which requires the UUID to exist in `documents` in ANY
-- tenant. So a member of org A could insert a share row with org_id = A and
-- document_id = <org B's document>, and the public share routes served B's
-- bytes on token possession alone. The same FOR ALL also let any member revoke
-- or un-expire anyone else's shares.
--
-- This splits the policy per verb:
--   SELECT  — unchanged intent: any active member of the row's org may list.
--   INSERT  — active member of the row's org AND document_id is a document IN
--             THAT org that the creator can currently read. node_visible() is
--             the caller-aware read decision (it reads auth.uid() internally);
--             the explicit d.org_id = document_shares.org_id term is
--             load-bearing and must NOT be dropped — node_visible returns TRUE
--             for normal/NULL visibility without any org/membership check, so
--             the org join is what stops the cross-org case.
--   UPDATE/
--   DELETE  — the share's creator or an org controller only.
--
-- The application routes (/api/share/resolve, /api/share/file) also org-join
-- the document lookup and re-check the creator's CURRENT authority before
-- serving, so the byte leak is closed even before this migration is applied.
-- This is the durable database rail behind that.

DROP POLICY IF EXISTS document_shares_org_member ON document_shares;
DROP POLICY IF EXISTS document_shares_org_select ON document_shares;
DROP POLICY IF EXISTS document_shares_insert ON document_shares;
DROP POLICY IF EXISTS document_shares_update ON document_shares;
DROP POLICY IF EXISTS document_shares_delete ON document_shares;

CREATE POLICY document_shares_org_select ON document_shares FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = document_shares.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
);

CREATE POLICY document_shares_insert ON document_shares FOR INSERT WITH CHECK (
  EXISTS (
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

CREATE POLICY document_shares_update ON document_shares FOR UPDATE USING (
  document_shares.created_by = auth.uid()
  OR is_org_controller(document_shares.org_id)
);

CREATE POLICY document_shares_delete ON document_shares FOR DELETE USING (
  document_shares.created_by = auth.uid()
  OR is_org_controller(document_shares.org_id)
);
