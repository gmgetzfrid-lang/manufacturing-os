-- 20260614_phase7_milestones.sql
--
-- Phase 7 — Lightweight Scheduling Layer.
--
-- A milestone is a dated checkpoint with a planned date, an actual
-- date (set when hit), and a weight (for earned-value rollup). It
-- can be scoped to a project, a document, or both. Imported P6 /
-- MS Project rows live in the same table with source='p6' or
-- 'msproject' so the UI can render them as a ghost overlay.
--
-- The directive is explicit: DO NOT build Primavera. The schema
-- intentionally excludes:
--
--   - dependency edges between milestones (no DAG)
--   - resource assignments
--   - calendar models / working-time
--   - critical-path flags
--   - any notion of cost
--
-- Schedule semantics here are: planned_at, actual_at, weight, done.
-- Anything more sophisticated belongs to a real PM tool that the
-- ghost overlay can carry the data from.
--
-- Audit events (MILESTONE_*) flow through the existing audit_logs
-- pipeline so the Phase 3 timeline picks them up automatically.

CREATE TABLE IF NOT EXISTS milestones (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- A milestone may belong to a project, a document, or both. App
  -- code requires at least one to be set; the DB stays permissive
  -- so future ad-hoc org-level milestones don't need a schema change.
  project_id            UUID REFERENCES projects(id) ON DELETE SET NULL,
  document_id           UUID REFERENCES documents(id) ON DELETE SET NULL,

  name                  TEXT NOT NULL,
  description           TEXT,
  weight                NUMERIC NOT NULL DEFAULT 1
                        CHECK (weight >= 0),

  planned_at            TIMESTAMPTZ NOT NULL,
  actual_at             TIMESTAMPTZ,

  status                TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','in_progress','completed','missed','blocked')),

  -- Decorative references — the operational link the directive asks
  -- for ("tie milestones to revisions / tickets / etc."). These are
  -- NOT FK constraints so milestones survive deletion of a related
  -- ticket, and the linked_revision_label is a string because we
  -- often want to express "Rev 3 release" before the version row
  -- even exists.
  linked_revision_label TEXT,
  linked_ticket_id      UUID REFERENCES tickets(id) ON DELETE SET NULL,

  -- Ghost overlay support. Ghosted (imported) rows have source ≠
  -- 'manual'. external_ref holds the source system's identifier so
  -- re-imports can de-dupe.
  source                TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual','p6','msproject','csv')),
  external_ref          TEXT,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  created_by            UUID NOT NULL,
  created_by_name       TEXT,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_by            UUID,
  completed_by          UUID,
  completed_by_name     TEXT,
  status_reason         TEXT
);

CREATE INDEX IF NOT EXISTS milestones_org_idx           ON milestones(org_id);
CREATE INDEX IF NOT EXISTS milestones_project_idx       ON milestones(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS milestones_document_idx      ON milestones(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS milestones_org_planned_idx   ON milestones(org_id, planned_at);
CREATE INDEX IF NOT EXISTS milestones_org_source_idx    ON milestones(org_id, source);

-- Idempotent re-import de-dupe: same (org, source, external_ref)
-- can't insert twice. Manual rows have external_ref NULL so the
-- index doesn't constrain them.
CREATE UNIQUE INDEX IF NOT EXISTS milestones_external_ref_uniq
  ON milestones(org_id, source, external_ref)
  WHERE external_ref IS NOT NULL;

ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "milestones_member_all" ON milestones;
CREATE POLICY "milestones_member_all" ON milestones
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM org_members WHERE org_id = milestones.org_id AND uid = auth.uid() AND status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM org_members WHERE org_id = milestones.org_id AND uid = auth.uid() AND status = 'active'));
