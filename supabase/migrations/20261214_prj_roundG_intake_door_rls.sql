-- 20261214_prj_roundG_intake_door_rls.sql
--
-- projects Round G — J20 INTAKE DOOR UNDER RLS AND PROJECT REMAINDERS:
-- projects-tab SEC-22 (GAP-401's remaining limbs). Three sections, one paste.
-- The section numbers are the body's `-- ── n.` headings, which the records cite.
--
-- WHAT:
--   1. LIMB (a) — THE SUBMISSION UNDER ROW-LEVEL SECURITY. 20261184 put the
--      door's new document and quote under row-level security through the
--      NOLOGIN role intake_door; the submission (a document_versions INSERT)
--      stayed off it because every RLS-subject INSERT into document_versions
--      failed with 42P17 (projects-tab SEC-23). 20261205 (document-control
--      P23) settled that: document_versions_insert_integrity reads
--      document_has_versions() instead of document_versions. So now:
--        * intake_door_submit_version is re-created from its NEWEST body
--          (20261184, found by scanning; lineDiff-pinned) as SECURITY INVOKER
--          with the same role switch around its one INSERT that
--          intake_door_create_document has: it resolves the link, checks
--          scope and binds the identity exactly as before, then — where
--          intake_door_version_rls_ready() finds no gap — switches to
--          intake_door for the INSERT and back. The id is chosen first (a
--          RETURNING would need read policies, which show a link nothing).
--          A privilege the readiness check could not see ("permission denied
--          …") or the refusal of a NAMED policy that is not the door's own
--          runs the same INSERT once more with the bound identity alone and
--          leaves a WARNING — the shape before this file, the upload filed.
--          Only the door's own policies refuse after the switch.
--        * two policies TO intake_door on document_versions, a permissive and
--          a restrictive INSERT pair, read intake_door_may_submit(…) with the
--          row's own columns: an in-review external submission of the BOUND
--          link (intake_door_bound(), 20261184), no release, no member named,
--          its file under the link's project prefix, on a document the link
--          authored or was assigned, a base revision only of that document.
--        * document_versions_insert_integrity (RESTRICTIVE, for every role)
--          is re-created from its NEWEST body (20261205, found by scanning;
--          lineDiff-pinned) with ONE added limb for the door's role:
--          `CURRENT_USER = 'intake_door'` and the row an unreleased,
--          in-review, external submission of a link naming no member. The
--          bound-link scope is the door's own restrictive policy's. No
--          function is added to a policy every member's insert evaluates.
--        * intake_door holds column INSERT on exactly what the door inserts
--          in document_versions (nothing to read, update or delete), and
--          EXECUTE by name on what the live INSERT policies of
--          document_versions call (user_can_publish_doc, doc_is_visible,
--          document_has_versions — the last revoked from PUBLIC by 20261205).
--        * intake_door_version_rls_gaps(p_login) answers what the INSERT as
--          intake_door would lack on THIS database, read from the live
--          catalogs as 20261184's intake_door_rls_gaps does for the other two
--          tables: the switch, EXECUTE and column SELECT on what the live
--          INSERT / ALL policies use, and any RESTRICTIVE INSERT / ALL policy
--          for every role (or intake_door) the link may fail — any but the
--          door's own document_versions_intake_door_scope and
--          document_versions_insert_integrity while it carries the door limb.
--          intake_door_version_rls_ready() asks it for session_user.
--      Not under row-level security, and why (each pinned on SEC-22):
--        * the pending pointer — an UPDATE whose WHERE reads documents, so
--          the restrictive documents_acl_select (every role) would have to
--          admit a link; widening the hottest read policy of the app for one
--          write is not done. It stays a SECURITY DEFINER door function with
--          the bound identity, every trigger guard judging it;
--        * the trusted promote — publish_revision is SECURITY DEFINER by
--          design; judged by the guards as the link's creator (DEC-56 item 2);
--        * the redline — the ticket rails' service-only append (20261166).
--   2. LIMB (b) — THE DOOR'S HOUSEKEEPING UNDER THE BOUND IDENTITY. The route
--      wrote these as the service role (auth.uid() NULL, every guard
--      exempt). Two SECURITY DEFINER door functions now make them, each
--      resolving the link from its token hash, checking that the row is the
--      link's own, binding the link's identity for the write and restoring it:
--        * intake_door_housekeep(token, op, doc, version, at) — 'retire' a
--          trusted link's own displaced in-review submission (compare-and-set,
--          a live link only); 'restore' it when the replacement did not land;
--          'withdraw' the request's own submission that lost the pointer
--          race; 'discard' the document the request created (its own,
--          never approved); 'reference' that document on the project
--          (project_documents, DO NOTHING on a repeat). 'restore',
--          'withdraw', 'discard' and 'reference' undo or record THIS
--          request's own writes, so they need the link to exist, not to be
--          live: a revocation mid-request never strands them.
--        * intake_door_intake_folder(token) — the project's intake folder:
--          the current one when it is a folder of the intake library in the
--          link's org; otherwise a folder made there and claimed with a
--          compare-and-set on the stale (or empty) pointer, a lost race
--          answering the winner's folder (route's ensureIntakeFolder, ported).
--   3. LIMB (c) — THE INTAKE POINTERS' RAIL. projects.intake_library_id and
--      intake_collection_id anchor the door's scope. enforce_project_intake_
--      pointers (BEFORE INSERT OR UPDATE OF them ON projects; SECURITY
--      DEFINER, search_path pinned, EXECUTE revoked from PUBLIC, anon and
--      authenticated), for a signed-in writer:
--        * the library must be one of the project's workspace's;
--        * once set, neither pointer may be changed (or cleared) while the
--          project has a live document link, except by a controller
--          (is_org_controller: Admin / Document Control, held additively);
--        * the folder must be a folder of the intake library — a changed
--          folder that is not is refused; when the LIBRARY changes and the
--          old folder is not one of the new library's folders, the folder
--          pointer is cleared (the door makes a folder in the new library on
--          the next upload, as it already does for a stale pointer);
--        * the door's own folder repair (section 2, the link of THIS project
--          bound) may set the folder to a folder of the unchanged intake
--          library, from none or from a stale one — nothing else.
--      Passes: the service role (auth.uid() NULL — the route before this
--      paste, restores, the SQL editor). The Intake tab sets the library only
--      when it is unset (components/projects/IntakePanel.tsx createLink) and
--      says a refusal in the database's words.
--
-- NOT a widening for any client role. Every door function is the service
-- role's alone; intake_door cannot log in and only an authenticator session
-- can switch to it; the new policies and the integrity limb admit only that
-- role. The rail refuses writes RLS allowed. Net effect: the door's
-- submission goes from "bypassing row-level security" to "under it", its
-- housekeeping from "exempt from every guard" to "judged by every guard".
-- The DEC-30 inventory (aggregate COUNTs only) is captured BEFORE the
-- transaction.
--
-- THE APP BEFORE AND AFTER THE PASTE. The submission's signature is
-- unchanged, so the route already deployed calls it as before (only the role
-- it inserts as changes). The route carrying J20 calls the housekeeping
-- functions first and, when they are not there (PGRST202, or 42883 naming an
-- intake_door_ function at its start), writes exactly as today.
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (idempotent). The final SELECT is the only result set shown — probe
-- rows must read ok = true (if the "row-level security for the submission"
-- row reads false, the paste still applied and each submission keeps the
-- bound identity, filed as before: send that row back, SEC-22 records it);
-- inventory rows carry ok NULL and a count in n.
-- PASTE ORDER: after 20261184 (the door's role and functions) and 20261205
-- (document_has_versions and the insert-integrity policy this file
-- re-creates); the first statement refuses to run, changing nothing, without
-- either. ⚠ Never re-paste 20261205 after this file: it would drop the door
-- limb of document_versions_insert_integrity, and intake_door_version_rls_
-- gaps would then report it ('policy …') — each submission keeps the bound
-- identity, filed, until this file is pasted again.
-- DEPLOY ORDER: none required.

-- ── Prerequisite (refuse to run, changing nothing, without 20261184 and 20261205)
DO $$
BEGIN
  IF to_regprocedure('public.intake_door_submit_version(text, jsonb)') IS NULL
     OR to_regprocedure('public.intake_door_bound()') IS NULL
     OR to_regrole('intake_door') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261184_prj_roundG_intake_door_identity.sql first — this migration re-creates its intake_door_submit_version and uses its intake_door role. Nothing was changed.';
  END IF;
  IF to_regprocedure('public.document_has_versions(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261205_dc_roundF_direct_write_issue_record.sql first — this migration re-creates its document_versions_insert_integrity. Nothing was changed.';
  END IF;
END;
$$;

-- ── DEC-30 inventory, captured BEFORE the transaction (counts only) ───────
DROP TABLE IF EXISTS pg_temp.prj_g_j20_inventory;
CREATE TEMP TABLE prj_g_j20_inventory AS
SELECT 'inventory: live document links (not revoked, not expired) — their submissions are inserted as intake_door under row-level security from this paste on' AS inventory,
       COUNT(*)::text AS n
  FROM project_intake_links
 WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) AND COALESCE(purpose, 'documents') <> 'quote'
UNION ALL
SELECT 'inventory: door submissions still in review (provenance external, a link set) — the rows the new policies describe',
       COUNT(*)::text
  FROM document_versions WHERE intake_link_id IS NOT NULL AND review_state = 'in_review'
UNION ALL
SELECT 'inventory: projects whose intake library is not a library of their own workspace (a signed-in write keeping it is refused from this paste on; the door already refuses to file there)',
       COUNT(*)::text
  FROM projects p
 WHERE p.intake_library_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = p.intake_library_id AND l.org_id = p.org_id)
