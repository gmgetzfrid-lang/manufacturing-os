-- 20260617_phase9_notes.sql
--
-- Phase 9 — Scratchpad / Operational Memory.
--
-- One table — `notes`. Free-text body + optional scope FKs so a note
-- can attach to a document, project, or asset (or stand alone as an
-- org-level scratch entry). Tasks are extracted from markdown
-- checkbox syntax in the body at read time; we don't denormalize them
-- into a separate table until query patterns demand it.
--
-- The directive is explicit that this feature must work WITHOUT
-- external AI APIs. The schema reflects that — no AI-specific
-- columns. AI enhancement, when it arrives, layers on top via the
-- application's lib/ai seam; it never writes to the DB on the
-- user's behalf.

CREATE TABLE IF NOT EXISTS notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,

  -- Optional scope attachments. A note can target any combination.
  document_id   UUID REFERENCES documents(id) ON DELETE SET NULL,
  project_id   UUID REFERENCES projects(id)  ON DELETE SET NULL,
  asset_id      UUID REFERENCES assets(id)    ON DELETE SET NULL,

  -- Resolution lifecycle.
  resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at   TIMESTAMPTZ,
  resolved_by   UUID,

  -- Audit.
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    UUID NOT NULL,
  created_by_name TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_by    UUID
);

CREATE INDEX IF NOT EXISTS notes_org_idx              ON notes(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notes_document_idx         ON notes(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_project_idx          ON notes(project_id)  WHERE project_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_asset_idx            ON notes(asset_id)    WHERE asset_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_unresolved_idx       ON notes(org_id, created_at DESC) WHERE resolved = FALSE;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "notes_member_all" ON notes;
CREATE POLICY "notes_member_all" ON notes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = notes.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = notes.org_id AND uid = auth.uid() AND status = 'active'));
