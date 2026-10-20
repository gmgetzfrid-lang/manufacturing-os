-- 20261022_document_versions_policy_repair.sql
--
-- Uploads failed for every file with:
--   infinite recursion detected in policy for relation "document_versions"
-- The policies this repo defines for document_versions cannot loop (each
-- reaches other tables only through SECURITY DEFINER helpers), so the live
-- database carries a policy that isn't in the repo — added by hand, by a
-- script, or by another tool — whose check leads back into
-- document_versions.
--
-- What this does, in one transaction:
--   1. BACKS UP every policy on document_versions, plus every policy on any
--      other table that mentions document_versions, into
--      public._policy_backup (nothing is lost; the definitions can be
--      re-created from there).
--   2. Drops ALL policies on document_versions.
--   3. Re-creates the canonical set (schema.sql + 20260813 + 20260815):
--        org members: full access to their org's rows
--        RESTRICTIVE select: only versions of documents you can see
--        RESTRICTIVE delete: only Admin / Doc Control
--      and re-asserts the SECURITY DEFINER helpers they call.
--   4. Ends with a report of what was found and replaced. Policies on OTHER
--      tables that mention document_versions are reported, never touched.
--
-- Idempotent: safe to run again. Run it in the Supabase SQL editor.

BEGIN;

CREATE TABLE IF NOT EXISTS public._policy_backup (
  backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schemaname   TEXT,
  tablename    TEXT,
  policyname   TEXT,
  permissive   TEXT,
  roles        TEXT[],
  cmd          TEXT,
  qual         TEXT,
  with_check   TEXT,
  action       TEXT
);
ALTER TABLE public._policy_backup ENABLE ROW LEVEL SECURITY;  -- service role / SQL editor only

INSERT INTO public._policy_backup (schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check, action)
SELECT schemaname, tablename, policyname, permissive, roles::text[], cmd, qual, with_check,
       CASE WHEN tablename = 'document_versions' THEN 'replaced' ELSE 'reported (left as is)' END
  FROM pg_policies
 WHERE schemaname = 'public'
   AND (tablename = 'document_versions'
        OR qual ILIKE '%document_versions%'
        OR with_check ILIKE '%document_versions%');

DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
            WHERE schemaname = 'public' AND tablename = 'document_versions'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.document_versions', p.policyname);
  END LOOP;
END $$;

-- Helpers the canonical policies call. SECURITY DEFINER: they read
-- org_members / documents without re-applying those tables' row rules, so
-- no policy chain can come back around to document_versions.
CREATE OR REPLACE FUNCTION public.my_org_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.is_org_controller(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE uid = auth.uid()
      AND org_id = p_org
      AND status = 'active'
      AND (role IN ('Admin', 'DocCtrl') OR roles && ARRAY['Admin', 'DocCtrl']::text[])
  );
$$;

CREATE OR REPLACE FUNCTION public.doc_is_visible(p_doc uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT node_visible(d.visibility, d.acl_index, d.org_id)
       FROM documents d WHERE d.id = p_doc),
    false);
$$;

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_versions_org_access ON public.document_versions
  FOR ALL
  USING (org_id IN (SELECT public.my_org_ids()))
  WITH CHECK (org_id IN (SELECT public.my_org_ids()));

CREATE POLICY document_versions_acl_select ON public.document_versions
  AS RESTRICTIVE FOR SELECT
  USING (public.doc_is_visible(record_id));

CREATE POLICY document_versions_delete_controllers ON public.document_versions
  AS RESTRICTIVE FOR DELETE
  USING (public.is_org_controller(org_id));

COMMIT;

-- Report: what was there before (the culprit is among these), and any
-- policy on another table that mentions document_versions.
SELECT action, tablename, policyname, permissive, cmd,
       LEFT(COALESCE(qual, ''), 300)       AS using_clause,
       LEFT(COALESCE(with_check, ''), 300) AS check_clause
  FROM public._policy_backup
 WHERE backed_up_at = (SELECT MAX(backed_up_at) FROM public._policy_backup)
 ORDER BY action, tablename, policyname;
