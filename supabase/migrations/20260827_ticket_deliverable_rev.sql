-- 20260827_ticket_deliverable_rev.sql
--
-- DELIVERABLE REVISIONS for the drafting portal — autonomous, like document
-- control's rev chain.
--
-- The scheme (industry-standard letter-draft / number-issue hybrid):
--   * First submission for review        → Rev 1A
--   * Resubmitted in the same cycle      → 1B, 1C, …
--   * APPROVED                           → Rev 1   (letter drops = issued)
--   * Revision requested, resubmitted    → Rev 2A
--   * Approved again                     → Rev 2   … and so on.
--
-- Nobody types these — computeTransition assigns them from the workflow
-- events (submit / approve / request-revision). deliverable_rev is the
-- display value; draft_iteration is the letter counter within the current
-- cycle (reset on each revision request). revision_count (existing) remains
-- the cycle counter.
--
-- Also powers /verify-ticket: a QR on a handed-out deliverable answers
-- "is this still the latest issue of this ticket?" — the PM-forgot-to-
-- forward-the-new-one problem, solved with a phone scan.
--
-- Additive + idempotent. Apply in the Supabase SQL editor.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deliverable_rev TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS draft_iteration INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN tickets.deliverable_rev IS
  'Autonomous deliverable revision: NA while in review (1A, 1B, 2A…), bare N once approved (1, 2…). Assigned by the workflow, never typed.';
COMMENT ON COLUMN tickets.draft_iteration IS
  'Letter counter within the current review cycle (1=A, 2=B…). Reset to 0 when a revision is requested.';