UNION ALL
SELECT 'inventory: projects whose intake folder is not a folder of their intake library (the door makes a folder there on the next upload, as it does today; a signed-in change of the library clears it)',
       COUNT(*)::text
  FROM projects p
 WHERE p.intake_collection_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM collections c
                    WHERE c.id = p.intake_collection_id AND c.org_id = p.org_id AND c.library_id = p.intake_library_id)
UNION ALL
SELECT 'inventory: projects with a set intake library and a live document link — from this paste on only a controller moves their intake library or folder',
       COUNT(*)::text
  FROM projects p
 WHERE p.intake_library_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM project_intake_links l
                WHERE l.project_id = p.id AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > NOW())
                  AND COALESCE(l.purpose, 'documents') <> 'quote')
UNION ALL
SELECT 'inventory: other row triggers on projects that fire on INSERT or UPDATE OF intake_library_id / intake_collection_id (besides this file''s)',
       COUNT(*)::text
  FROM pg_trigger t
 WHERE NOT t.tgisinternal AND t.tgrelid = 'public.projects'::regclass
   AND t.tgname <> 'trg_projects_intake_pointers'
   AND (pg_get_triggerdef(t.oid) LIKE '%intake_library_id%' OR pg_get_triggerdef(t.oid) LIKE '%intake_collection_id%');

BEGIN;

