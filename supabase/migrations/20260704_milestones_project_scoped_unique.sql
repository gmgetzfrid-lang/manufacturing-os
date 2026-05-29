-- 20260704_milestones_project_scoped_unique.sql
--
-- Real bug found in the field: a user imported the same .mpp into
-- two different projects within the same org. The original unique
-- index on (org_id, source, external_ref) treated the external_ref
-- as globally unique within the org, so the SECOND import found
-- existing rows (from the FIRST project) and UPDATED them in place
-- instead of inserting new rows for the new project. Net effect:
-- new project ended up with zero milestones, schedule view was
-- empty, user confused.
--
-- Fix: scope uniqueness to (org_id, project_id, source, external_ref)
-- when project_id is set, and (org_id, document_id, source, external_ref)
-- when document_id is set. Same .mpp can now land on multiple projects
-- legitimately; each project gets its own copy of the rows.

DROP INDEX IF EXISTS milestones_external_ref_uniq;

-- Project-scoped uniqueness. The same external_ref CAN appear once
-- per project per (org, source).
CREATE UNIQUE INDEX IF NOT EXISTS milestones_external_ref_per_project_uniq
  ON milestones(org_id, project_id, source, external_ref)
  WHERE external_ref IS NOT NULL AND project_id IS NOT NULL;

-- Document-scoped uniqueness for milestones anchored to a document
-- rather than a project (less common but supported by the schema).
CREATE UNIQUE INDEX IF NOT EXISTS milestones_external_ref_per_document_uniq
  ON milestones(org_id, document_id, source, external_ref)
  WHERE external_ref IS NOT NULL AND document_id IS NOT NULL;

-- Org-level free-floating milestones (neither project nor document
-- anchored — rare) keep the original semantics: globally unique per
-- (org, source).
CREATE UNIQUE INDEX IF NOT EXISTS milestones_external_ref_org_unanchored_uniq
  ON milestones(org_id, source, external_ref)
  WHERE external_ref IS NOT NULL AND project_id IS NULL AND document_id IS NULL;
