-- PKG-2: an immutable PRINT SNAPSHOT for work packages.
--
-- The cover-sheet QR encoded only the package id, so /api/verify-package read
-- the LIVE pins (work_package_documents, a mutable row). Two desk actions —
-- "Refresh pins" and re-adding an already-pinned drawing — move those pins
-- with no relation to any piece of paper, so paper already in the field could
-- be flipped from STALE back to a full-screen green "PACK IS CURRENT". The
-- verdict must be computed against WHAT WAS PRINTED, not what the pins say now.
--
-- This table records, at print time, the exact version of every sheet on that
-- printed pack. The cover QR then encodes the print id; verify compares each
-- recorded version against the document's current version, so re-pinning can
-- never change the verdict for paper already distributed.
--
-- Rows are INSERT-once and never updated — a print event is a historical fact.
--
-- ⚠ APPLIED BY HAND (DEC-30). Idempotent; safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS work_package_prints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
  printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  printed_by UUID,
  printed_by_name TEXT,
  -- One row per sheet as printed: [{documentId, versionId, revLabel, label}].
  sheets JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS work_package_prints_pkg_idx
  ON work_package_prints(package_id, printed_at DESC);

ALTER TABLE work_package_prints ENABLE ROW LEVEL SECURITY;

-- Active members of the row's org may read and record prints. No UPDATE and no
-- DELETE policy exist — a print snapshot is immutable, which is the whole
-- point (a mutable snapshot would reintroduce PKG-2). The public verify path
-- reads via the service role, bypassing RLS, and returns status facts only.
DROP POLICY IF EXISTS work_package_prints_select ON work_package_prints;
CREATE POLICY work_package_prints_select ON work_package_prints FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = work_package_prints.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
);

DROP POLICY IF EXISTS work_package_prints_insert ON work_package_prints;
CREATE POLICY work_package_prints_insert ON work_package_prints FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM org_members m
    WHERE m.org_id = work_package_prints.org_id
      AND m.uid = auth.uid()
      AND m.status = 'active'
  )
);

COMMIT;

-- Verification (expect true / true):
SELECT 'work_package_prints exists' AS check,
       to_regclass('public.work_package_prints') IS NOT NULL AS ok
UNION ALL
SELECT 'no update/delete policy (immutable)',
       NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE tablename = 'work_package_prints' AND cmd IN ('UPDATE', 'DELETE')
       );
