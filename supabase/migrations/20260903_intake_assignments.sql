-- 20260903_intake_assignments.sql
--
-- EXT2: a contractor submit link can be ASSIGNED existing controlled
-- documents — "you are responsible for revising these drawings of ours."
-- Assigned documents appear on their portal register and accept revision
-- submissions, but ALWAYS through review (the trusted auto-supersede
-- shortcut stays restricted to documents the link itself authored — an
-- outside company never silently supersedes an org-authored controlled
-- drawing).
--
-- ALSO REQUIRED FOR 20260902 TO WORK AT ALL: document_versions.provenance
-- carries a CHECK constraint from 20260823 that only allows
-- session/declared/unverified — intake submissions write 'external', which
-- that constraint rejects. Widened here.
--
-- Additive + idempotent. Apply after 20260902.

ALTER TABLE project_intake_links
  ADD COLUMN IF NOT EXISTS assigned_doc_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN project_intake_links.assigned_doc_ids IS
  'Existing org documents this link may submit revisions to (portal register + upload scope). Revisions of assigned docs ALWAYS route through review — auto-supersede only ever applies to link-authored documents.';

-- Widen the provenance CHECK to admit 'external' (intake submissions).
-- Drop whatever check currently constrains the column (auto-named by
-- Postgres), then recreate with the full value set.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'document_versions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%provenance%'
  LOOP
    EXECUTE format('ALTER TABLE document_versions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE document_versions
  ADD CONSTRAINT document_versions_provenance_check
  CHECK (provenance IN ('session','declared','unverified','external'));

COMMENT ON COLUMN document_versions.provenance IS
  'session = published from an active checkout; declared = base picked manually, checks passed; unverified = no intent trail or heuristics contradict the declared base; external = submitted by an outside company through a project intake link. NULL on legacy rows.';
