-- 20261184_prj_roundG_intake_door_identity.sql
--
-- projects Round G — J16 INTAKE DOOR IDENTITY & UNTRUSTED ORIGIN: the
-- contractor door's content writes run as an identity the database guards
-- apply to, scoped to ONE link (projects-tab GAP-401, owed item 1).
--
-- WHY THIS SHAPE. The door has no signed-in user: app/api/intake/upload/
-- route.ts writes through the service role, whose JWT carries no `sub`, so
-- auth.uid() is NULL and every guard that reads it returns early ("the
-- service pass") — the publish guard, the register / hold-label rails, the
-- insert-pointer rail, the intake authorship rail (INTK-16), the project
-- record rail — and the service role bypasses row-level security outright.
-- This file gives the door two things, neither of which needs a JWT or its
-- signing secret:
--
--   * ROW-LEVEL SECURITY FOR THE DOOR'S NEW DOCUMENT AND QUOTE, through a
--     dedicated role. `intake_door` is a NOLOGIN role with no BYPASSRLS,
--     granted to `authenticator` (the role PostgREST logs in as). The two
--     door functions that make those rows are SECURITY INVOKER: called under
--     the service key, they resolve the link and bind its identity, then
--     switch to intake_door for the one INSERT (set_config('role',
--     'intake_door', true); Postgres refuses a role switch only inside a
--     SECURITY DEFINER function) and switch back. That INSERT is judged by
--     the policies written TO intake_door — a permissive and a restrictive
--     pair per table, keyed on the BOUND link (its org, project, intake
--     library and folder, its storage prefix, its company and RFQ group, a
--     party of its project), re-reading the link row so a revocation holds
--     there too — and by every policy written for all roles. The role
--     inherits no `TO authenticated` policy and adds no row to auth.users.
--     It holds only: INSERT on the columns the door writes in documents and
--     cost_documents; what the existing rails read AS the writer during a
--     document INSERT — SELECT (id, org_id, acl_index) on libraries
--     (documents_deny_upload_guard) and SELECT (document_id, source) with
--     DELETE on document_assets (documents_resync_assets clears tag links
--     after it), rows row-level security shows a link none of; USAGE on
--     schema auth, so the INVOKER document triggers that call auth.uid() run
--     as it; and EXECUTE, by name, on what the policies written for all roles
--     call (my_org_ids, is_org_controller, acl_index_denies,
--     user_owns_project, auth.uid) — Postgres checks each as it sets a policy
--     up, and a later REVOKE … FROM PUBLIC must not take them away.
--     WHERE THE PASTE CANNOT GRANT IT. Before each switch the door function
--     asks intake_door_rls_ready, which reads the LIVE catalogs: the session's
--     login may SET the role, the role holds USAGE on auth (a new document)
--     and EXECUTE / SELECT on every function and column the live INSERT
--     policies use, and no restrictive policy the link may fail stands in
--     the way (below). If anything is missing — authenticator could not be
--     made a member, the paster holds no grant option on schema auth or
--     auth.uid() (Postgres then only WARNS), a RESTRICTIVE INSERT or ALL
--     policy for every role (or for intake_door) on the table that is not
--     the door's own scope policy nor documents_deny_upload_guard in the
--     repository's shape — the final SELECT says so in four rows (from the
--     same function), and that write keeps the bound identity below without
--     the role switch — exactly the shape before this decision: the INSERT
--     runs under the service key, every trigger guard still judging it, and
--     the upload is filed. A privilege the check could not see ("permission
--     denied …" from the INSERT as intake_door), or the refusal of a NAMED
--     policy that is not the door's own (one made after the check ran, or
--     written TO a role intake_door inherits), does the same for that one
--     write, with a WARNING in the database log; the upload is never refused
--     for either. What the check cannot see and the handler cannot tell from
--     the door's own refusal — an unnamed refusal, which Postgres gives only
--     when no PERMISSIVE policy admits the row — is raised: the door's
--     permissive policy is the one a link passes, so that refusal is the
--     link's boundary.
--     A POLICY THE LINK MAY FAIL IS A GAP TOO. Every policy written for all
--     roles judges the INSERT as intake_door as it judges a member's, and a
--     RESTRICTIVE one the link's identity cannot satisfy (one that asks for
--     membership, say) would refuse that write — an upload that works today
--     would answer 500. So intake_door_rls_gaps names each RESTRICTIVE
--     INSERT or ALL policy of the table for PUBLIC or intake_door ('policy
--     <name>') beyond the door's own *_intake_door_scope and
--     documents_deny_upload_guard as the repository writes it (by pg_depend
--     it reads only libraries, of which row-level security shows a link no
--     row, through auth.uid, is_org_controller and acl_index_denies), and
--     that table's write keeps the bound identity — every trigger guard
--     still judges it — until the policy says how it treats intake_door (a
--     TO clause, or a limb for the role). The fourth "row-level security"
--     row of the final SELECT reports it (SEC-22); a shape test fails a
--     later migration that adds one without saying how intake_door is
--     treated. After the switch only the door's own policies refuse its
--     write (the route answers 500): they are the link's boundary.
--   * A BOUND IDENTITY for every content write. Before its write, each door
--     function binds — for the transaction, restored before it returns —
--     request.jwt.claims (and the legacy request.jwt.claim.sub / .role) to
--     { sub, role: 'intake_door', intake_link_id, org_id, project_id }.
--     auth.uid() is then NOT NULL, so every trigger guard a member's write
--     meets judges the door's write:
--       - document, version, pointer and quote writes: sub = the LINK's id
--         (no member is that id — the guards see a writer with no
--         membership and no authority, which is what a link is);
--       - the trusted promote: sub = the link's CREATOR, the member DEC-56
--         item 2 publishes as. publish_revision already acts as the creator;
--         from here its documents write also passes the publish guard AS the
--         creator — publish authority on the library, review completion, the
--         require-mode and first-issue limbs, reviewer independence, the hold
--         limbs — and the register and hold-label rails, which returned
--         early on the service role (projects-tab SEC-4's residual: those
--         were the route's own checks until now; the route keeps them, so a
--         refusal still DEMOTES with its sentence, and the database is the
--         boundary). The version it publishes is built from an allow-list of
--         the route's fields (label, key, type, size, note, name, hash; the
--         provenance 'external') — no field that turns a guard off (change
--         type, issue type, MOC, revert, ticket, source) ever comes from the
--         caller.
--     Every door function resolves the link FROM ITS TOKEN HASH IN THE
--     DATABASE (never an id the caller names): it must exist, be neither
--     revoked nor expired, and its project must exist and be open — so a
--     revocation is effective mid-request too. Each refuses a write outside
--     the link's scope with its own HINT (for the new document and the
--     quote, the policies above refuse the same rows again, as the boundary).
--     The redline is the one write that does NOT bind: the ticket rails
--     (drafting-flow DF-P1, 20261166) make a ticket's attachments a
--     service-only column and append_ticket_redline refuses a signed-in
--     caller, so the door's redline goes through that one append — after
--     this function checks, in the database, that the ticket names the link.
--   * INTK-16's authorship rail, re-created from its NEWEST body (20261141,
--     found by scanning; lineDiff-pinned): one added block lets the door's
--     identity record its OWN link — and no other — as the author of the
--     document it creates. Every other rule binds the door like any
--     signed-in writer: it never changes authorship afterwards, and a
--     member never stamps a link at all (unchanged).
--
-- NOT under row-level security here (projects-tab SEC-22, opened by this
-- package), each for a reason a scratch PostgreSQL 16 run of the whole
-- sequence showed:
--   - the submission (a document_versions INSERT): any INSERT into
--     document_versions by a role row-level security applies to fails at
--     rewrite with 42P17 "infinite recursion detected in policy" —
--     20261037's document_versions_insert_integrity reads document_versions
--     in its first-version test while document_versions_org_access holds a
--     subquery. That is true for a signed-in member today too (owner:
--     roles-and-permissions); until it is fixed the door's submission keeps
--     the bound identity under the service key;
--   - the pending pointer (an UPDATE: documents_acl_select, a restrictive
--     read policy for every role, hides even the link's own Draft from a
--     writer with no membership, so the compare-and-set would match no row);
--   - the trusted promote (publish_revision is SECURITY DEFINER; it is
--     judged by the trigger guards as the creator), the redline (the ticket
--     rails' service-only append), and the door's housekeeping of its own
--     rows (retiring a displaced submission, withdrawing a lost race,
--     restoring, discarding a just-created document, the intake folder, the
--     project reference), which still run as the service role.
--
-- NOT a widening for any client role. Every door function is EXECUTE-able by
-- the service role alone (which could already write all of this, unguarded);
-- intake_door cannot log in and only a session that logs in as
-- authenticator can switch to it; the policies and the rail's added block
-- admit only the identity the door functions bind. Net effect: the door's
-- content writes go from "exempt from every guard" to "judged by every
-- guard", and its new documents and quotes from "bypassing row-level
-- security" to "under it". The DEC-30 inventory (aggregate counts only,
-- captured BEFORE the transaction) shows the populations the door's writes
-- will now meet the guards with.
--
-- THE APP BEFORE AND AFTER THE PASTE. The route calls each door function
-- first and, when it is not there (PostgREST PGRST202, or 42883 naming an
-- intake_door_ function), writes exactly as today — so the app works before
-- this paste and after it. Any OTHER refusal (a guard, a policy, the link's
-- scope, a link revoked mid-request) is answered and is never followed by
-- the service-role write. intake_door_append_redline answers 42883 while
-- append_ticket_redline (20261166) is not pasted, and the route then takes
-- today's redline path (its own fallback included).
--
-- HOW TO APPLY: paste the whole file into the Supabase SQL editor and run it
-- once (a re-run is safe: every step is idempotent). The final SELECT is the
-- only result set shown — probe rows must read ok = true (if one of the four
-- "row-level security" rows reads false, the paste still applied and the
-- door's uploads are filed as before, with the bound identity: send that row
-- back, it is SEC-22's next step); inventory rows carry ok NULL and a count
-- in n.
-- PASTE ORDER: after 20261141 (required — this file re-creates its
-- documents_authorship_fixed and reads token_hash; the first statement
-- refuses to run, changing nothing, without it; 20261141 itself follows
-- 20261104 and 20261105). No other prerequisite: the promote calls
-- publish_revision by name, whichever of its signatures is live.
-- ⚠ Never re-paste 20261141 after this file: it would drop the door's
-- authorship block, and the door's new-document writes would then be
-- refused by the rail (the route answers 500 — "Couldn't create the
-- document") until this file is pasted again.
-- DEPLOY ORDER: none required. Before the J16 build is deployed nothing calls
-- the door functions (the old route writes as today; the rail's new block
-- and the intake_door policies are reachable only through them). After it
-- is deployed, the route uses them from the moment this file is pasted.

-- ── Prerequisite (refuse to run, changing nothing, without 20261141) ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'project_intake_links' AND column_name = 'token_hash')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'authored_by_link_id')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'documents_authorship_fixed'
                     AND prosrc LIKE '%Only the contractor door records that a link authored a document%') THEN
    RAISE EXCEPTION 'Apply 20261141_prj_roundG_intake_token_hash_and_adoption.sql (and 20261104, 20261105) first — this migration builds on project_intake_links.token_hash and re-creates its documents_authorship_fixed. Nothing was changed.';
  END IF;
