-- 20260830_publisher_row_management.sql
--
-- FOLLOW-UP to 20260828's own-row RLS hardening. That migration correctly
-- stopped org members from signing each other's review/ack rows, but its
-- UPDATE policies only allowed: the row's own reviewer/assignee, controllers
-- (Admin/DocCtrl), and the document's EFFECTIVE OWNER. A GRANTED PUBLISHER
-- (per-library publish authority via libraries.acl_index — the
-- user_can_publish_on_library() path) legitimately performs four bulk row
-- managements as part of publishing, and all four silently matched zero rows
-- for them:
--
--   1. Direct publish over an in-review draft: void the stale draft's
--      sign-off roster (lib/revisions.ts).
--   2. New draft resubmitted (2A -> 2B): invalidate the prior draft's
--      sign-offs so stale approvals can't carry over (lib/reviewControl.ts).
--   3. Finalize after review: close out still-pending standby rows
--      (lib/reviewControl.ts).
--   4. Ack roster recompute on issue: void pending read-&-understood rows
--      that belong to an older revision (lib/acknowledgments.ts).
--
-- "Silently" is the dangerous part: RLS returns 0 matched rows, not an
-- error, so stale PENDING sign-offs and acks survived and kept feeding the
-- daily scans and inboxes. This adds the missing branch to both UPDATE
-- policies: a user with publish authority on the document's library may
-- manage its rows — exactly mirroring the publish-guard trigger's authority
-- model (20260822). Signing someone else's row is still impossible for
-- everyone without that authority.
--
-- Additive + idempotent. Apply in the Supabase SQL editor AFTER 20260828.

-- ─── 1. document_review_signoffs: publishers may manage rows ─────────────

DROP POLICY IF EXISTS doc_review_signoff_update ON document_review_signoffs;
CREATE POLICY doc_review_signoff_update ON document_review_signoffs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (
    reviewer_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
               AND uid = auth.uid() AND status = 'active' AND role IN ('Admin','DocCtrl'))
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_review_signoffs.document_id
               AND (
                 user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
                 OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)
               ))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_review_signoffs.org_id
          AND uid = auth.uid() AND status = 'active')
);

-- ─── 2. document_acknowledgments: publishers may manage rows ─────────────

DROP POLICY IF EXISTS doc_ack_update ON document_acknowledgments;
CREATE POLICY doc_ack_update ON document_acknowledgments FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
  AND (
    assignee_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
               AND uid = auth.uid() AND status = 'active' AND role IN ('Admin','DocCtrl'))
    OR EXISTS (SELECT 1 FROM documents d WHERE d.id = document_acknowledgments.document_id
               AND (
                 user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())
                 OR user_can_publish_on_library(d.library_id, auth.uid()::text, d.org_id)
               ))
  )
) WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = document_acknowledgments.org_id
          AND uid = auth.uid() AND status = 'active')
);
