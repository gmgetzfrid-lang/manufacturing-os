-- 20260902_project_intake.sql
--
-- PROJECT INTAKE — the controlled drop point for drawings/files on a
-- project, with two doors:
--   * internal (Intake tab on the project page, normal auth), and
--   * external (a tokenized /submit/<token> link for a contracted company
--     with NO site access — they see only the project's intake register and
--     their own submissions; upload-only, never delete, never browse).
--
-- Submissions become real document_versions (provenance 'external', company
-- stamped), so history/audit/compare are the same single system. Approval
-- rides the existing review-gate + finalize pipeline; a trusted link may
-- auto-supersede ITS OWN prior submissions only.
--
-- Additive + idempotent. External access happens ONLY through service-role
-- server routes gated by token possession — RLS here stays members-only.

CREATE TABLE IF NOT EXISTS project_intake_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  project_id UUID NOT NULL,
  token TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  contact_email TEXT,
  -- Trusted vendors may supersede their OWN prior submissions without
  -- review; default requires review before anything becomes current.
  allow_auto_supersede BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  submission_count INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS project_intake_links_project_idx
  ON project_intake_links (project_id);
CREATE INDEX IF NOT EXISTS project_intake_links_org_idx
  ON project_intake_links (org_id);

ALTER TABLE project_intake_links ENABLE ROW LEVEL SECURITY;

-- Members of the org may see the project's links (managing them is gated
-- app-side to controllers + the project owner); external parties never
-- touch this table directly — only the token-gated server routes do.
DROP POLICY IF EXISTS project_intake_links_select ON project_intake_links;
CREATE POLICY project_intake_links_select ON project_intake_links FOR SELECT USING (
  EXISTS (SELECT 1 FROM org_members WHERE org_id = project_intake_links.org_id
          AND uid = auth.uid() AND status = 'active')
);
DROP POLICY IF EXISTS project_intake_links_write ON project_intake_links;
CREATE POLICY project_intake_links_write ON project_intake_links FOR ALL USING (
  is_org_controller(org_id)
  OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_intake_links.project_id
             AND p.owner_user_id::text = auth.uid()::text)
) WITH CHECK (
  is_org_controller(org_id)
  OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_intake_links.project_id
             AND p.owner_user_id::text = auth.uid()::text)
);

-- The project's intake folder (auto-created on first use) and the library
-- it lives in.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS intake_collection_id UUID;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS intake_library_id UUID;

-- Which intake link (if any) authored a version — the provenance chain for
-- "may this link auto-supersede this document?" (own-work only).
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS intake_link_id UUID;
CREATE INDEX IF NOT EXISTS document_versions_intake_link_idx
  ON document_versions (intake_link_id) WHERE intake_link_id IS NOT NULL;

-- Atomic use-counter bump from the token-gated routes.
CREATE OR REPLACE FUNCTION bump_intake_use(p_link UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE project_intake_links
  SET last_used_at = NOW(), submission_count = submission_count + 1
  WHERE id = p_link;
$$;