END;
$$;

-- ── DEC-30 inventory, captured BEFORE the transaction (counts only) ───────
DROP TABLE IF EXISTS pg_temp.prj_g_j16_inventory;
CREATE TEMP TABLE prj_g_j16_inventory AS
SELECT 'inventory: live intake links (not revoked, not expired) — the doors whose writes run under the door identity once the J16 build is live' AS inventory,
       COUNT(*)::text AS n
  FROM project_intake_links
 WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
UNION ALL
SELECT 'inventory: …of them trusted (auto-publish) — their promote now passes the publish guard as the link''s creator',
       COUNT(*)::text
  FROM project_intake_links
 WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) AND allow_auto_supersede
UNION ALL
SELECT 'inventory: …trusted, whose creator is not an active member of the link''s org (publish_revision refuses them today too: their uploads go to review, unchanged)',
       COUNT(*)::text
  FROM project_intake_links l
 WHERE l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > NOW()) AND l.allow_auto_supersede
   AND NOT EXISTS (SELECT 1 FROM org_members m
                    WHERE m.org_id = l.org_id AND m.uid::text = l.created_by AND m.status = 'active')
UNION ALL
SELECT 'inventory: …live links whose project has no intake library yet (a new document is refused 409 before any write, as today)',
       COUNT(*)::text
  FROM project_intake_links l
  JOIN projects p ON p.id = l.project_id
 WHERE l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > NOW())
   AND p.intake_library_id IS NULL
UNION ALL
SELECT 'inventory: intake-born documents (authored_by_link_id set) — the authorship rail''s population',
       COUNT(*)::text
  FROM documents WHERE authored_by_link_id IS NOT NULL
UNION ALL
SELECT 'inventory: roles named intake_door before this paste (0 on the first paste; this file makes it)',
       COUNT(*)::text
  FROM pg_roles WHERE rolname = 'intake_door';

BEGIN;

