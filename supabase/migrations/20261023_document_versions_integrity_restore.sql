-- 20261023_document_versions_integrity_restore.sql
--
-- Puts back the publish-integrity rules that 20261022 swept away, with the
-- one defect that broke uploads removed.
--
-- 20261022's report showed two policies on document_versions that live only
-- in the database (no migration in this repo creates them):
--   document_versions_insert_integrity  (RESTRICTIVE, INSERT)
--     a member may add a revision only if they can publish the document,
--     OR it is their own row on a document they can see AND it is either
--     going to review (in_review, unreleased) or the document's FIRST
--     revision.
--   document_versions_update_integrity  (RESTRICTIVE, UPDATE)
--     the matching rule for edits (publishers; own in-review rows; external
--     intake submissions).
-- They are real security: without them any member can publish a revision
-- directly. The defect was the "first revision" test — a subquery on
-- document_versions INSIDE a policy on document_versions, which Postgres
-- rejects as "infinite recursion detected in policy" on every insert.
--
-- This restores both policies EXACTLY as they were saved in
-- public._policy_backup (full text, not the truncated report), except that
-- the self-referencing EXISTS (...) becomes doc_has_versions(record_id) — a
-- SECURITY DEFINER helper that answers the same question without re-entering
-- the policy. If any restored rule would still refer to document_versions
-- inside itself, the whole script stops and changes nothing.
--
-- Idempotent: a policy that already exists is left alone.

BEGIN;

CREATE OR REPLACE FUNCTION public.doc_has_versions(p_doc uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM document_versions WHERE record_id = p_doc);
$$;

DO $$
DECLARE
  b RECORD;
  q TEXT;
  c TEXT;
  stmt TEXT;
  role_list TEXT;
  self_ref CONSTANT TEXT :=
    'EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+(public\.)?document_versions\s+(\w+)\s+WHERE\s+\(\s*\2\.record_id\s*=\s*document_versions\.record_id\s*\)\s*\)';
  restored INT := 0;
BEGIN
  IF to_regclass('public._policy_backup') IS NULL THEN
    RAISE NOTICE 'No _policy_backup table — nothing to restore.';
    RETURN;
  END IF;
  FOR b IN
    SELECT DISTINCT ON (policyname) *
      FROM public._policy_backup
     WHERE tablename = 'document_versions' AND action = 'replaced'
       AND policyname NOT IN ('document_versions_org_access', 'document_versions_acl_select',
                              'document_versions_delete_controllers')
     ORDER BY policyname, backed_up_at DESC
  LOOP
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'document_versions' AND policyname = b.policyname) THEN
      CONTINUE;
    END IF;
    q := NULLIF(b.qual, '');
    c := NULLIF(b.with_check, '');
    q := regexp_replace(q, self_ref, 'public.doc_has_versions(document_versions.record_id)', 'gi');
    c := regexp_replace(c, self_ref, 'public.doc_has_versions(document_versions.record_id)', 'gi');
    IF COALESCE(q, '') ~* '(from|join)\s+(public\.)?document_versions\M'
       OR COALESCE(c, '') ~* '(from|join)\s+(public\.)?document_versions\M' THEN
      RAISE EXCEPTION 'Policy % still reads document_versions inside itself — not restored (nothing changed). Rule: %',
        b.policyname, COALESCE(c, q);
    END IF;
    role_list := COALESCE(NULLIF(array_to_string(
      ARRAY(SELECT CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END
              FROM unnest(b.roles) AS r), ', '), ''), 'PUBLIC');
    stmt := format('CREATE POLICY %I ON public.document_versions AS %s FOR %s TO %s',
                   b.policyname, b.permissive, b.cmd, role_list);
    IF q IS NOT NULL THEN stmt := stmt || ' USING (' || q || ')'; END IF;
    IF c IS NOT NULL THEN stmt := stmt || ' WITH CHECK (' || c || ')'; END IF;
    EXECUTE stmt;
    restored := restored + 1;
    RAISE NOTICE 'Restored %', b.policyname;
  END LOOP;
  RAISE NOTICE '% polic(ies) restored.', restored;
END $$;

COMMIT;

-- Report: the rules now on document_versions, in full.
SELECT policyname, permissive, cmd,
       COALESCE(qual, '')       AS using_clause,
       COALESCE(with_check, '') AS check_clause
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'document_versions'
 ORDER BY policyname;
