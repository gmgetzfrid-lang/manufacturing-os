-- ─────────────────────────────────────────────────────────────────────────────
-- roles-and-permissions Round E — OWN-21 (DEC-11 row "revision_branches
-- resolution"): closing a branch debt is a controller-or-owner act.
--
-- 20260823_publish_contract.sql let ANY active org member resolve a
-- revision_branches row ("author reconciles, DocCtrl closes out"), so branch
-- debt on a controlled document could be closed as 'merged' by anyone, with
-- no owner or controller involved. DEC-11 disposes of it as a defect, not
-- dead code: resolution is restricted to an org controller (by the role
-- COLLECTION — is_org_controller) or the document's EFFECTIVE owner (the
-- database's own cascade — user_is_effective_owner, SECURITY DEFINER, so a
-- folder rung the caller cannot read is never skipped). SELECT and INSERT
-- are unchanged: the publish path still opens the debt row and everyone
-- still sees it.
--
-- NARROWING: nobody gains; members who are neither controller nor effective
-- owner lose the ability to close a branch. lib/branches.ts#resolveBranch
-- already treats zero rows as a refusal and now says so.
--
-- Single paste: BEGIN/DDL/COMMIT → one SELECT (check text, ok boolean,
-- n text). ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP POLICY IF EXISTS revision_branches_org_update ON revision_branches;
CREATE POLICY revision_branches_org_update ON revision_branches FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = revision_branches.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
  AND (
    is_org_controller(org_id)
    OR EXISTS (SELECT 1 FROM documents d
                WHERE d.id = revision_branches.document_id
                  AND user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid()))
  )
);

COMMIT;

-- ── Verification + inventory — ONE result set ───────────────────────────────
-- Probes: ok = true × 4. Inventory rows: n = the aggregate count.
SELECT 'revision_branches UPDATE is gated on is_org_controller OR the effective owner' AS check,
       (SELECT COUNT(*) = 1 FROM pg_policies
         WHERE tablename = 'revision_branches' AND policyname = 'revision_branches_org_update' AND cmd = 'UPDATE'
           AND qual LIKE '%is_org_controller(org_id)%'
           AND qual LIKE '%user_is_effective_owner(d.owner_user_id, d.collection_id, d.library_id, auth.uid())%') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the membership arm survives (an inactive member never resolves)',
       (SELECT qual LIKE '%org_members.status = ''active''%' FROM pg_policies
         WHERE tablename = 'revision_branches' AND policyname = 'revision_branches_org_update'),
       NULL::text
UNION ALL
SELECT 'exactly one UPDATE policy on revision_branches',
       (SELECT COUNT(*) = 1 FROM pg_policies WHERE tablename = 'revision_branches' AND cmd = 'UPDATE'),
       NULL::text
UNION ALL
SELECT 'SELECT and INSERT policies untouched (still present)',
       (SELECT COUNT(*) = 2 FROM pg_policies WHERE tablename = 'revision_branches'
           AND policyname IN ('revision_branches_org_select', 'revision_branches_org_insert')),
       NULL::text
UNION ALL
SELECT 'inventory: open branch debts (all orgs)', NULL::boolean, COUNT(*)::text FROM revision_branches WHERE resolved_at IS NULL
UNION ALL
SELECT 'inventory: resolved branch debts (all orgs)', NULL::boolean, COUNT(*)::text FROM revision_branches WHERE resolved_at IS NOT NULL;