-- ── 0. The door's role: row-level security for its new document and quote ─
-- NOLOGIN, no BYPASSRLS, member of nothing. A role of that name made by
-- anyone else, able to log in or to bypass row-level security, is refused.
DO $$
DECLARE
  r record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication
    INTO r FROM pg_roles WHERE rolname = 'intake_door';
  IF NOT FOUND THEN
    CREATE ROLE intake_door NOLOGIN NOINHERIT;
  ELSIF r.rolsuper OR r.rolbypassrls OR r.rolcanlogin OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'A role named intake_door already exists and can log in, create roles or bypass row-level security — this file needs it to be the contractor door''s constrained role. Nothing was changed.';
  END IF;
  -- PostgREST logs in as authenticator: only a session of that login can
  -- switch to intake_door, and only the door functions do.
  IF to_regrole('authenticator') IS NOT NULL THEN
    BEGIN
      GRANT intake_door TO authenticator;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'J16: intake_door could not be granted to authenticator (%) — the door''s new documents and quotes keep the bound identity without row-level security (see the final SELECT).', SQLERRM;
    END;
  END IF;
  -- The INVOKER document triggers call auth.uid(). Without a grant option on
  -- schema auth Postgres only WARNS here; the final SELECT says which.
  IF to_regnamespace('auth') IS NOT NULL THEN
    BEGIN
      GRANT USAGE ON SCHEMA auth TO intake_door;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'J16: USAGE on schema auth could not be granted to intake_door (%) — a new document keeps the bound identity without row-level security (see the final SELECT).', SQLERRM;
    END;
  END IF;
  -- The intake route has always written documents.created_by_name; the
  -- repository's base schema does not define it (a column of the live
  -- table), so it is granted where it exists.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = 'created_by_name') THEN
    GRANT INSERT (created_by_name) ON documents TO intake_door;
  END IF;
  -- What the policies written for all roles call when they judge the door's
  -- INSERT. Postgres checks EXECUTE on every function of a policy as it sets
  -- the policy up, whichever limb decides: documents_org_access (my_org_ids),
  -- documents_deny_upload_guard (is_org_controller, acl_index_denies,
  -- auth.uid), cost_documents_write (is_org_controller),
  -- cost_documents_owner_write (user_owns_project). The role holds them
  -- through PUBLIC today; it is granted them BY NAME, so a later REVOKE …
  -- FROM PUBLIC (DRLS-16) does not take them away. intake_door_rls_ready
  -- re-reads the live policies before every switch all the same.
  IF to_regprocedure('public.my_org_ids()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.my_org_ids() TO intake_door;
  END IF;
  IF to_regprocedure('public.is_org_controller(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.is_org_controller(uuid) TO intake_door;
  END IF;
  IF to_regprocedure('public.acl_index_denies(jsonb, uuid, uuid, text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.acl_index_denies(jsonb, uuid, uuid, text) TO intake_door;
  END IF;
  IF to_regprocedure('public.user_owns_project(uuid)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.user_owns_project(uuid) TO intake_door;
  END IF;
  -- auth.uid() belongs to the auth schema's owner: soft, like USAGE above
  -- (without a grant option Postgres only WARNS; PUBLIC's grant stays).
  IF to_regnamespace('auth') IS NOT NULL AND to_regprocedure('auth.uid()') IS NOT NULL THEN
    BEGIN
      GRANT EXECUTE ON FUNCTION auth.uid() TO intake_door;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'J16: EXECUTE on auth.uid() could not be granted to intake_door (%) — the final SELECT says whether the role may call it.', SQLERRM;
    END;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO intake_door;
GRANT INSERT (id, org_id, library_id, collection_id, name, title, document_number, status,
              updated_at, uniqueness_key, authored_by_link_id)
  ON documents TO intake_door;
GRANT INSERT (id, org_id, project_id, kind, file_url, file_name, mime_type, vendor_name,
              rfq_group, intake_link_id, party_id, status, created_by, file_hash)
  ON cost_documents TO intake_door;
-- What the existing rails read AS the writer during those inserts (row-level
-- security shows a link none of these rows):
GRANT SELECT (id, org_id, acl_index) ON libraries TO intake_door;             -- documents_deny_upload_guard
GRANT SELECT (document_id, source), DELETE ON document_assets TO intake_door;  -- documents_resync_assets

-- ── 1. The door's identity: the link from its hash, bound for one write ───
CREATE OR REPLACE FUNCTION public.intake_door_resolve(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_link    project_intake_links%ROWTYPE;
  v_project projects%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'intake_door: only the intake route, under the service key, opens the contractor door.'
      USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'intake_door: no link answers this credential.' USING ERRCODE = '28000', HINT = 'notfound';
  END IF;
  SELECT * INTO v_link FROM project_intake_links WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'intake_door: no link answers this credential.' USING ERRCODE = '28000', HINT = 'notfound';
  END IF;
  IF v_link.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'intake_door: the link was revoked.' USING ERRCODE = '28000', HINT = 'revoked';
  END IF;
  IF v_link.expires_at IS NOT NULL AND v_link.expires_at < NOW() THEN
    RAISE EXCEPTION 'intake_door: the link expired.' USING ERRCODE = '28000', HINT = 'expired';
  END IF;
  SELECT * INTO v_project FROM projects WHERE id = v_link.project_id AND org_id = v_link.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'intake_door: the link''s project no longer exists.' USING ERRCODE = '28000', HINT = 'link_gone';
  END IF;
  -- lib/intakeLinks.ts CLOSED_PROJECT_STATUSES
  IF v_project.status IN ('completed', 'cancelled', 'archived') THEN
    RAISE EXCEPTION 'intake_door: the link''s project is closed.' USING ERRCODE = '28000', HINT = 'project_closed';
  END IF;
  RETURN jsonb_build_object(
    'link_id', v_link.id,
    'org_id', v_link.org_id,
    'project_id', v_link.project_id,
    'library_id', v_project.intake_library_id,
    'collection_id', v_project.intake_collection_id,
    'created_by', v_link.created_by,
    'trusted', COALESCE(v_link.allow_auto_supersede, false),
    'assigned', to_jsonb(COALESCE(v_link.assigned_doc_ids, ARRAY[]::uuid[])),
    'company', v_link.company_name,
    'purpose', COALESCE(v_link.purpose, 'documents'),
    'rfq_group', v_link.rfq_group);
END;
$$;

COMMENT ON FUNCTION public.intake_door_resolve(text) IS
  'GAP-401 (J16): the live link a token hash names, with its project''s intake library and folder — refused (28000, HINT revoked / expired / link_gone / project_closed / notfound) when it no longer opens anything. Called inside the intake_door_* functions; the service role alone may execute it.';

CREATE OR REPLACE FUNCTION public.intake_door_bind(p_sub uuid, p_link uuid, p_org uuid, p_project uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev jsonb := jsonb_build_object(
    'claims', COALESCE(current_setting('request.jwt.claims', true), ''),
    'sub',    COALESCE(current_setting('request.jwt.claim.sub', true), ''),
    'role',   COALESCE(current_setting('request.jwt.claim.role', true), ''));
BEGIN
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'intake_door', 'intake_link_id', p_link,
                       'org_id', p_org, 'project_id', p_project)::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);
  PERFORM set_config('request.jwt.claim.role', 'intake_door', true);
  RETURN v_prev;
END;
$$;

COMMENT ON FUNCTION public.intake_door_bind(uuid, uuid, uuid, uuid) IS
  'GAP-401 (J16): binds the door''s identity for the rest of the transaction (auth.uid() = p_sub, role intake_door, the link, org and project named) and answers what to restore. Called inside the intake_door_* functions; the service role alone may execute it.';

CREATE OR REPLACE FUNCTION public.intake_door_unbind(p_prev jsonb)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', COALESCE(p_prev->>'claims', ''), true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_prev->>'sub', ''), true);
  PERFORM set_config('request.jwt.claim.role', COALESCE(p_prev->>'role', ''), true);
END;
$$;

COMMENT ON FUNCTION public.intake_door_unbind(jsonb) IS
  'GAP-401 (J16): restores the claims intake_door_bind replaced. Called inside the intake_door_* functions; the service role alone may execute it.';

-- What the door's INSERT as intake_door would lack on THIS database, read
-- from the live catalogs (a hosted difference is seen): one entry per gap.
-- The door functions switch only when there is none (intake_door_rls_ready,
-- p_login = session_user); the final SELECT asks the same function for
-- authenticator, so the paste reports exactly what the door will decide.
CREATE OR REPLACE FUNCTION public.intake_door_rls_gaps(p_login name, p_new_document boolean)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_door  oid := to_regrole('intake_door');
  v_table oid := CASE WHEN p_new_document THEN to_regclass('public.documents') ELSE to_regclass('public.cost_documents') END;
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
  -- A new document: the INVOKER document triggers call auth.uid() by name.
  IF p_new_document AND (to_regnamespace('auth') IS NULL OR NOT has_schema_privilege('intake_door', 'auth', 'USAGE')) THEN
    v_gaps := v_gaps || 'auth usage'::text;
  END IF;
  -- EXECUTE on every function an INSERT policy of the table calls for this
  -- role (Postgres checks each as it sets the policy up), and on auth.uid(),
  -- which the INVOKER document triggers call.
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
               AND (0::oid = ANY (pol.polroles) OR v_door = ANY (pol.polroles))
            UNION
            SELECT to_regprocedure('auth.uid()')::oid WHERE p_new_document AND to_regnamespace('auth') IS NOT NULL) f
     WHERE f.fn IS NOT NULL AND NOT has_function_privilege('intake_door', f.fn, 'EXECUTE')
     ORDER BY 1);
  -- SELECT on every column of another table such a policy reads (a table it
  -- names with no column: any column).
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
  -- A RESTRICTIVE INSERT or ALL policy of the table for every role (or for
  -- intake_door) judges the INSERT as intake_door as it judges a member's,
  -- and one the link's identity may fail would refuse an upload that works
  -- today. Beyond the door's own scope policy (TO intake_door alone) and
  -- documents_deny_upload_guard while pg_depend shows the repository's shape
  -- (it reads only libraries, of which row-level security shows a link no
  -- row, through auth.uid, is_org_controller and acl_index_denies), each is
  -- a gap: the write keeps the bound identity until the policy says how it
  -- treats intake_door (SEC-22).
  v_gaps := v_gaps || ARRAY(
    SELECT DISTINCT 'policy ' || pol.polname::text
      FROM pg_policy pol
     WHERE pol.polrelid = v_table AND NOT pol.polpermissive AND pol.polcmd IN ('a', '*')
       AND (0::oid = ANY (pol.polroles) OR v_door = ANY (pol.polroles))
       AND NOT ((pol.polrelid, pol.polname) IN ((to_regclass('public.documents'), 'documents_intake_door_scope'),
                                                (to_regclass('public.cost_documents'), 'cost_documents_intake_door_scope'))
                AND pol.polroles = ARRAY[v_door])
       AND NOT (pol.polrelid = to_regclass('public.documents') AND pol.polname = 'documents_deny_upload_guard'
                AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                 WHERE d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
                                   AND NOT ((d.refclassid = 'pg_class'::regclass
                                             AND d.refobjid IN (pol.polrelid, to_regclass('public.libraries')))
                                         OR (d.refclassid = 'pg_proc'::regclass
                                             AND d.refobjid IN (to_regprocedure('auth.uid()'), to_regprocedure('public.is_org_controller(uuid)'),
                                                                to_regprocedure('public.acl_index_denies(jsonb, uuid, uuid, text)'))))))
     ORDER BY 1);
  RETURN v_gaps;
END;
$$;

COMMENT ON FUNCTION public.intake_door_rls_gaps(name, boolean) IS
  'GAP-401 (J16): what the door''s INSERT as intake_door would lack here — ''role'', ''switch'' (p_login may not SET the role; MEMBER before PG16), ''auth usage'' (a new document), ''execute <function>'' and ''read <table.column>'' for what the live INSERT policies of documents (p_new_document) or cost_documents call and read, and auth.uid(); and ''policy <name>'' for a RESTRICTIVE INSERT or ALL policy of that table for every role (or intake_door) the link may fail — any but the door''s own scope policy and documents_deny_upload_guard in the repository''s shape. Empty: the door may switch. Read by intake_door_rls_ready and the paste''s final SELECT. Service role only.';

CREATE OR REPLACE FUNCTION public.intake_door_rls_ready(p_new_document boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT cardinality(intake_door_rls_gaps(session_user, p_new_document)) = 0;
$$;

COMMENT ON FUNCTION public.intake_door_rls_ready(boolean) IS
  'GAP-401 (J16): whether the door''s INSERT may run as intake_door on this database — intake_door_rls_gaps(session_user, …) finds no gap: this session''s login may switch to the role, the role holds what the live INSERT policies (and, for a new document, the triggers'' auth.uid()) need, and no restrictive policy for every role that the link may fail is live on the table. False: the door function writes with the bound identity alone, as before row-level security. Service role only.';

-- The bound link, as the policies TO intake_door read it: only inside the
-- door's role, only for the identity a door function bound, re-read from the
-- link row (live, its project open). NULL otherwise — a policy reads false.
CREATE OR REPLACE FUNCTION public.intake_door_bound()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_text    text := NULLIF(current_setting('request.jwt.claims', true), '');
  v_claims  jsonb;
  v_link    project_intake_links%ROWTYPE;
  v_project projects%ROWTYPE;
BEGIN
  IF COALESCE(current_setting('role', true), '') <> 'intake_door' OR v_text IS NULL THEN
    RETURN NULL;
  END IF;
  v_claims := v_text::jsonb;
  IF v_claims->>'role' IS DISTINCT FROM 'intake_door'
     OR COALESCE(v_claims->>'intake_link_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR auth.uid() IS DISTINCT FROM (v_claims->>'intake_link_id')::uuid THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_link FROM project_intake_links WHERE id = (v_claims->>'intake_link_id')::uuid;
  IF NOT FOUND OR v_link.revoked_at IS NOT NULL OR (v_link.expires_at IS NOT NULL AND v_link.expires_at < NOW())
     OR v_link.org_id::text IS DISTINCT FROM v_claims->>'org_id'
     OR v_link.project_id::text IS DISTINCT FROM v_claims->>'project_id' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_project FROM projects WHERE id = v_link.project_id AND org_id = v_link.org_id;
  -- lib/intakeLinks.ts CLOSED_PROJECT_STATUSES
  IF NOT FOUND OR v_project.status IN ('completed', 'cancelled', 'archived') THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'link_id', v_link.id,
    'org_id', v_link.org_id,
    'project_id', v_link.project_id,
    'library_id', v_project.intake_library_id,
    'collection_id', v_project.intake_collection_id,
    'assigned', to_jsonb(COALESCE(v_link.assigned_doc_ids, ARRAY[]::uuid[])),
    'company', v_link.company_name,
    'purpose', COALESCE(v_link.purpose, 'documents'),
    'rfq_group', v_link.rfq_group);
END;
$$;

COMMENT ON FUNCTION public.intake_door_bound() IS
  'GAP-401 (J16): the link a door function bound (role intake_door, auth.uid() = the link), re-read live from its row — NULL for any other caller or a link no longer live. Read only by the intake_door_may_* policy predicates; no role may execute it.';

CREATE OR REPLACE FUNCTION public.intake_door_may_create(p_org uuid, p_library uuid, p_collection uuid, p_author uuid, p_status text)
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
    AND p_library::text = v_door->>'library_id'
    AND p_collection::text = v_door->>'collection_id'
    AND p_author::text = v_door->>'link_id'
    AND p_status = 'Draft'
    AND EXISTS (SELECT 1 FROM collections c WHERE c.id = p_collection AND c.org_id = p_org AND c.library_id = p_library),
    false);
END;
$$;

COMMENT ON FUNCTION public.intake_door_may_create(uuid, uuid, uuid, uuid, text) IS
  'GAP-401 (J16): the documents INSERT policies TO intake_door — a Draft in the bound link''s project intake library and intake folder, authored by that link. Only intake_door may execute it.';

CREATE OR REPLACE FUNCTION public.intake_door_may_quote(p_org uuid, p_project uuid, p_kind text, p_link uuid, p_file_url text,
                                                       p_party uuid, p_vendor text, p_rfq text, p_status text, p_created_by uuid)
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
    AND v_door->>'purpose' = 'quote'
    AND p_org::text = v_door->>'org_id'
    AND p_project::text = v_door->>'project_id'
    AND p_kind = 'quote'
    AND p_link::text = v_door->>'link_id'
    AND p_file_url ~ ('^orgs/' || (v_door->>'org_id') || '/project-costs/' || (v_door->>'project_id') || '/quote-[^/]+$')
    AND (p_party IS NULL
         OR EXISTS (SELECT 1 FROM project_parties pp WHERE pp.id = p_party AND pp.project_id = p_project AND pp.org_id = p_org))
    AND p_vendor IS NOT DISTINCT FROM v_door->>'company'
    AND p_rfq IS NOT DISTINCT FROM v_door->>'rfq_group'
    AND p_status = 'draft'
    AND p_created_by IS NULL,
    false);
END;
$$;

COMMENT ON FUNCTION public.intake_door_may_quote(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid) IS
  'GAP-401 (J16): the cost_documents INSERT policies TO intake_door — a draft quote of the bound QUOTE link on its own project, vendor and RFQ group the link''s, a party only of that project, the file under the project''s costs prefix. Only intake_door may execute it.';

-- ── 2. A new document: the project's intake library and folder only ───────
CREATE OR REPLACE FUNCTION public.intake_door_create_document(p_token_hash text, p_doc jsonb)
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
  v_lib  uuid  := NULLIF(v_door->>'library_id', '')::uuid;
  v_col  uuid  := NULLIF(v_door->>'collection_id', '')::uuid;
  v_row  documents%ROWTYPE;
  v_prev jsonb;
  v_id   uuid  := gen_random_uuid();
  v_rls  boolean := intake_door_rls_ready(true);
  v_role text  := current_setting('role');
BEGIN
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF v_lib IS NULL OR v_col IS NULL THEN
    RAISE EXCEPTION 'intake_door: the project''s intake library or folder is not set.' USING ERRCODE = '42501', HINT = 'not_configured';
  END IF;
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'intake_door: one document object is required.' USING ERRCODE = '22023';
  END IF;
  -- The folder the route filed into is the project's intake folder, inside
  -- the project's intake library — never one the caller names elsewhere.
  IF NULLIF(p_doc->>'collection_id', '')::uuid IS DISTINCT FROM v_col
     OR NOT EXISTS (SELECT 1 FROM collections c WHERE c.id = v_col AND c.org_id = v_org AND c.library_id = v_lib) THEN
    RAISE EXCEPTION 'intake_door: a new document is filed only into the project''s intake folder.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  v_row := jsonb_populate_record(NULL::documents, p_doc);
  v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);
  -- The INSERT as intake_door, under row-level security (the id is chosen
  -- here: a RETURNING would also need the read policies, which show a link
  -- nothing). Back to the caller's role before anything else runs.
  -- A privilege the role lacks here that intake_door_rls_ready could not
  -- foresee ("permission denied …"), or the refusal of a policy that is not
  -- the door's own (one the readiness check let through, or made since it
  -- ran: Postgres names it), is not the contractor's to answer for: the
  -- failed INSERT is undone with its role switch, a WARNING names the cause,
  -- and the same INSERT runs once more with the bound identity alone — the
  -- shape before row-level security (SEC-22). The door's own policies'
  -- refusal (no permissive policy admits the row, which Postgres reports
  -- naming none, or the scope policy, named) and every other error are
  -- raised as they are: they are the link's boundary.
  LOOP
    BEGIN
      IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;
      INSERT INTO documents (id, org_id, library_id, collection_id, name, title, document_number, status,
                             created_by_name, updated_at, uniqueness_key, authored_by_link_id)
      VALUES (v_id, v_org, v_lib, v_col, v_row.name, v_row.title, v_row.document_number, 'Draft',
              v_row.created_by_name, COALESCE(v_row.updated_at, NOW()), v_row.uniqueness_key, v_link);
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      EXIT;
    EXCEPTION WHEN insufficient_privilege THEN
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      IF NOT v_rls
         OR SQLERRM IN ('new row violates row-level security policy for table "documents"',
                        'new row violates row-level security policy "documents_intake_door_scope" for table "documents"')
         OR NOT (SQLERRM LIKE 'permission denied%' OR SQLERRM LIKE 'new row violates row-level security policy "%') THEN
        RAISE;
      END IF;
      RAISE WARNING 'intake_door_create_document: % — this new document is written with the bound identity alone, without row-level security (projects-tab SEC-22).', SQLERRM;
      v_rls := false;
    END;
  END LOOP;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.intake_door_create_document(text, jsonb) IS
  'GAP-401 (J16): the contractor door creates a Draft document in its project''s intake library and folder, authored by its own link, as the door''s identity (auth.uid() = the link) — every insert rail judges it — and, where the paste could grant it, as the role intake_door under the documents_intake_door_* policies. Service role only.';