-- ── 1. Limb (a): the submission under row-level security ──────────────────
-- What the door's INSERT writes, and only that (created_by never: a door
-- write names no member). Granted by column, only where the live table has
-- it (every one does wherever 20261184 is pasted; the guard keeps a re-paste
-- on an older table from failing).
DO $$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['id', 'org_id', 'record_id', 'revision_label', 'file_url', 'file_type', 'size', 'change_log',
                           'created_by_name', 'created_at', 'released_at', 'review_state', 'provenance',
                           'intake_link_id', 'file_hash', 'supersedes_version_id'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'document_versions' AND column_name = c) THEN
      EXECUTE format('GRANT INSERT (%I) ON public.document_versions TO intake_door', c);
    END IF;
  END LOOP;
  -- What the INSERT policies of document_versions written for all roles call
  -- (Postgres checks EXECUTE on every function of a policy as it sets the
  -- policy up, whichever limb decides): document_versions_insert_integrity
  -- (user_can_publish_doc, doc_is_visible, document_has_versions — the last
  -- revoked from PUBLIC by 20261205), document_versions_org_access
  -- (my_org_ids, granted by 20261184). By name, so a later REVOKE … FROM
  -- PUBLIC does not take them away; intake_door_version_rls_gaps re-reads the
  -- live policies before every switch all the same.
  IF to_regprocedure('public.user_can_publish_doc(uuid, uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.user_can_publish_doc(uuid, uuid) TO intake_door;
  END IF;
  IF to_regprocedure('public.doc_is_visible(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.doc_is_visible(uuid) TO intake_door;
  END IF;
  IF to_regprocedure('public.document_has_versions(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.document_has_versions(uuid) TO intake_door;
  END IF;
END;
$$;

-- The bound link's submission, as the policies TO intake_door read it.
CREATE OR REPLACE FUNCTION public.intake_door_may_submit(p_org uuid, p_record uuid, p_file_url text, p_review_state text,
                                                        p_provenance text, p_link uuid, p_released_at timestamptz,
                                                        p_created_by uuid, p_supersedes uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_door jsonb := intake_door_bound();
BEGIN
  RETURN COALESCE(
        v_door IS NOT NULL
    AND v_door->>'purpose' IS DISTINCT FROM 'quote'
    AND p_org::text = v_door->>'org_id'
    AND p_link::text = v_door->>'link_id'
    AND p_review_state = 'in_review'
    AND p_provenance = 'external'
    AND p_released_at IS NULL
    AND p_created_by IS NULL
    AND p_file_url ~ ('^orgs/' || (v_door->>'org_id') || '/project-intake/' || (v_door->>'project_id') || '/[^/]+$')
    AND EXISTS (SELECT 1 FROM documents d
                 WHERE d.id = p_record AND d.org_id = p_org
                   AND (d.authored_by_link_id = p_link
                        OR d.id::text IN (SELECT jsonb_array_elements_text(v_door->'assigned'))))
    AND (p_supersedes IS NULL
         OR EXISTS (SELECT 1 FROM document_versions b WHERE b.id = p_supersedes AND b.record_id = p_record)),
    false);
END;
$$;

COMMENT ON FUNCTION public.intake_door_may_submit(uuid, uuid, text, text, text, uuid, timestamptz, uuid, uuid) IS
  'SEC-22 (a) (J20, 20261214): the document_versions INSERT policies TO intake_door — an unreleased, in-review, external submission of the BOUND link (intake_door_bound), naming no member, its file under the link''s project prefix, on a document the link authored or was assigned, a base revision only of that document. Only intake_door may execute it.';

-- What the door's submission as intake_door would lack on THIS database, read
-- from the live catalogs (20261184's intake_door_rls_gaps, for
-- document_versions): one entry per gap.
CREATE OR REPLACE FUNCTION public.intake_door_version_rls_gaps(p_login name)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_door  oid := to_regrole('intake_door');
  v_table oid := to_regclass('public.document_versions');
  v_gaps  text[] := ARRAY[]::text[];
BEGIN
  IF v_door IS NULL THEN
    RETURN ARRAY['role'];
  END IF;
  -- The login may switch to the role: SET from PostgreSQL 16, MEMBER before.
  IF to_regrole(p_login) IS NULL
     OR NOT pg_has_role(p_login, 'intake_door',
                        CASE WHEN current_setting('server_version_num')::int >= 160000 THEN 'SET' ELSE 'MEMBER' END) THEN
    v_gaps := v_gaps || 'switch'::text;
  END IF;
  -- EXECUTE on every function (and operator's function) an INSERT or ALL
  -- policy of document_versions for this role calls.
  v_gaps := v_gaps || ARRAY(
    SELECT DISTINCT 'execute ' || f.fn::regprocedure::text
      FROM (SELECT d.refobjid AS fn
              FROM pg_policy pol
              JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_proc'::regclass
             WHERE pol.polrelid = v_table AND pol.polcmd IN ('a', '*')
               AND (0::oid = ANY (pol.polroles) OR v_door = ANY (pol.polroles))
            UNION
            SELECT o.oprcode::oid
              FROM pg_policy pol
              JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_operator'::regclass
              JOIN pg_operator o ON o.oid = d.refobjid
             WHERE pol.polrelid = v_table AND pol.polcmd IN ('a', '*')
               AND (0::oid = ANY (pol.polroles) OR v_door = ANY (pol.polroles))) f
     WHERE f.fn IS NOT NULL AND NOT has_function_privilege('intake_door', f.fn, 'EXECUTE')
     ORDER BY 1);
  -- SELECT on every column of another table such a policy reads.
  v_gaps := v_gaps || ARRAY(
    SELECT DISTINCT 'read ' || d.refobjid::regclass::text || COALESCE('.' || a.attname::text, '')
      FROM pg_policy pol
      JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_class'::regclass
                      AND d.refobjid <> pol.polrelid
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid AND d.refobjsubid > 0
     WHERE pol.polrelid = v_table AND pol.polcmd IN ('a', '*')
       AND (0::oid = ANY (pol.polroles) OR v_door = ANY (pol.polroles))
       AND CASE WHEN d.refobjsubid > 0 THEN NOT has_column_privilege('intake_door', d.refobjid, d.refobjsubid::smallint, 'SELECT')
                ELSE NOT has_any_column_privilege('intake_door', d.refobjid, 'SELECT') END
     ORDER BY 1);
  -- A RESTRICTIVE INSERT or ALL policy of document_versions for every role (or
  -- intake_door) judges the INSERT as intake_door as it judges a member's;
  -- one the link may fail would refuse a submission that is filed today.
  -- Beyond the door's own scope policy (TO intake_door alone) and
  -- document_versions_insert_integrity while it carries the door limb (this
  -- file's), each is a gap: the submission keeps the bound identity.
  v_gaps := v_gaps || ARRAY(
    SELECT DISTINCT 'policy ' || pol.polname::text
      FROM pg_policy pol
     WHERE pol.polrelid = v_table AND NOT pol.polpermissive AND pol.polcmd IN ('a', '*')
       AND (0::oid = ANY (pol.polroles) OR v_door = ANY (pol.polroles))
       AND NOT (pol.polname = 'document_versions_intake_door_scope' AND pol.polroles = ARRAY[v_door])
       AND NOT (pol.polname = 'document_versions_insert_integrity' AND pol.polcmd = 'a'
                AND pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%CURRENT_USER = %intake_door%')
     ORDER BY 1);
  RETURN v_gaps;
END;
$$;

COMMENT ON FUNCTION public.intake_door_version_rls_gaps(name) IS
  'SEC-22 (a) (J20, 20261214): what the door''s submission INSERT as intake_door would lack here — ''role'', ''switch'' (p_login may not SET the role; MEMBER before PG16), ''execute <function>'' and ''read <table.column>'' for what the live INSERT / ALL policies of document_versions call and read, and ''policy <name>'' for a RESTRICTIVE INSERT / ALL policy of it for every role (or intake_door) the link may fail — any but the door''s own scope policy and document_versions_insert_integrity while it carries the door limb. Empty: the submission may switch. Service role only.';

CREATE OR REPLACE FUNCTION public.intake_door_version_rls_ready()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT cardinality(intake_door_version_rls_gaps(session_user)) = 0;
$$;

COMMENT ON FUNCTION public.intake_door_version_rls_ready() IS
  'SEC-22 (a) (J20, 20261214): whether the door''s submission may be inserted as intake_door on this database — intake_door_version_rls_gaps(session_user) finds no gap. False: intake_door_submit_version writes with the bound identity alone, as before this file. Service role only.';

-- 20261184's body (the newest, found by scanning), with the role switch
-- around its one INSERT (intake_door_create_document's shape).
CREATE OR REPLACE FUNCTION public.intake_door_submit_version(p_token_hash text, p_version jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_door jsonb := intake_door_resolve(p_token_hash);
  v_link uuid  := (v_door->>'link_id')::uuid;
  v_org  uuid  := (v_door->>'org_id')::uuid;
  v_proj uuid  := (v_door->>'project_id')::uuid;
  v_v    document_versions%ROWTYPE;
  v_prev jsonb;
  v_id   uuid  := gen_random_uuid();
  v_rls  boolean := intake_door_version_rls_ready();
  v_role text  := current_setting('role');
BEGIN
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF jsonb_typeof(p_version) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'intake_door: one version object is required.' USING ERRCODE = '22023';
  END IF;
  v_v := jsonb_populate_record(NULL::document_versions, p_version);
  IF NOT EXISTS (SELECT 1 FROM documents d
                  WHERE d.id = v_v.record_id AND d.org_id = v_org
                    AND (d.authored_by_link_id = v_link
                         OR d.id::text IN (SELECT jsonb_array_elements_text(v_door->'assigned')))) THEN
    RAISE EXCEPTION 'intake_door: this link submits only to its own or assigned documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF v_v.file_url IS NULL OR v_v.file_url !~ ('^orgs/' || v_org::text || '/project-intake/' || v_proj::text || '/[^/]+$') THEN
    RAISE EXCEPTION 'intake_door: the file is not stored under this link''s project.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF v_v.supersedes_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM document_versions b WHERE b.id = v_v.supersedes_version_id AND b.record_id = v_v.record_id) THEN
    RAISE EXCEPTION 'intake_door: the base revision is not a revision of this document.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);
  -- OWN-4: an external upload is in review until a person decides; its link,
  -- its provenance and its org are the door's, never the caller's.
  -- SEC-22 (a) (J20): the INSERT as intake_door, under row-level security
  -- (document_versions_intake_door_* and every policy written for all roles);
  -- the id is chosen here, as a RETURNING would also need read policies. A
  -- privilege the role lacks that intake_door_version_rls_ready could not
  -- foresee ("permission denied …"), or the refusal of a NAMED policy that is
  -- not the door's own, is undone with its role switch, leaves a WARNING and
  -- runs the same INSERT once more with the bound identity alone — the shape
  -- before this file. The door's own policies' refusal (none permissive
  -- admitted the row — Postgres names none — or the scope policy, named) and
  -- every other error are raised: they are the link's boundary.
  LOOP
    BEGIN
      IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;
      INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, file_type, size, change_log,
                                     created_by_name, created_at, released_at, review_state, provenance,
                                     intake_link_id, file_hash, supersedes_version_id)
      VALUES (v_id, v_org, v_v.record_id, v_v.revision_label, v_v.file_url, v_v.file_type, v_v.size, v_v.change_log,
              v_v.created_by_name, COALESCE(v_v.created_at, NOW()), NULL, 'in_review', 'external',
              v_link, v_v.file_hash, v_v.supersedes_version_id);
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      EXIT;
    EXCEPTION WHEN insufficient_privilege THEN
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      IF NOT v_rls
         OR SQLERRM IN ('new row violates row-level security policy for table "document_versions"',
                        'new row violates row-level security policy "document_versions_intake_door_scope" for table "document_versions"')
         OR NOT (SQLERRM LIKE 'permission denied%' OR SQLERRM LIKE 'new row violates row-level security policy "%') THEN
        RAISE;
      END IF;
      RAISE WARNING 'intake_door_submit_version: % — this submission is written with the bound identity alone, without row-level security (projects-tab SEC-22).', SQLERRM;
      v_rls := false;
    END;
  END LOOP;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.intake_door_submit_version(text, jsonb) IS
  'GAP-401 (J16): the contractor door inserts an in-review external submission on a document its link authored or was assigned, its file under the link''s project prefix, as the door''s identity. SEC-22 (a) (J20, 20261214): where the paste could grant it, as the role intake_door under the document_versions_intake_door_* policies (SECURITY INVOKER, the 20261184 role switch). Service role only.';

-- The policies TO intake_door: a permissive one lets the door's role insert
-- at all; a restrictive one with the same predicate keeps every policy
-- written for all roles from widening it. The role has no SELECT, UPDATE or
-- DELETE on document_versions, so no other command needs one.
DROP POLICY IF EXISTS document_versions_intake_door_insert ON document_versions;
CREATE POLICY document_versions_intake_door_insert ON document_versions
  AS PERMISSIVE FOR INSERT TO intake_door
  WITH CHECK (intake_door_may_submit(org_id, record_id, file_url, review_state, provenance, intake_link_id, released_at, created_by, supersedes_version_id));
DROP POLICY IF EXISTS document_versions_intake_door_scope ON document_versions;
CREATE POLICY document_versions_intake_door_scope ON document_versions
  AS RESTRICTIVE FOR INSERT TO intake_door
  WITH CHECK (intake_door_may_submit(org_id, record_id, file_url, review_state, provenance, intake_link_id, released_at, created_by, supersedes_version_id));

-- 20261205's body (the newest, found by scanning) + ONE limb: the door's
-- role, inserting an unreleased in-review external submission of a link that
-- names no member — the bound-link scope is document_versions_intake_door_scope.
-- INSERT: publisher-grade for anything, OR the author's own row when it is
-- either an unreleased in-review draft (submit-for-review) or the document's
-- FIRST version (the creation flows: upload-and-link, bulk upload,
-- split/merge targets). A released-looking row against a document with
-- history requires publish authority — the exact EGRESS-6 hole.
DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;
CREATE POLICY document_versions_insert_integrity ON document_versions
AS RESTRICTIVE FOR INSERT WITH CHECK (
  user_can_publish_doc(record_id, org_id)
  OR (
    created_by = auth.uid()
    AND doc_is_visible(record_id)
    AND (
      (review_state = 'in_review' AND released_at IS NULL)
      OR NOT document_has_versions(document_versions.record_id)
    )
  )
  OR (
    CURRENT_USER = 'intake_door'
    AND review_state = 'in_review' AND released_at IS NULL
    AND provenance = 'external' AND intake_link_id IS NOT NULL AND created_by IS NULL
  )
);

-- ── 2. Limb (b): the door's housekeeping under the bound identity ─────────
CREATE OR REPLACE FUNCTION public.intake_door_housekeep(p_token_hash text, p_op text, p_doc uuid,
                                                       p_version uuid DEFAULT NULL, p_at timestamptz DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_door     jsonb;
  v_link     uuid;
  v_org      uuid;
  v_proj     uuid;
  v_row      project_intake_links%ROWTYPE;
  v_author   uuid;
  v_current  uuid;
  v_assigned boolean;
  v_prev     jsonb;
  v_n        integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'intake_door: only the intake route, under the service key, opens the contractor door.'
      USING ERRCODE = '42501';
  END IF;
  IF p_op = 'retire' THEN
    -- Before the replacement exists: a live link only.
    v_door := intake_door_resolve(p_token_hash);
  ELSIF p_op IN ('restore', 'withdraw', 'discard', 'reference') THEN
    -- Undoing or recording THIS request's own writes: the link must exist,
    -- not still be live — a revocation mid-request never strands them.
    IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'intake_door: no link answers this credential.' USING ERRCODE = '28000', HINT = 'notfound';
    END IF;
    SELECT * INTO v_row FROM project_intake_links WHERE token_hash = p_token_hash;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'intake_door: no link answers this credential.' USING ERRCODE = '28000', HINT = 'notfound';
    END IF;
    v_door := jsonb_build_object('link_id', v_row.id, 'org_id', v_row.org_id, 'project_id', v_row.project_id,
                                 'trusted', COALESCE(v_row.allow_auto_supersede, false),
                                 'assigned', to_jsonb(COALESCE(v_row.assigned_doc_ids, ARRAY[]::uuid[])),
                                 'purpose', COALESCE(v_row.purpose, 'documents'));
  ELSE
    RAISE EXCEPTION 'intake_door_housekeep: unknown operation %.', p_op USING ERRCODE = '22023';
  END IF;
  v_link := (v_door->>'link_id')::uuid;
  v_org  := (v_door->>'org_id')::uuid;
  v_proj := (v_door->>'project_id')::uuid;
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  SELECT d.authored_by_link_id, d.current_version_id INTO v_author, v_current
    FROM documents d WHERE d.id = p_doc AND d.org_id = v_org;
  IF NOT FOUND THEN
    RETURN 0;   -- the document is gone: nothing of it to retire, restore, withdraw, discard or reference
  END IF;
  v_assigned := p_doc::text IN (SELECT jsonb_array_elements_text(v_door->'assigned'));
  IF p_op IN ('retire', 'restore', 'withdraw') THEN
    IF p_version IS NULL
       OR NOT EXISTS (SELECT 1 FROM document_versions v
                       WHERE v.id = p_version AND v.record_id = p_doc AND v.org_id = v_org AND v.intake_link_id = v_link)
       OR NOT (v_author IS NOT DISTINCT FROM v_link OR v_assigned) THEN
      RAISE EXCEPTION 'intake_door: this link resolves only its own submissions.' USING ERRCODE = '42501', HINT = 'scope';
    END IF;
    -- INTK-4 dw3: only a TRUSTED link replaces (retires) a pending submission,
    -- only on its own (unassigned) document.
    IF p_op = 'retire'
       AND NOT (COALESCE((v_door->>'trusted')::boolean, false) AND v_author IS NOT DISTINCT FROM v_link AND NOT v_assigned) THEN
      RAISE EXCEPTION 'intake_door: only a trusted link replaces its own earlier submission.' USING ERRCODE = '42501', HINT = 'scope';
    END IF;
  ELSIF p_op = 'discard' THEN
    IF v_author IS DISTINCT FROM v_link OR v_current IS NOT NULL THEN
      RAISE EXCEPTION 'intake_door: this link removes only a document it just created, none of whose revisions was approved.' USING ERRCODE = '42501', HINT = 'scope';
    END IF;
  ELSE -- 'reference'
    IF v_author IS DISTINCT FROM v_link THEN
      RAISE EXCEPTION 'intake_door: this link references on its project only a document it created.' USING ERRCODE = '42501', HINT = 'scope';
    END IF;
  END IF;
  v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);
  IF p_op = 'retire' THEN
    -- Compare-and-set on a still-undecided row: a draft a reviewer decided
    -- meanwhile is not touched (0 = decided).
    UPDATE document_versions SET review_state = 'superseded', superseded_at = COALESCE(p_at, NOW())
     WHERE id = p_version AND record_id = p_doc AND review_state = 'in_review' AND superseded_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_op = 'restore' THEN
    -- The stamp THIS request wrote is cleared, and the state goes back to
    -- in_review only if it is still 'superseded' (a reviewer's approval
    -- meanwhile keeps its 'approved').
    UPDATE document_versions SET superseded_at = NULL
     WHERE id = p_version AND record_id = p_doc AND superseded_at = p_at;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE document_versions SET review_state = 'in_review'
     WHERE id = p_version AND record_id = p_doc AND review_state = 'superseded';
  ELSIF p_op = 'withdraw' THEN
    UPDATE document_versions SET review_state = 'superseded', superseded_at = COALESCE(p_at, NOW())
     WHERE id = p_version AND record_id = p_doc;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSIF p_op = 'discard' THEN
    DELETE FROM documents WHERE id = p_doc AND org_id = v_org AND authored_by_link_id = v_link AND current_version_id IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  ELSE
    -- DEC-40: the document the door created is part of the project by
    -- reference (the row "attach to project" writes).
    INSERT INTO project_documents (org_id, project_id, document_id, source, first_seen_at, last_seen_at)
    VALUES (v_org, v_proj, p_doc, 'manual', COALESCE(p_at, NOW()), COALESCE(p_at, NOW()))
    ON CONFLICT (project_id, document_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.intake_door_housekeep(text, text, uuid, uuid, timestamptz) IS
  'SEC-22 (b) (J20, 20261214): the contractor door''s housekeeping on its own rows, as the door''s identity (auth.uid() = the link; every guard judges it): retire a trusted link''s own displaced in-review submission (compare-and-set; a live link only), restore it, withdraw the request''s own submission, discard the document the request created (its own, never approved), reference it on the project (project_documents). restore / withdraw / discard / reference need the link to exist, not to be live. Answers the rows written. Service role only.';

CREATE OR REPLACE FUNCTION public.intake_door_intake_folder(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_door jsonb := intake_door_resolve(p_token_hash);
  v_link uuid  := (v_door->>'link_id')::uuid;
  v_org  uuid  := (v_door->>'org_id')::uuid;
  v_proj uuid  := (v_door->>'project_id')::uuid;
  v_lib  uuid  := NULLIF(v_door->>'library_id', '')::uuid;
  v_cur  uuid  := NULLIF(v_door->>'collection_id', '')::uuid;
  v_name text;
  v_new  uuid;
  v_win  uuid;
  v_prev jsonb;
  v_n    integer;
BEGIN
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF v_lib IS NULL THEN
    RAISE EXCEPTION 'intake_door: the project''s intake library is not set.' USING ERRCODE = '42501', HINT = 'not_configured';
  END IF;
  -- The folder the project names, when it is a folder of the intake library
  -- in the link's org.
  IF v_cur IS NOT NULL
     AND EXISTS (SELECT 1 FROM collections c WHERE c.id = v_cur AND c.org_id = v_org AND c.library_id = v_lib) THEN
    RETURN v_cur;
  END IF;
  SELECT p.name INTO v_name FROM projects p WHERE p.id = v_proj AND p.org_id = v_org;
  v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);
  -- None, or a stale one (another library's or org's, or gone): a folder is
  -- made in the intake library and claimed with a compare-and-set on the
  -- pointer as it was read.
  INSERT INTO collections (org_id, library_id, name)
  VALUES (v_org, v_lib, 'Intake — ' || COALESCE(v_name, 'Project'))
  RETURNING id INTO v_new;
  UPDATE projects SET intake_collection_id = v_new
   WHERE id = v_proj AND org_id = v_org AND intake_collection_id IS NOT DISTINCT FROM v_cur;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    -- Another first submission claimed the pointer between the read and the
    -- write: the folder made here is dropped and theirs answered.
    DELETE FROM collections WHERE id = v_new;
    SELECT p.intake_collection_id INTO v_win FROM projects p WHERE p.id = v_proj AND p.org_id = v_org;
    PERFORM intake_door_unbind(v_prev);
    IF v_win IS NULL THEN
      RAISE EXCEPTION 'intake_door: the project''s intake folder could not be claimed.' USING ERRCODE = '40001';
    END IF;
    RETURN v_win;
  END IF;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.intake_door_intake_folder(text) IS
  'SEC-22 (b) (J20, 20261214): the project''s intake folder for the contractor door — the one the project names when it is a folder of the intake library in the link''s org; otherwise a folder made there and claimed with a compare-and-set on the stale or empty pointer, as the door''s identity (enforce_project_intake_pointers admits exactly this repair); a lost race answers the winner''s folder. Service role only.';

REVOKE ALL ON FUNCTION public.intake_door_may_submit(uuid, uuid, text, text, text, uuid, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_may_submit(uuid, uuid, text, text, text, uuid, timestamptz, uuid, uuid) TO intake_door;
REVOKE ALL ON FUNCTION public.intake_door_version_rls_gaps(name) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_version_rls_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_door_version_rls_gaps(name) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_version_rls_ready() TO service_role;
REVOKE ALL ON FUNCTION public.intake_door_submit_version(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_door_submit_version(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.intake_door_housekeep(text, text, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_door_housekeep(text, text, uuid, uuid, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.intake_door_intake_folder(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_door_intake_folder(text) TO service_role;

-- ── 3. Limb (c): the intake pointers' rail ────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_project_intake_pointers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claims jsonb;
  v_old_lib uuid;
  v_old_col uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_old_lib := OLD.intake_library_id;
    v_old_col := OLD.intake_collection_id;
  END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- the service pass: the route before 20261214, restores, the SQL editor
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_claims := NULL;
  END;
  -- The contractor door's own folder repair (intake_door_intake_folder): the
  -- link of THIS project, bound by the door function, gives the project a
  -- folder of its unchanged intake library, from none or from a stale one.
  IF COALESCE(v_claims->>'role', '') = 'intake_door' THEN
    IF TG_OP = 'UPDATE'
       AND NEW.intake_library_id IS NOT DISTINCT FROM v_old_lib
       AND v_claims->>'intake_link_id' = auth.uid()::text
       AND EXISTS (SELECT 1 FROM project_intake_links l WHERE l.id = auth.uid() AND l.project_id = NEW.id AND l.org_id = NEW.org_id)
       AND NEW.intake_collection_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM collections c
                    WHERE c.id = NEW.intake_collection_id AND c.org_id = NEW.org_id AND c.library_id = NEW.intake_library_id)
       AND (v_old_col IS NULL
            OR NOT EXISTS (SELECT 1 FROM collections c
                            WHERE c.id = v_old_col AND c.org_id = NEW.org_id AND c.library_id = NEW.intake_library_id)) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'The contractor door may only give its project an intake folder inside the project''s intake library; nothing was changed. (SEC-22, 20261214)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The intake library: one of this workspace's.
  IF NEW.intake_library_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.id = NEW.intake_library_id AND l.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'The intake library must be a library of this workspace; nothing was changed. (SEC-22, 20261214)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A pointer already set does not move under live contractor links except by
  -- a controller: every live link files where these name.
  IF TG_OP = 'UPDATE'
     AND ((v_old_lib IS NOT NULL AND NEW.intake_library_id IS DISTINCT FROM v_old_lib)
          OR (v_old_col IS NOT NULL AND NEW.intake_collection_id IS DISTINCT FROM v_old_col))
     AND NOT is_org_controller(NEW.org_id)
     AND EXISTS (SELECT 1 FROM project_intake_links l
                  WHERE l.project_id = NEW.id AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > NOW())
                    AND COALESCE(l.purpose, 'documents') <> 'quote') THEN
    RAISE EXCEPTION 'While this project has live contractor links, only an Admin or Document Control can change where they file (the project''s intake library and folder) — revoke the links first, or ask one of them; nothing was changed. (SEC-22, 20261214)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The intake folder: a folder of the intake library.
  IF NEW.intake_collection_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM collections c
                      WHERE c.id = NEW.intake_collection_id AND c.org_id = NEW.org_id AND c.library_id = NEW.intake_library_id) THEN
    IF TG_OP = 'UPDATE' AND NEW.intake_collection_id IS NOT DISTINCT FROM v_old_col THEN
      -- The library moved and the old folder is not one of its folders: the
      -- pointer is cleared; the door makes a folder there on the next upload.
      NEW.intake_collection_id := NULL;
    ELSE
      RAISE EXCEPTION 'The intake folder must be a folder of the project''s intake library; nothing was changed. (SEC-22, 20261214)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_project_intake_pointers() IS
  'SEC-22 (c) (J20, 20261214): for a signed-in writer, projects.intake_library_id is a library of the project''s workspace; once set, neither intake pointer moves while the project has a live document link except by a controller (is_org_controller); intake_collection_id is a folder of the intake library (a changed one that is not is refused; one the library moved away from is cleared). The contractor door''s own folder repair (intake_door_intake_folder) may set the folder to a folder of the unchanged library, from none or a stale one. The service role passes.';

REVOKE ALL ON FUNCTION public.enforce_project_intake_pointers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_project_intake_pointers() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_project_intake_pointers() FROM authenticated;

DROP TRIGGER IF EXISTS trg_projects_intake_pointers ON projects;
CREATE TRIGGER trg_projects_intake_pointers
  BEFORE INSERT OR UPDATE OF intake_library_id, intake_collection_id ON projects
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_project_intake_pointers();

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only. If the
--    "row-level security for the submission" row reads false, the paste still
--    applied and each submission keeps the bound identity (filed as before) —
--    send the row back (projects-tab SEC-22). pg_proc.prosrc is verbatim (an
--    apostrophe in a literal is written ''''); pg_policies.with_check is
--    deparsed, so it is matched on names only.
SELECT 'the submission (intake_door_submit_version) is SECURITY INVOKER with search_path pinned, the service role''s alone, and switches to intake_door around its one INSERT — a privilege it lacks, or a policy not the door''s own, runs the INSERT again with the bound identity alone' AS check,
       (SELECT NOT p.prosecdef
               AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND p.prosrc LIKE '%v_rls  boolean := intake_door_version_rls_ready();%'
               AND p.prosrc LIKE '%IF v_rls THEN PERFORM set_config(''role'', ''intake_door'', true); END IF;%'
               AND p.prosrc LIKE '%IF v_rls THEN PERFORM set_config(''role'', v_role, true); END IF;%'
               AND p.prosrc LIKE '%EXCEPTION WHEN insufficient_privilege THEN%'
               AND p.prosrc LIKE '%"document_versions_intake_door_scope" for table "document_versions"%'
               AND p.prosrc LIKE '%v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);%'
               AND p.prosrc LIKE '%PERFORM intake_door_unbind(v_prev);%'
               AND p.prosrc NOT LIKE '%RETURNING id INTO v_id%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'intake_door_submit_version') AS ok,
       NULL::text AS n
UNION ALL
SELECT 'document_versions carries a permissive and a restrictive INSERT policy TO intake_door, reading the bound link''s submission (intake_door_may_submit)',
       (SELECT COUNT(*) = 2 AND COUNT(DISTINCT permissive) = 2 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'document_versions' AND roles = '{intake_door}' AND cmd = 'INSERT'
           AND with_check LIKE '%intake_door_may_submit(%'),
       NULL
UNION ALL
SELECT 'document_versions_insert_integrity keeps its 20261205 limbs (publish authority, the author''s own draft or first version through document_has_versions) and gains the door''s limb',
       EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'public' AND tablename = 'document_versions' AND policyname = 'document_versions_insert_integrity'
                  AND permissive = 'RESTRICTIVE' AND cmd = 'INSERT'
                  AND with_check LIKE '%user_can_publish_doc(record_id, org_id)%'
                  AND with_check LIKE '%doc_is_visible(record_id)%'
                  AND with_check LIKE '%document_has_versions(record_id)%'
                  AND with_check LIKE '%CURRENT_USER = %intake_door%'),
       NULL
UNION ALL
SELECT 'intake_door holds column INSERT on what the door inserts in document_versions (never created_by), nothing to read, update or delete there, and EXECUTE by name on the insert policies'' helpers',
       has_column_privilege('intake_door', 'public.document_versions', 'intake_link_id', 'INSERT')
       AND has_column_privilege('intake_door', 'public.document_versions', 'id', 'INSERT')
       AND NOT has_column_privilege('intake_door', 'public.document_versions', 'created_by', 'INSERT')
       AND NOT has_column_privilege('intake_door', 'public.document_versions', 'approved_by', 'INSERT')
       AND NOT has_table_privilege('intake_door', 'public.document_versions', 'INSERT')
       AND NOT has_any_column_privilege('intake_door', 'public.document_versions', 'SELECT')
       AND NOT has_any_column_privilege('intake_door', 'public.document_versions', 'UPDATE')
       AND NOT has_table_privilege('intake_door', 'public.document_versions', 'DELETE')
       AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public.user_can_publish_doc(uuid, uuid)', 'public.doc_is_visible(uuid)',
                                                  'public.document_has_versions(uuid)']) f
                        WHERE to_regprocedure(f) IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                                           WHERE p.oid = to_regprocedure(f) AND x.grantee = to_regrole('intake_door')
                                             AND x.privilege_type = 'EXECUTE')),
       NULL
UNION ALL
SELECT 'row-level security for the submission: authenticator (the API''s login) may switch to intake_door, and intake_door may EXECUTE and read what the live INSERT policies of document_versions use — false: each submission keeps the bound identity alone, filed as before (SEC-22)',
       to_regrole('authenticator') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM unnest(intake_door_version_rls_gaps('authenticator')) g
                        WHERE g IN ('role', 'switch') OR g LIKE 'execute %' OR g LIKE 'read %'),
       NULL
UNION ALL
SELECT 'row-level security for the submission: no restrictive INSERT or ALL policy for every role (or intake_door) on document_versions that the link may fail, by the door''s own test — false: one is live, and each submission keeps the bound identity alone, filed as before, until it says how it treats intake_door (SEC-22)',
       NOT EXISTS (SELECT 1 FROM unnest(intake_door_version_rls_gaps('authenticator')) g WHERE g LIKE 'policy %'),
       NULL
UNION ALL
SELECT 'the policy predicate (intake_door_may_submit) is SECURITY DEFINER with search_path pinned and intake_door''s alone; the readiness pair is SECURITY INVOKER and the service role''s alone',
       (SELECT p.prosecdef
               AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
               AND has_function_privilege('intake_door', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
          FROM pg_proc p WHERE p.proname = 'intake_door_may_submit')
       AND (SELECT COUNT(*) = 2 FROM pg_proc p
             WHERE p.proname IN ('intake_door_version_rls_gaps', 'intake_door_version_rls_ready')
               AND NOT p.prosecdef
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')),
       NULL
UNION ALL
SELECT 'the housekeeping and the intake folder (intake_door_housekeep, intake_door_intake_folder) are SECURITY DEFINER with search_path pinned, the service role''s alone, and bind then restore the link''s identity',
       (SELECT COUNT(*) = 2 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('intake_door_housekeep', 'intake_door_intake_folder')
           AND p.prosecdef
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
           AND has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND p.prosrc LIKE '%v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);%'
           AND p.prosrc LIKE '%PERFORM intake_door_unbind(v_prev);%'),
       NULL
UNION ALL
SELECT 'the intake pointers'' rail (trg_projects_intake_pointers) is bound to projects BEFORE INSERT OR UPDATE OF the two pointers; its function is SECURITY DEFINER, search_path pinned, executable by no client role',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_projects_intake_pointers' AND NOT t.tgisinternal
                  AND t.tgrelid = 'public.projects'::regclass AND t.tgenabled <> 'D')
       AND (SELECT p.prosecdef
                   AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
                   AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   AND p.prosrc LIKE '%IF auth.uid() IS NULL THEN RETURN NEW; END IF;%'
                   AND p.prosrc LIKE '%NOT is_org_controller(NEW.org_id)%'
                   AND p.prosrc LIKE '%NEW.intake_collection_id := NULL;%'
              FROM pg_proc p WHERE p.proname = 'enforce_project_intake_pointers'),
       NULL
UNION ALL
SELECT 'this editor session carries no door identity or role after the paste',
       COALESCE(current_setting('request.jwt.claims', true), '') NOT LIKE '%intake_door%'
       AND current_user <> 'intake_door',
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j20_inventory;
