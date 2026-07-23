-- 20260825_work_packages_acks.sql
--
-- WORK PACKAGES + ACKNOWLEDGED DISTRIBUTION — closing the loop with how
-- refinery work actually executes.
--
-- WORK PACKAGES: field work runs as JOBS, not single drawings. A pump swap
-- needs the P&ID + iso + datasheet + one-line, all verified current AT
-- EXECUTION TIME, not when the package was assembled. A package pins the
-- revision of each member document at assembly; if any member advances
-- before the job closes, the package reads STALE and the owner is told.
-- Nothing is blocked — the package is a tripwire, not a lock.
--
-- DISTRIBUTION ACKS: notification is not acknowledgment. For safety-
-- critical revisions, Document Control needs "I sent Rev 5 to these 12
-- people — 8 have confirmed they have it." One row per (version,
-- recipient); acknowledging stamps the row. PSM-audit gold.
--
-- Additive + idempotent. Apply manually in the Supabase SQL editor.

-- ─── Work packages ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','executing','closed')),
  owner_user_id UUID NOT NULL,
  owner_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  closed_by TEXT
);

CREATE INDEX IF NOT EXISTS work_packages_org_idx
  ON work_packages(org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS work_package_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- The revision that was current when the doc joined the package. The
  -- package is FRESH while every member's current_version_id still equals
  -- its pin; any drift = STALE (computed at read time — no trigger state).
  pinned_version_id UUID REFERENCES document_versions(id),
  pinned_rev_label TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by TEXT,
  UNIQUE (package_id, document_id)
);

CREATE INDEX IF NOT EXISTS work_package_documents_pkg_idx
  ON work_package_documents(package_id);
CREATE INDEX IF NOT EXISTS work_package_documents_doc_idx
  ON work_package_documents(document_id);

ALTER TABLE work_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_package_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS work_packages_org_select ON work_packages;
CREATE POLICY work_packages_org_select ON work_packages FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_packages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
DROP POLICY IF EXISTS work_packages_org_insert ON work_packages;
CREATE POLICY work_packages_org_insert ON work_packages FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_packages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
DROP POLICY IF EXISTS work_packages_org_update ON work_packages;
CREATE POLICY work_packages_org_update ON work_packages FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_packages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
DROP POLICY IF EXISTS work_packages_org_delete ON work_packages;
CREATE POLICY work_packages_org_delete ON work_packages FOR DELETE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_packages.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

DROP POLICY IF EXISTS work_package_documents_org_select ON work_package_documents;
CREATE POLICY work_package_documents_org_select ON work_package_documents FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
DROP POLICY IF EXISTS work_package_documents_org_insert ON work_package_documents;
CREATE POLICY work_package_documents_org_insert ON work_package_documents FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
DROP POLICY IF EXISTS work_package_documents_org_delete ON work_package_documents;
CREATE POLICY work_package_documents_org_delete ON work_package_documents FOR DELETE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = work_package_documents.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

-- ─── Distribution acknowledgments ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS distribution_acks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  rev_label TEXT,
  recipient_user_id UUID NOT NULL,
  recipient_email TEXT,
  requested_by UUID NOT NULL,
  requested_by_name TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  -- One ask per (version, recipient); re-requesting refreshes, not duplicates.
  UNIQUE (version_id, recipient_user_id)
);

CREATE INDEX IF NOT EXISTS distribution_acks_doc_idx
  ON distribution_acks(document_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS distribution_acks_recipient_idx
  ON distribution_acks(recipient_user_id) WHERE (acknowledged_at IS NULL);

ALTER TABLE distribution_acks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS distribution_acks_org_select ON distribution_acks;
CREATE POLICY distribution_acks_org_select ON distribution_acks FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = distribution_acks.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
DROP POLICY IF EXISTS distribution_acks_org_insert ON distribution_acks;
CREATE POLICY distribution_acks_org_insert ON distribution_acks FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = distribution_acks.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);
-- Recipients acknowledge their own row; the requester may refresh
-- requested_at on a re-nudge. Keep it simple: any active member may update
-- (the app only ever writes acknowledged_at to rows where they are the
-- recipient, or requested_at as the requester).
DROP POLICY IF EXISTS distribution_acks_org_update ON distribution_acks;
CREATE POLICY distribution_acks_org_update ON distribution_acks FOR UPDATE USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_members.org_id = distribution_acks.org_id
          AND org_members.uid = auth.uid() AND org_members.status = 'active')
);

COMMENT ON TABLE work_packages IS
  'Job bundles: N documents with pinned revisions. Package reads STALE the moment any member document advances past its pin — a tripwire, never a lock.';
COMMENT ON TABLE distribution_acks IS
  'Acknowledged distribution: one row per (version, recipient). acknowledged_at NULL = sent but unconfirmed. Answers "prove the field knew about the change".';