-- ── 3. A submission: a version of the link's own or assigned document ─────
CREATE OR REPLACE FUNCTION public.intake_door_submit_version(p_token_hash text, p_version jsonb)
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
  v_v    document_versions%ROWTYPE;
  v_prev jsonb;
  v_id   uuid;
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
  INSERT INTO document_versions (org_id, record_id, revision_label, file_url, file_type, size, change_log,
                                 created_by_name, created_at, released_at, review_state, provenance,
                                 intake_link_id, file_hash, supersedes_version_id)
  VALUES (v_org, v_v.record_id, v_v.revision_label, v_v.file_url, v_v.file_type, v_v.size, v_v.change_log,
          v_v.created_by_name, COALESCE(v_v.created_at, NOW()), NULL, 'in_review', 'external',
          v_link, v_v.file_hash, v_v.supersedes_version_id)
  RETURNING id INTO v_id;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.intake_door_submit_version(text, jsonb) IS
  'GAP-401 (J16): the contractor door inserts an in-review external submission on a document its link authored or was assigned, its file under the link''s project prefix, as the door''s identity. Service role only.';

-- ── 4. The pending pointer: only the link's own submission, compare-and-set ─
CREATE OR REPLACE FUNCTION public.intake_door_point_pending(p_token_hash text, p_doc uuid, p_version uuid, p_from uuid, p_at timestamptz DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_door jsonb := intake_door_resolve(p_token_hash);
  v_link uuid  := (v_door->>'link_id')::uuid;
  v_org  uuid  := (v_door->>'org_id')::uuid;
  v_proj uuid  := (v_door->>'project_id')::uuid;
  v_assigned boolean := p_doc::text IN (SELECT jsonb_array_elements_text(v_door->'assigned'));
  v_author uuid;
  v_prev jsonb;
  v_n    integer;
BEGIN
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  SELECT d.authored_by_link_id INTO v_author FROM documents d WHERE d.id = p_doc AND d.org_id = v_org;
  IF NOT FOUND OR NOT (v_author IS NOT DISTINCT FROM v_link OR v_assigned) THEN
    RAISE EXCEPTION 'intake_door: this link submits only to its own or assigned documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM document_versions v
                  WHERE v.id = p_version AND v.record_id = p_doc AND v.org_id = v_org
                    AND v.intake_link_id = v_link AND v.review_state = 'in_review' AND v.superseded_at IS NULL) THEN
    RAISE EXCEPTION 'intake_door: the pending revision must be this link''s own submission, still in review.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  -- INTK-4 dw3: only a TRUSTED link replaces a pending submission, only on
  -- its own (unassigned) document, and only its own earlier submission.
  IF p_from IS NOT NULL
     AND NOT (COALESCE((v_door->>'trusted')::boolean, false)
              AND v_author IS NOT DISTINCT FROM v_link AND NOT v_assigned
              AND EXISTS (SELECT 1 FROM document_versions f
                           WHERE f.id = p_from AND f.record_id = p_doc AND f.intake_link_id = v_link)) THEN
    RAISE EXCEPTION 'intake_door: only a trusted link replaces its own earlier submission.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);
  UPDATE documents
     SET pending_version_id = p_version, updated_at = COALESCE(p_at, NOW())
   WHERE id = p_doc AND org_id = v_org AND pending_version_id IS NOT DISTINCT FROM p_from;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.intake_door_point_pending(text, uuid, uuid, uuid, timestamptz) IS
  'GAP-401 (J16): the contractor door points its document''s pending revision at its own in-review submission, compare-and-set on the pointer it read (from NULL, or — a trusted link, its own document — from its own earlier submission); answers the rows written (0 = a lost race). As the door''s identity. Service role only.';

-- ── 5. The trusted promote: publish_revision AS THE CREATOR, guard live ───
CREATE OR REPLACE FUNCTION public.intake_door_promote(p_token_hash text, p_doc uuid, p_expected_base uuid, p_version jsonb, p_actor_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_door    jsonb := intake_door_resolve(p_token_hash);
  v_link    uuid  := (v_door->>'link_id')::uuid;
  v_org     uuid  := (v_door->>'org_id')::uuid;
  v_proj    uuid  := (v_door->>'project_id')::uuid;
  v_creator text  := NULLIF(btrim(COALESCE(v_door->>'created_by', '')), '');
  v_doc     record;
  v_prev    jsonb;
  v_res     jsonb;
  v_vid     uuid;
BEGIN
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never documents.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF NOT COALESCE((v_door->>'trusted')::boolean, false) THEN
    RAISE EXCEPTION 'intake_door: this link does not publish — its submissions go to review.' USING ERRCODE = '42501', HINT = 'not_trusted';
  END IF;
  IF v_creator IS NULL OR v_creator !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'intake_door: the link names no member to publish under.' USING ERRCODE = '42501', HINT = 'no_creator';
  END IF;
  SELECT d.authored_by_link_id, d.current_version_id INTO v_doc FROM documents d WHERE d.id = p_doc AND d.org_id = v_org;
  IF NOT FOUND
     OR v_doc.authored_by_link_id IS DISTINCT FROM v_link
     OR p_doc::text IN (SELECT jsonb_array_elements_text(v_door->'assigned'))
     OR v_doc.current_version_id IS NULL THEN
    RAISE EXCEPTION 'intake_door: a link publishes only its own, unassigned, already-approved document.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF jsonb_typeof(p_version) IS DISTINCT FROM 'object'
     OR COALESCE(p_version->>'file_url', '') !~ ('^orgs/' || v_org::text || '/project-intake/' || v_proj::text || '/[^/]+$') THEN
    RAISE EXCEPTION 'intake_door: the file is not stored under this link''s project.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  -- DEC-56 item 2: the promote acts as the link's creator — now in the
  -- database too, so publish_revision's own session check and every guard on
  -- its documents write judge the creator, not "the service pass".
  -- The version is built from an allow-list of what the route sends: no
  -- change type, issue type, MOC, revert, ticket or source field — each of
  -- which turns a guard limb off — ever comes from the caller.
  v_prev := intake_door_bind(v_creator::uuid, v_link, v_org, v_proj);
  v_res := publish_revision(
    p_doc => p_doc,
    p_expected_base => p_expected_base,
    p_op_class => 'content',
    p_version => jsonb_build_object(
      'revision_label', p_version->'revision_label',
      'file_url', p_version->'file_url',
      'file_type', p_version->'file_type',
      'size', p_version->'size',
      'change_log', p_version->'change_log',
      'created_by_name', p_version->'created_by_name',
      'file_hash', p_version->'file_hash',
      'provenance', 'external'),
    p_actor => v_creator::uuid,
    p_actor_name => p_actor_name);
  IF v_res->>'status' = 'published' THEN
    v_vid := NULLIF(v_res #>> '{version,id}', '')::uuid;
    IF v_vid IS NOT NULL THEN
      -- publish_revision's INSERT carries no intake_link_id: the provenance
      -- stamp, in the same transaction as the publish.
      UPDATE document_versions SET intake_link_id = v_link WHERE id = v_vid AND record_id = p_doc;
      v_res := v_res || jsonb_build_object('intake_link_stamped', FOUND);
    END IF;
  END IF;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_res;
END;
$$;

COMMENT ON FUNCTION public.intake_door_promote(text, uuid, uuid, jsonb, text) IS
  'GAP-401 (J16): a TRUSTED link''s revision of its own, unassigned, approved document published through publish_revision acting as the link''s creator (DEC-56 item 2), with the creator bound as auth.uid() so the publish guard and the register / hold-label rails judge the write; stamps the new version''s intake_link_id in the same transaction. The version is an allow-list of the route''s fields (label, key, type, size, note, name, hash; provenance external). Answers publish_revision''s result. Service role only.';

-- ── 6. A quote: the quote link's own project, a party of that project ─────
CREATE OR REPLACE FUNCTION public.intake_door_file_quote(p_token_hash text, p_quote jsonb)
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
  v_q    cost_documents%ROWTYPE;
  v_prev jsonb;
  v_id   uuid  := gen_random_uuid();
  v_rls  boolean := intake_door_rls_ready(false);
  v_role text  := current_setting('role');
BEGIN
  IF v_door->>'purpose' IS DISTINCT FROM 'quote' THEN
    RAISE EXCEPTION 'intake_door: only a quote link files a quote.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF jsonb_typeof(p_quote) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'intake_door: one quote object is required.' USING ERRCODE = '22023';
  END IF;
  v_q := jsonb_populate_record(NULL::cost_documents, p_quote);
  IF v_q.file_url IS NULL OR v_q.file_url !~ ('^orgs/' || v_org::text || '/project-costs/' || v_proj::text || '/quote-[^/]+$') THEN
    RAISE EXCEPTION 'intake_door: the file is not stored under this link''s project.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF v_q.party_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM project_parties pp WHERE pp.id = v_q.party_id AND pp.project_id = v_proj AND pp.org_id = v_org) THEN
    RAISE EXCEPTION 'intake_door: the quote''s party is not a party of this link''s project.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  v_prev := intake_door_bind(v_link, v_link, v_org, v_proj);
  -- The INSERT as intake_door, under row-level security; a privilege the
  -- role lacks here, or a policy not the door's own refusing it, runs it
  -- once more with the bound identity alone (see section 2).
  LOOP
    BEGIN
      IF v_rls THEN PERFORM set_config('role', 'intake_door', true); END IF;
      INSERT INTO cost_documents (id, org_id, project_id, kind, file_url, file_name, mime_type, vendor_name,
                                  rfq_group, intake_link_id, party_id, status, created_by, file_hash)
      VALUES (v_id, v_org, v_proj, 'quote', v_q.file_url, v_q.file_name, v_q.mime_type, v_door->>'company',
              v_door->>'rfq_group', v_link, v_q.party_id, 'draft', NULL, v_q.file_hash);
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      EXIT;
    EXCEPTION WHEN insufficient_privilege THEN
      IF v_rls THEN PERFORM set_config('role', v_role, true); END IF;
      IF NOT v_rls
         OR SQLERRM IN ('new row violates row-level security policy for table "cost_documents"',
                        'new row violates row-level security policy "cost_documents_intake_door_scope" for table "cost_documents"')
         OR NOT (SQLERRM LIKE 'permission denied%' OR SQLERRM LIKE 'new row violates row-level security policy "%') THEN
        RAISE;
      END IF;
      RAISE WARNING 'intake_door_file_quote: % — this quote is written with the bound identity alone, without row-level security (projects-tab SEC-22).', SQLERRM;
      v_rls := false;
    END;
  END LOOP;
  PERFORM intake_door_unbind(v_prev);
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.intake_door_file_quote(text, jsonb) IS
  'GAP-401 (J16): a quote link files a draft quote on its own project — vendor name, RFQ group and link from the link row, a party only of that project, the file under the project''s costs prefix — as the door''s identity (the project record rail judges it) and, where the paste could grant it, as the role intake_door under the cost_documents_intake_door_* policies. Service role only.';

-- ── 7. A redline: only on a ticket that names the link (the ticket rails' append) ─
CREATE OR REPLACE FUNCTION public.intake_door_append_redline(p_token_hash text, p_ticket uuid, p_attachment jsonb, p_history jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_door  jsonb := intake_door_resolve(p_token_hash);
  v_link  uuid  := (v_door->>'link_id')::uuid;
  v_org   uuid  := (v_door->>'org_id')::uuid;
  v_proj  uuid  := (v_door->>'project_id')::uuid;
  v_named text;
BEGIN
  IF v_door->>'purpose' = 'quote' THEN
    RAISE EXCEPTION 'intake_door: a quote link files prices, never redlines.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  SELECT t.metadata->'intake_collision'->>'intakeLinkId' INTO v_named FROM tickets t WHERE t.id = p_ticket AND t.org_id = v_org;
  IF NOT FOUND THEN
    RETURN false;   -- gone: append_ticket_redline's own answer for a ticket that is not there
  END IF;
  IF v_named IS DISTINCT FROM v_link::text THEN
    RAISE EXCEPTION 'intake_door: this ticket does not ask this link for a redline.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF COALESCE(p_attachment->>'url', '') !~ ('^orgs/' || v_org::text || '/project-intake/' || v_proj::text || '/redlines/[^/]+$') THEN
    RAISE EXCEPTION 'intake_door: the file is not stored under this link''s project.' USING ERRCODE = '42501', HINT = 'scope';
  END IF;
  IF to_regprocedure('public.append_ticket_redline(uuid, uuid, jsonb, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'intake_door_append_redline: append_ticket_redline (20261166) is not installed yet — the route takes its own redline path.'
      USING ERRCODE = '42883';
  END IF;
  -- The ticket rails' one append (20261166): `||`, never a replace; an
  -- archived ticket takes none; only the service key may call it — so the
  -- door's identity is NOT bound for this write.
  RETURN append_ticket_redline(p_ticket, v_org, p_attachment, p_history);
END;
$$;

COMMENT ON FUNCTION public.intake_door_append_redline(text, uuid, jsonb, jsonb) IS
  'GAP-401 (J16): the contractor door appends a redline only to a ticket of its org whose intake collision names its link, the file under the link''s project redlines prefix, through append_ticket_redline (20261166; 42883 until it is pasted). Service role only.';

-- ── Grants (DRLS-16): the door functions are the service role's; the helpers
--    the INVOKER door functions call, the service role's too; the policy
--    predicates intake_door's alone; the bound-link reader no role's
REVOKE ALL ON FUNCTION public.intake_door_resolve(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_bind(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_unbind(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_rls_gaps(name, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_rls_ready(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_door_resolve(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_bind(uuid, uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_unbind(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_rls_gaps(name, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_rls_ready(boolean) TO service_role;
REVOKE ALL ON FUNCTION public.intake_door_bound() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.intake_door_may_create(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.intake_door_may_quote(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_may_create(uuid, uuid, uuid, uuid, text) TO intake_door;
GRANT EXECUTE ON FUNCTION public.intake_door_may_quote(uuid, uuid, text, uuid, text, uuid, text, text, text, uuid) TO intake_door;
REVOKE ALL ON FUNCTION public.intake_door_create_document(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_submit_version(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_point_pending(text, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_promote(text, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_file_quote(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.intake_door_append_redline(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intake_door_create_document(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_submit_version(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_point_pending(text, uuid, uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_promote(text, uuid, uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_file_quote(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.intake_door_append_redline(text, uuid, jsonb, jsonb) TO service_role;

-- ── 8. INTK-16's authorship rail — 20261141 body + the J16 block ──────────
CREATE OR REPLACE FUNCTION documents_authorship_fixed()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;   -- the door and the org restore (service role), the SQL editor
  -- J16 (GAP-401, 20261184): the contractor door's own identity — bound only
  -- by the intake_door_* functions (service key only), for ONE link — records
  -- that link, and no other, as the author of the document it creates. Every
  -- rule below binds the door like any signed-in writer.
  IF TG_OP = 'INSERT'
     AND NEW.authored_by_link_id IS NOT NULL
     AND COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'intake_door'
     AND NEW.authored_by_link_id::text = auth.uid()::text
     AND NEW.authored_by_link_id::text = (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'intake_link_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.authored_by_link_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only the contractor door records that a link authored a document — a document filed here is the organization''s. Nothing was changed. INTK-16, 20261141'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.authored_by_link_id IS DISTINCT FROM OLD.authored_by_link_id THEN
    RAISE EXCEPTION 'Which contractor link authored a document is fixed when the door files it — it is not changed afterwards. Nothing was changed. INTK-16, 20261141'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION documents_authorship_fixed() IS
  'INTK-16: documents.authored_by_link_id is written only by the door at creation and by the org restore — a signed-in INSERT naming a link, or a signed-in UPDATE changing it, is refused. J16 (20261184): the door''s own identity (role intake_door, auth.uid() = the link, bound by the intake_door_* functions) may record its OWN link on the document it creates, and nothing else. The adoption guard and the door''s own-document decision read it.';

-- CREATE OR REPLACE keeps the trigger (trg_documents_authorship_fixed) and
-- the function's grants as 20261141 left them (it is SECURITY INVOKER: a
-- member's insert runs it as that member).

-- ── 9. Row-level security for the new document and the quote: TO intake_door
-- A permissive policy lets the door's role insert at all; a restrictive one
-- with the same predicate keeps every policy written for all roles from
-- widening it. Both read the BOUND link (intake_door_bound). The role has no
-- SELECT, UPDATE or DELETE on these tables, so no other command needs one.
DROP POLICY IF EXISTS documents_intake_door_insert ON documents;
CREATE POLICY documents_intake_door_insert ON documents
  AS PERMISSIVE FOR INSERT TO intake_door
  WITH CHECK (intake_door_may_create(org_id, library_id, collection_id, authored_by_link_id, status));
DROP POLICY IF EXISTS documents_intake_door_scope ON documents;
CREATE POLICY documents_intake_door_scope ON documents
  AS RESTRICTIVE FOR INSERT TO intake_door
  WITH CHECK (intake_door_may_create(org_id, library_id, collection_id, authored_by_link_id, status));

DROP POLICY IF EXISTS cost_documents_intake_door_insert ON cost_documents;
CREATE POLICY cost_documents_intake_door_insert ON cost_documents
  AS PERMISSIVE FOR INSERT TO intake_door
  WITH CHECK (intake_door_may_quote(org_id, project_id, kind, intake_link_id, file_url, party_id, vendor_name, rfq_group, status, created_by));
DROP POLICY IF EXISTS cost_documents_intake_door_scope ON cost_documents;
CREATE POLICY cost_documents_intake_door_scope ON cost_documents
  AS RESTRICTIVE FOR INSERT TO intake_door
  WITH CHECK (intake_door_may_quote(org_id, project_id, kind, intake_link_id, file_url, party_id, vendor_name, rfq_group, status, created_by));

COMMIT;

-- ── Verification + inventory — ONE result set (the editor shows only the last)
--    Expect ok = true on every probe row; inventory rows carry n only. If one
--    of the four "row-level security" rows reads false the paste still
--    applied and the door keeps the bound identity for those inserts (each
--    upload is filed as before) — send the row back (projects-tab SEC-22).
--    All four ask intake_door_rls_gaps, the function the door functions
--    decide by; the fourth reports a restrictive INSERT or ALL policy for
--    every role (or for intake_door) that the link's identity may fail, live
--    on documents or cost_documents.
--    pg_proc.prosrc is verbatim (an apostrophe in a literal is written '''');
--    pg_policies.with_check is deparsed, so it is matched on names only.
SELECT 'the six door functions exist with search_path pinned, and only the service role may EXECUTE them; the new document and the quote are SECURITY INVOKER (they switch to intake_door), the submission, the pointer, the promote and the redline SECURITY DEFINER' AS check,
       (SELECT COUNT(*) = 6
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('intake_door_create_document', 'intake_door_submit_version', 'intake_door_point_pending',
                             'intake_door_promote', 'intake_door_file_quote', 'intake_door_append_redline')
           AND p.prosecdef = (p.proname NOT IN ('intake_door_create_document', 'intake_door_file_quote'))
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
           AND has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS ok,
       NULL::text AS n
UNION ALL
SELECT 'the five helpers the door functions call (resolve, bind, unbind, rls_gaps, rls_ready) are SECURITY INVOKER and only the service role may EXECUTE them',
       (SELECT COUNT(*) = 5
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('intake_door_resolve', 'intake_door_bind', 'intake_door_unbind', 'intake_door_rls_gaps', 'intake_door_rls_ready')
           AND NOT p.prosecdef
           AND has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')),
       NULL
UNION ALL
SELECT 'the policy predicates (may_create, may_quote) are SECURITY DEFINER with search_path pinned and only intake_door may EXECUTE them; the bound-link reader no role',
       (SELECT COUNT(*) = 2
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('intake_door_may_create', 'intake_door_may_quote')
           AND p.prosecdef
           AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'search_path=public')
           AND has_function_privilege('intake_door', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       AND (SELECT p.prosecdef
                   AND NOT has_function_privilege('intake_door', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
              FROM pg_proc p WHERE p.proname = 'intake_door_bound'),
       NULL
UNION ALL
SELECT 'the role intake_door exists, cannot log in, is no superuser, cannot bypass row-level security, create roles or databases',
       EXISTS (SELECT 1 FROM pg_roles
                WHERE rolname = 'intake_door' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
                  AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication),
       NULL
UNION ALL
SELECT 'intake_door holds column INSERT on documents and cost_documents, nothing on document_versions, no SELECT, UPDATE or DELETE on the door tables, and EXECUTE by name on the helpers the policies for all roles call',
       NOT has_table_privilege('intake_door', 'public.documents', 'INSERT')
       AND has_column_privilege('intake_door', 'public.documents', 'authored_by_link_id', 'INSERT')
       AND NOT has_column_privilege('intake_door', 'public.documents', 'current_version_id', 'INSERT')
       AND has_column_privilege('intake_door', 'public.cost_documents', 'intake_link_id', 'INSERT')
       AND NOT has_column_privilege('intake_door', 'public.cost_documents', 'total_amount', 'INSERT')
       AND NOT has_any_column_privilege('intake_door', 'public.document_versions', 'INSERT')
       AND NOT has_any_column_privilege('intake_door', 'public.document_versions', 'SELECT')
       AND NOT has_any_column_privilege('intake_door', 'public.documents', 'SELECT')
       AND NOT has_any_column_privilege('intake_door', 'public.cost_documents', 'SELECT')
       AND NOT has_any_column_privilege('intake_door', 'public.documents', 'UPDATE')
       AND NOT has_any_column_privilege('intake_door', 'public.cost_documents', 'UPDATE')
       AND NOT has_table_privilege('intake_door', 'public.documents', 'DELETE')
       AND NOT has_table_privilege('intake_door', 'public.cost_documents', 'DELETE')
       AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public.my_org_ids()', 'public.is_org_controller(uuid)',
                                                  'public.acl_index_denies(jsonb, uuid, uuid, text)', 'public.user_owns_project(uuid)']) f
                        WHERE to_regprocedure(f) IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x
                                           WHERE p.oid = to_regprocedure(f) AND x.grantee = to_regrole('intake_door')
                                             AND x.privilege_type = 'EXECUTE')),
       NULL
UNION ALL
SELECT 'documents and cost_documents each carry a permissive and a restrictive INSERT policy TO intake_door, reading the bound link',
       (SELECT COUNT(*) = 4 FROM pg_policies
         WHERE schemaname = 'public' AND roles = '{intake_door}' AND cmd = 'INSERT'
           AND ((tablename = 'documents' AND with_check LIKE '%intake_door_may_create(%')
             OR (tablename = 'cost_documents' AND with_check LIKE '%intake_door_may_quote(%')))
       AND (SELECT COUNT(DISTINCT permissive) = 2 FROM pg_policies
             WHERE schemaname = 'public' AND roles = '{intake_door}' AND cmd = 'INSERT')
       AND NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = 'public' AND roles = '{intake_door}' AND cmd <> 'INSERT'),
       NULL
UNION ALL
SELECT 'row-level security for the door''s new document and quote: authenticator (the API''s login) may switch to intake_door, by the door''s own test (SET from PostgreSQL 16) — false: they keep the bound identity alone (SEC-22)',
       to_regrole('authenticator') IS NOT NULL
       AND NOT (intake_door_rls_gaps('authenticator', false) && ARRAY['role', 'switch']),
       NULL
UNION ALL
SELECT 'row-level security for a NEW document: intake_door may resolve auth.uid() in the document triggers — false: a new document keeps the bound identity alone (SEC-22)',
       NOT (intake_door_rls_gaps('authenticator', true) && ARRAY['role', 'auth usage']),
       NULL
UNION ALL
SELECT 'row-level security for both: intake_door may EXECUTE every function, and read every column, the live INSERT policies of documents and cost_documents use (and auth.uid()) — false: a write missing one keeps the bound identity alone (SEC-22)',
       NOT EXISTS (SELECT 1
                     FROM unnest(intake_door_rls_gaps('authenticator', true) || intake_door_rls_gaps('authenticator', false)) g
                    WHERE g = 'role' OR g LIKE 'execute %' OR g LIKE 'read %'),
       NULL
UNION ALL
SELECT 'row-level security for both: no restrictive INSERT or ALL policy for every role (or for intake_door) on documents or cost_documents that the link''s identity may fail, by the door''s own test (any but the two intake_door scope policies and documents_deny_upload_guard as the repository writes it, reading only libraries, auth.uid, is_org_controller and acl_index_denies) — false: one is live, and the door''s new documents or quotes keep the bound identity alone, filed as before, until it says how it treats intake_door (SEC-22)',
       NOT EXISTS (SELECT 1
                     FROM unnest(intake_door_rls_gaps('authenticator', true) || intake_door_rls_gaps('authenticator', false)) g
                    WHERE g LIKE 'policy %'),
       NULL
UNION ALL
SELECT 'every door function resolves the link from its hash; the five that write as the door bind and then restore the identity; the new document and the quote switch to intake_door and back, and a privilege the role lacks, or a policy not the door''s own, runs the INSERT again with the bound identity alone',
       (SELECT COUNT(*) = 6 FROM pg_proc
         WHERE proname IN ('intake_door_create_document', 'intake_door_submit_version', 'intake_door_point_pending',
                           'intake_door_promote', 'intake_door_file_quote', 'intake_door_append_redline')
           AND prosrc LIKE '%intake_door_resolve(p_token_hash)%')
       AND (SELECT COUNT(*) = 5 FROM pg_proc
             WHERE proname IN ('intake_door_create_document', 'intake_door_submit_version', 'intake_door_point_pending',
                               'intake_door_promote', 'intake_door_file_quote')
               AND prosrc LIKE '%v_prev := intake_door_bind(%'
               AND prosrc LIKE '%PERFORM intake_door_unbind(v_prev);%')
       AND (SELECT COUNT(*) = 2 FROM pg_proc
             WHERE proname IN ('intake_door_create_document', 'intake_door_file_quote')
               AND prosrc LIKE '%IF v_rls THEN PERFORM set_config(''role'', ''intake_door'', true); END IF;%'
               AND prosrc LIKE '%IF v_rls THEN PERFORM set_config(''role'', v_role, true); END IF;%'
               AND prosrc LIKE '%EXCEPTION WHEN insufficient_privilege THEN%'
               AND prosrc LIKE '%_intake_door_scope" for table %'
               AND prosrc LIKE '%OR NOT (SQLERRM LIKE ''permission denied\%'' OR SQLERRM LIKE ''new row violates row-level security policy "\%'') THEN%')
       AND (SELECT prosrc NOT LIKE '%intake_door_bind(%' FROM pg_proc WHERE proname = 'intake_door_append_redline'),
       NULL
UNION ALL
SELECT 'the bound identity names the role intake_door; the resolver refuses a signed-in caller and a revoked, expired or closed link',
       (SELECT prosrc LIKE '%''role'', ''intake_door''%' FROM pg_proc WHERE proname = 'intake_door_bind')
       AND (SELECT prosrc LIKE '%IF auth.uid() IS NOT NULL THEN%'
                   AND prosrc LIKE '%HINT = ''revoked''%'
                   AND prosrc LIKE '%HINT = ''expired''%'
                   AND prosrc LIKE '%HINT = ''project_closed''%'
              FROM pg_proc WHERE proname = 'intake_door_resolve'),
       NULL
UNION ALL
SELECT 'the promote binds the link''s CREATOR, publishes an allow-listed version through publish_revision, and stamps the new version''s link in the same transaction',
       (SELECT prosrc LIKE '%v_prev := intake_door_bind(v_creator::uuid, v_link, v_org, v_proj);%'
               AND prosrc LIKE '%v_res := publish_revision(%'
               AND prosrc LIKE '%p_version => jsonb_build_object(%'
               AND prosrc NOT LIKE '%p_version ||%'
               AND prosrc LIKE '%UPDATE document_versions SET intake_link_id = v_link WHERE id = v_vid AND record_id = p_doc;%'
          FROM pg_proc WHERE proname = 'intake_door_promote'),
       NULL
UNION ALL
SELECT 'INTK-16''s authorship rail admits the door''s identity for its OWN link on INSERT and keeps both 20261141 refusals',
       (SELECT prosrc LIKE '%= ''intake_door''%'
               AND prosrc LIKE '%NEW.authored_by_link_id::text = auth.uid()::text%'
               AND prosrc LIKE '%Only the contractor door records that a link authored a document%'
               AND prosrc LIKE '%is fixed when the door files it%'
          FROM pg_proc WHERE proname = 'documents_authorship_fixed'),
       NULL
UNION ALL
SELECT 'trg_documents_authorship_fixed is still bound to documents',
       EXISTS (SELECT 1 FROM pg_trigger t
                WHERE t.tgname = 'trg_documents_authorship_fixed' AND NOT t.tgisinternal
                  AND t.tgrelid = 'public.documents'::regclass),
       NULL
UNION ALL
SELECT 'this editor session carries no door identity or role after the paste (neither outlives a door function)',
       COALESCE(current_setting('request.jwt.claims', true), '') NOT LIKE '%intake_door%'
       AND current_user <> 'intake_door',
       NULL
UNION ALL
SELECT inventory, NULL::boolean, n FROM prj_g_j16_inventory;
